import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'yaml';

import type { Agent, AgentResult } from '../agents/types.js';
import { createAgent } from '../agents/index.js';
import type { Config } from '../config/schema.js';
import type { Database } from '../db/index.js';
import { getError, logActivity } from '../db/queries.js';
import type { ErrorStatus } from '../utils/errors.js';
import { UserError } from '../utils/errors.js';
import { parseDuration } from '../utils/duration.js';
import { Logger } from '../utils/logger.js';
import { generateAnalyzeContext, generateFixContext } from './context.js';
import type { AnalysisOutput, FixOutput } from './output.js';
import { parseAnalysisOutput, parseFixOutput } from './output.js';
import { runVerification, type VerificationResult } from './verifier.js';
import { acquireLock, generateLockId, releaseLock, transitionStatus } from './lock.js';

type FixOptions = {
  analyzeOnly?: boolean;
  reanalyze?: boolean;
};

export type FixResult = {
  errorId: number;
  status: ErrorStatus;
  lockAcquired: boolean;
  attempts: number;
  analysis?: AnalysisOutput;
  fix?: FixOutput;
  verification?: VerificationResult;
  message?: string;
};

type FixOrchestratorOptions = {
  agent?: Agent;
  logger?: Logger;
  terminalEnabled?: boolean;
};

type AgentOutputResult<T> =
  | { success: true; data: T; rawContent: string }
  | { success: false; diagnostic: string };

const FIXABLE_STATUSES = new Set<ErrorStatus>(['pending', 'suggested']);

const outputPathForContext = (contextPath: string): string | null => {
  if (contextPath.endsWith('-analyze.md')) {
    return contextPath.replace(/-analyze\.md$/, '-analysis.yaml');
  }
  if (contextPath.endsWith('-fix.md')) {
    return contextPath.replace(/-fix\.md$/, '-result.yaml');
  }
  return null;
};

const formatAgentDiagnostic = (
  result: AgentResult,
  expectedOutput: string
): string => {
  const lines = [
    `Agent did not produce valid output for ${expectedOutput}`,
    typeof result.exitCode === 'number' ? `Exit code: ${result.exitCode}` : '',
    result.timedOut ? 'Agent timed out' : '',
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : '',
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
  ];
  return lines.filter(Boolean).join('\n');
};

const formatParseDiagnostic = (error: unknown, rawContent: string): string => {
  const message =
    error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
  return `Failed to parse output: ${message}\nRaw content:\n${rawContent}`;
};

const analysisToYaml = (analysis: AnalysisOutput): string =>
  yaml.stringify(analysis).trimEnd();

const parseSuggestion = (value: string): AnalysisOutput => {
  const parsed = JSON.parse(value) as AnalysisOutput;
  if (
    !parsed ||
    typeof parsed.summary !== 'string' ||
    typeof parsed.root_cause !== 'string' ||
    typeof parsed.suggested_fix !== 'string' ||
    !Array.isArray(parsed.files_to_modify) ||
    typeof parsed.confidence !== 'string'
  ) {
    throw new UserError('Stored analysis output is invalid');
  }
  return parsed;
};

export class FixOrchestrator {
  private readonly db: Database;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly agent: Agent;
  private readonly terminalEnabled: boolean;

  constructor(db: Database, config: Config, options?: FixOrchestratorOptions) {
    this.db = db;
    this.config = config;
    this.terminalEnabled = options?.terminalEnabled ?? true;
    this.logger =
      options?.logger ??
      new Logger({
        rootDir: config.project.root,
        terminalEnabled: this.terminalEnabled,
      });
    this.agent =
      options?.agent ??
      createAgent(
        {
          provider: config.agent.provider,
          command: config.agent.command,
          args: config.agent.args,
          stderrIsProgress: config.agent.stderr_is_progress,
          timeout: parseDuration(config.agent.timeout),
          retries: config.agent.retries,
        },
        {
          projectRoot: config.project.root,
          logger: this.logger,
          terminalEnabled: this.terminalEnabled,
        }
      );
  }

  async fixError(errorId: number, options?: FixOptions): Promise<FixResult> {
    const initial = getError(this.db, errorId);
    if (!initial) {
      throw new UserError(`Error ${errorId} not found`);
    }

    const lockId = generateLockId();
    const lockAcquired = await acquireLock(this.db, errorId, lockId);
    if (!lockAcquired) {
      return {
        errorId,
        status: initial.status,
        lockAcquired: false,
        attempts: initial.fixAttempts,
        message: 'Lock already held',
      };
    }

    this.logger.info(`Starting fix orchestrator for error ${errorId}`);
    let lockHeld = true;
    let attempts = initial.fixAttempts;
    let analysisOutput: AnalysisOutput | undefined;
    let fixOutput: FixOutput | undefined;
    let verificationResult: VerificationResult | undefined;

    try {
      const error = getError(this.db, errorId);
      if (!error) {
        throw new UserError(`Error ${errorId} not found after locking`);
      }

      if (!FIXABLE_STATUSES.has(error.status)) {
        await releaseLock(this.db, errorId, lockId);
        lockHeld = false;
        throw new UserError(
          `Error ${errorId} is not in a fixable state (status=${error.status})`
        );
      }

      const analyzeOnly = options?.analyzeOnly ?? false;
      const reanalyze = options?.reanalyze ?? false;
      const maxAttempts = this.config.limits.max_attempts_per_error;

      const existingSuggestion = error.suggestion;
      const shouldReanalyze =
        reanalyze && error.status === 'suggested' && existingSuggestion;

      const suggestionMissing =
        error.status === 'suggested' && !existingSuggestion;

      const needsAnalysis =
        error.status === 'pending' || reanalyze || suggestionMissing;

      if (needsAnalysis) {
        const expectedStatuses: ErrorStatus[] = [];
        if (error.status === 'pending') {
          expectedStatuses.push('pending');
        }
        if (error.status === 'suggested') {
          expectedStatuses.push('suggested');
        }

        if (
          expectedStatuses.length === 0 ||
          !transitionStatus(this.db, errorId, expectedStatuses, 'analyzing', lockId)
        ) {
          throw new UserError(
            `Failed to transition error ${errorId} into analyzing status`
          );
        }

        logActivity(
          this.db,
          'analysis_start',
          errorId,
          JSON.stringify({ attempt: attempts, lockId })
        );

        this.logger.info(`Analyzing error ${errorId} (attempt ${attempts})...`);
        const context = generateAnalyzeContext(error, this.config, attempts);
        const contextPath = path.resolve(this.config.project.root, context.path);
        await fs.mkdir(path.dirname(contextPath), { recursive: true });
        await fs.writeFile(contextPath, context.content, 'utf8');

        const agentResult = await this.agent.analyze(context.path);
        const outputPath = outputPathForContext(contextPath);
        const analysisResult = await this.processAgentOutput(
          agentResult,
          outputPath,
          parseAnalysisOutput
        );

        if (analysisResult.success) {
          analysisOutput = analysisResult.data;

          if (
            !transitionStatus(this.db, errorId, 'analyzing', 'suggested', lockId)
          ) {
            throw new UserError(
              `Failed to transition error ${errorId} into suggested status`
            );
          }

          this.db.run(
            'UPDATE errors SET suggestion = ?, updated_at = ? WHERE id = ?',
            [
              JSON.stringify(analysisOutput),
              new Date().toISOString(),
              errorId,
            ]
          );

          logActivity(
            this.db,
            'analysis_complete',
            errorId,
            JSON.stringify({
              attempt: attempts,
              confidence: analysisOutput.confidence,
            })
          );

          if (analyzeOnly) {
            await releaseLock(this.db, errorId, lockId);
            lockHeld = false;
            return {
              errorId,
              status: 'suggested',
              lockAcquired: true,
              attempts,
              analysis: analysisOutput,
              message: 'Analysis complete (analyze-only)',
            };
          }
        } else {
          logActivity(
            this.db,
            agentResult.timedOut ? 'analysis_timeout' : 'analysis_failed',
            errorId,
            JSON.stringify({ attempt: attempts, diagnostic: analysisResult.diagnostic })
          );

          if (shouldReanalyze) {
            if (
              !transitionStatus(this.db, errorId, 'analyzing', 'suggested', lockId)
            ) {
              throw new UserError(
                `Failed to transition error ${errorId} back to suggested status`
              );
            }
            await releaseLock(this.db, errorId, lockId);
            lockHeld = false;
            return {
              errorId,
              status: 'suggested',
              lockAcquired: true,
              attempts,
              message: 'Re-analysis failed; existing analysis preserved',
            };
          }

          const newAttempts = attempts + 1;
          attempts = newAttempts;

          const nextStatus: ErrorStatus =
            newAttempts >= maxAttempts ? 'failed' : 'pending';

          if (
            !transitionStatus(this.db, errorId, 'analyzing', nextStatus, lockId)
          ) {
            throw new UserError(
              `Failed to transition error ${errorId} after analysis failure`
            );
          }
          this.db.run(
            'UPDATE errors SET suggestion = ?, fix_attempts = ?, updated_at = ? WHERE id = ?',
            [
              JSON.stringify({ error: true, diagnostic: analysisResult.diagnostic }),
              newAttempts,
              new Date().toISOString(),
              errorId,
            ]
          );

          await releaseLock(this.db, errorId, lockId);
          lockHeld = false;

          return {
            errorId,
            status: nextStatus,
            lockAcquired: true,
            attempts,
            message: 'Analysis failed',
          };
        }
      } else if (analyzeOnly) {
        if (!error.suggestion) {
          throw new UserError(`Error ${errorId} has no stored analysis`);
        }
        analysisOutput = parseSuggestion(error.suggestion);
        await releaseLock(this.db, errorId, lockId);
        lockHeld = false;
        return {
          errorId,
          status: 'suggested',
          lockAcquired: true,
          attempts,
          analysis: analysisOutput,
          message: 'Already analyzed (analyze-only)',
        };
      } else {
        if (!error.suggestion) {
          throw new UserError(`Error ${errorId} has no stored analysis`);
        }
        analysisOutput = parseSuggestion(error.suggestion);
      }

      if (!analysisOutput) {
        throw new UserError('Missing analysis output for fix phase');
      }

      if (!transitionStatus(this.db, errorId, 'suggested', 'fixing', lockId)) {
        throw new UserError(
          `Failed to transition error ${errorId} into fixing status`
        );
      }

      logActivity(
        this.db,
        'fix_start',
        errorId,
        JSON.stringify({ attempt: attempts, lockId })
      );

      this.logger.info(`Applying fix for error ${errorId} (attempt ${attempts})...`);
      const analysisYaml = analysisToYaml(analysisOutput);
      const fixContext = generateFixContext(
        error,
        analysisYaml,
        this.config,
        attempts
      );
      const fixContextPath = path.resolve(
        this.config.project.root,
        fixContext.path
      );
      await fs.mkdir(path.dirname(fixContextPath), { recursive: true });
      await fs.writeFile(fixContextPath, fixContext.content, 'utf8');

      const fixAgentResult = await this.agent.fix(fixContext.path);
      const fixOutputPath = outputPathForContext(fixContextPath);
      const fixResult = await this.processAgentOutput(
        fixAgentResult,
        fixOutputPath,
        parseFixOutput
      );

      if (fixResult.success) {
        fixOutput = fixResult.data;
        this.db.run(
          'UPDATE errors SET fix_result = ?, updated_at = ? WHERE id = ?',
          [
            JSON.stringify(fixOutput),
            new Date().toISOString(),
            errorId,
          ]
        );
        if (fixOutput.success) {
          logActivity(
            this.db,
            'fix_complete',
            errorId,
            JSON.stringify({ attempt: attempts })
          );
        } else {
          logActivity(
            this.db,
            'fix_failed',
            errorId,
            JSON.stringify({
              attempt: attempts,
              summary: fixOutput.summary,
              notes: fixOutput.notes ?? '',
            })
          );
        }

        if (!fixOutput.success) {
          const newAttempts = attempts + 1;
          attempts = newAttempts;

          const nextStatus: ErrorStatus =
            newAttempts >= maxAttempts ? 'failed' : 'pending';
          if (!transitionStatus(this.db, errorId, 'fixing', nextStatus, lockId)) {
            throw new UserError(
              `Failed to transition error ${errorId} after fix failure`
            );
          }
          this.db.run(
            'UPDATE errors SET fix_attempts = ?, updated_at = ? WHERE id = ?',
            [newAttempts, new Date().toISOString(), errorId]
          );

          await releaseLock(this.db, errorId, lockId);
          lockHeld = false;

          return {
            errorId,
            status: nextStatus,
            lockAcquired: true,
            attempts,
            analysis: analysisOutput,
            fix: fixOutput,
            message: 'Fix reported failure',
          };
        }
      } else {
        logActivity(
          this.db,
          fixAgentResult.timedOut ? 'fix_timeout' : 'fix_failed',
          errorId,
          JSON.stringify({ attempt: attempts, diagnostic: fixResult.diagnostic })
        );

        const newAttempts = attempts + 1;
        attempts = newAttempts;

        const nextStatus: ErrorStatus =
          newAttempts >= maxAttempts ? 'failed' : 'pending';

        if (!transitionStatus(this.db, errorId, 'fixing', nextStatus, lockId)) {
          throw new UserError(
            `Failed to transition error ${errorId} after fix failure`
          );
        }
        this.db.run(
          'UPDATE errors SET fix_result = ?, fix_attempts = ?, updated_at = ? WHERE id = ?',
          [
            JSON.stringify({ error: true, diagnostic: fixResult.diagnostic }),
            newAttempts,
            new Date().toISOString(),
            errorId,
          ]
        );

        await releaseLock(this.db, errorId, lockId);
        lockHeld = false;

        return {
          errorId,
          status: nextStatus,
          lockAcquired: true,
          attempts,
          analysis: analysisOutput,
          message: 'Fix failed',
        };
      }

      logActivity(
        this.db,
        'verification_start',
        errorId,
        JSON.stringify({ attempt: attempts })
      );

      this.logger.info(`Verifying fix for error ${errorId}...`);
      verificationResult = await runVerification(this.config, {
        logger: this.logger,
        terminalEnabled: this.terminalEnabled,
      });

      if (verificationResult.success) {
        if (!transitionStatus(this.db, errorId, 'fixing', 'fixed', lockId)) {
          throw new UserError(
            `Failed to transition error ${errorId} into fixed status`
          );
        }
        logActivity(
          this.db,
          'verification_pass',
          errorId,
          JSON.stringify({ attempt: attempts })
        );

        await releaseLock(this.db, errorId, lockId);
        lockHeld = false;

        return {
          errorId,
          status: 'fixed',
          lockAcquired: true,
          attempts,
          analysis: analysisOutput,
          fix: fixOutput,
          verification: verificationResult,
          message: 'Fix verified',
        };
      }

      const newAttempts = attempts + 1;
      attempts = newAttempts;
      const nextStatus: ErrorStatus =
        newAttempts >= maxAttempts ? 'failed' : 'pending';

      if (!transitionStatus(this.db, errorId, 'fixing', nextStatus, lockId)) {
        throw new UserError(
          `Failed to transition error ${errorId} after verification failure`
        );
      }
      this.db.run(
        'UPDATE errors SET fix_attempts = ?, updated_at = ? WHERE id = ?',
        [newAttempts, new Date().toISOString(), errorId]
      );

      logActivity(
        this.db,
        'verification_fail',
        errorId,
        JSON.stringify({ attempt: attempts, failure: verificationResult.failure })
      );

      await releaseLock(this.db, errorId, lockId);
      lockHeld = false;

      return {
        errorId,
        status: nextStatus,
        lockAcquired: true,
        attempts,
        analysis: analysisOutput,
        fix: fixOutput,
        verification: verificationResult,
        message: 'Verification failed',
      };
    } finally {
      if (lockHeld) {
        await releaseLock(this.db, errorId, lockId);
      }
    }
  }

  private async processAgentOutput<T>(
    result: AgentResult,
    outputPath: string | null,
    parser: (content: string) => T
  ): Promise<AgentOutputResult<T>> {
    if (!result.success) {
      const diagnostic = formatAgentDiagnostic(
        result,
        outputPath ?? 'output file'
      );
      return { success: false, diagnostic };
    }

    if (!outputPath) {
      return {
        success: false,
        diagnostic: 'Unable to determine expected output path',
      };
    }

    if (!result.outputFileExists) {
      return {
        success: false,
        diagnostic: formatAgentDiagnostic(result, outputPath),
      };
    }

    let content = '';
    try {
      content = await fs.readFile(outputPath, 'utf8');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        diagnostic: `Failed to read output file ${outputPath}: ${message}`,
      };
    }

    try {
      const data = parser(content);
      return { success: true, data, rawContent: content };
    } catch (error) {
      return {
        success: false,
        diagnostic: formatParseDiagnostic(error, content),
      };
    }
  }
}

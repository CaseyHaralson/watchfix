import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { loadConfig } from '../../config/loader.js';
import { Database } from '../../db/index.js';
import { getError, getErrorsByStatus, type ErrorRecord } from '../../db/queries.js';
import { checkSchemaVersion, initializeSchema } from '../../db/schema.js';
import { FixOrchestrator, type FixResult } from '../../fixer/index.js';
import type { AnalysisOutput, FixOutput } from '../../fixer/output.js';
import type { VerificationResult } from '../../fixer/verifier.js';
import { EXIT_CODES, type ErrorStatus, UserError } from '../../utils/errors.js';
import { Logger, type Verbosity } from '../../utils/logger.js';
import { isOurProcess } from '../../utils/process.js';

type FixOptions = {
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
  all?: boolean;
  yes?: boolean;
  analyzeOnly?: boolean;
  reanalyze?: boolean;
  confirmEach?: boolean;
};

type WatcherStateRow = {
  pid: number;
  started_at: string;
  autonomous: number;
  project_root: string;
  command_line: string;
};

type FixOutcome = 'fixed' | 'failed' | 'skipped' | 'analysis' | 'resolved';

const FIXABLE_STATUSES: ErrorStatus[] = ['pending', 'suggested'];

const buildDatabasePath = (rootDir: string): string =>
  path.join(rootDir, '.watchfix', 'errors.db');

const resolveVerbosity = (options: FixOptions): Verbosity => {
  if (options.quiet) {
    return 'quiet';
  }
  if (options.verbose) {
    return 'verbose';
  }
  return 'normal';
};

const getWatcherState = (db: Database): WatcherStateRow | undefined =>
  db.get<WatcherStateRow>(
    'SELECT pid, started_at, autonomous, project_root, command_line FROM watcher_state WHERE id = 1'
  );

const clearWatcherState = (db: Database): void => {
  db.run('DELETE FROM watcher_state WHERE id = 1');
};

const parsePositiveInt = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UserError('Error id must be a positive integer.');
  }
  return parsed;
};

const parseStoredAnalysis = (value: string | null): AnalysisOutput | null => {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as AnalysisOutput;
    if (
      !parsed ||
      typeof parsed.summary !== 'string' ||
      typeof parsed.confidence !== 'string'
    ) {
      return null;
    }
    // For already_fixed analyses, root_cause/suggested_fix/files_to_modify may be empty
    if (parsed.already_fixed === true) {
      return {
        already_fixed: true,
        summary: parsed.summary,
        root_cause: parsed.root_cause ?? '',
        suggested_fix: parsed.suggested_fix ?? '',
        files_to_modify: parsed.files_to_modify ?? [],
        confidence: parsed.confidence,
      };
    }
    // For regular analyses, ensure all fields are present
    if (
      typeof parsed.root_cause !== 'string' ||
      typeof parsed.suggested_fix !== 'string' ||
      !Array.isArray(parsed.files_to_modify)
    ) {
      return null;
    }
    return {
      already_fixed: parsed.already_fixed ?? false,
      summary: parsed.summary,
      root_cause: parsed.root_cause,
      suggested_fix: parsed.suggested_fix,
      files_to_modify: parsed.files_to_modify,
      confidence: parsed.confidence,
    };
  } catch {
    return null;
  }
};

const formatAnalysisSummary = (analysis: AnalysisOutput): string[] => {
  const lines = ['Analysis summary:'];
  lines.push(`  Summary: ${analysis.summary}`);
  if (analysis.already_fixed) {
    lines.push('  Status: Issue already fixed (no action needed)');
    lines.push(`  Confidence: ${analysis.confidence}`);
    return lines;
  }
  lines.push('  Root cause:');
  lines.push(...analysis.root_cause.split('\n').map((line) => `    ${line}`));
  lines.push('  Suggested fix:');
  lines.push(
    ...analysis.suggested_fix.split('\n').map((line) => `    ${line}`)
  );
  lines.push('  Files to modify:');
  if (analysis.files_to_modify.length === 0) {
    lines.push('    (none)');
  } else {
    for (const file of analysis.files_to_modify) {
      lines.push(`    - ${file}`);
    }
  }
  lines.push(`  Confidence: ${analysis.confidence}`);
  return lines;
};

const promptForConfirmation = async (label: string): Promise<boolean> => {
  if (!process.stdin.isTTY) {
    throw new UserError(
      'Cannot prompt for confirmation in non-interactive mode. Use --yes to proceed.'
    );
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`${label} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
};

const formatFilesChanged = (
  files: FixOutput['files_changed'],
  indent = '  '
): string[] => {
  if (!files || files.length === 0) {
    return [`${indent}(no files changed)`];
  }
  return files.map((f) => `${indent}- ${f.path}: ${f.change}`);
};

const formatVerificationSummary = (
  result: VerificationResult | undefined,
  verbosity: Verbosity
): string[] => {
  if (!result) {
    return ['  Verification: not run'];
  }
  if (result.success) {
    return ['  Verification: PASSED'];
  }

  const lines = ['  Verification: FAILED'];
  if (result.failure) {
    lines.push(`    ${result.failure.message}`);
    if (verbosity === 'verbose' && result.failure.type === 'command') {
      const stdout = result.failure.stdout.trim();
      const stderr = result.failure.stderr.trim();
      if (stdout) {
        lines.push('    stdout:');
        lines.push(...stdout.split('\n').map((line) => `      ${line}`));
      }
      if (stderr) {
        lines.push('    stderr:');
        lines.push(...stderr.split('\n').map((line) => `      ${line}`));
      }
    }
  }
  return lines;
};

const formatStatusLine = (result: FixResult, maxAttempts: number): string => {
  if (result.status === 'fixed') {
    return 'Status: fixed';
  }
  if (result.status === 'resolved') {
    return 'Status: resolved (issue already fixed)';
  }
  const retryInfo =
    result.attempts < maxAttempts ? ', will retry' : ', max attempts reached';
  return `Status: ${result.status} (attempt ${result.attempts + 1} of ${maxAttempts}${retryInfo})`;
};

const formatFixOutcome = (
  result: FixResult,
  verbosity: Verbosity,
  maxAttempts: number
): string[] => {
  if (verbosity === 'quiet') {
    if (result.status === 'fixed') {
      return [`Error #${result.errorId}: fixed`];
    }
    if (result.status === 'resolved') {
      return [`Error #${result.errorId}: resolved (already fixed)`];
    }
    const mode = result.fix?.success ? 'verification' : 'agent';
    return [`Error #${result.errorId}: failed (${mode})`];
  }

  const lines: string[] = [];

  // Header
  if (result.status === 'fixed') {
    lines.push(`Error #${result.errorId}: Fix verified successfully`);
  } else if (result.status === 'resolved') {
    lines.push(`Error #${result.errorId}: Issue already fixed`);
  } else if (!result.fix?.success) {
    lines.push(`Error #${result.errorId}: Agent could not apply fix`);
    if (result.diagnostic) {
      // Extract key info from diagnostic
      const diagLines = result.diagnostic.split('\n');
      const reason = diagLines.find(l => l.includes('timed out') || l.includes('Exit code'));
      if (reason) {
        lines.push(`  Reason: ${reason.trim()}`);
      }
    }
  } else {
    lines.push(`Error #${result.errorId}: Fix attempt completed`);
  }

  // Agent details
  if (result.fix) {
    lines.push(`  Agent applied fix: ${result.fix.success ? 'yes' : 'no'}`);
    if (result.fix.files_changed?.length) {
      lines.push('  Files changed:');
      lines.push(...formatFilesChanged(result.fix.files_changed, '    '));
    }
    if (result.fix.notes && (verbosity === 'verbose' || !result.fix.success)) {
      lines.push(`  Agent notes: ${result.fix.notes}`);
    }
  }

  // Verification
  if (result.verification) {
    lines.push(...formatVerificationSummary(result.verification, verbosity));
  }

  lines.push('');
  lines.push(formatStatusLine(result, maxAttempts));
  return lines;
};

const checkDaemonConflict = (db: Database, logger: Logger): boolean => {
  const state = getWatcherState(db);
  if (!state) {
    return true;
  }

  if (!isOurProcess(state.pid, state.project_root)) {
    clearWatcherState(db);
    return true;
  }

  if (state.autonomous) {
    const message =
      'Cannot run manual fix while daemon is in autonomous mode.\n' +
      'The daemon will automatically fix errors.\n' +
      "Run 'watchfix stop' first if you want manual control.";
    console.error(message);
    process.exitCode = EXIT_CODES.WATCHER_CONFLICT;
    return false;
  }

  logger.debug('Daemon running in manual mode, proceeding with fix');
  return true;
};

const ensureFixable = (error: ErrorRecord): string | null => {
  if (FIXABLE_STATUSES.includes(error.status)) {
    return null;
  }
  if (error.status === 'analyzing' || error.status === 'fixing') {
    return `Error #${error.id} is currently ${error.status}.`;
  }
  return `Error #${error.id} is not in a fixable state (status=${error.status}).`;
};

const reportAnalysis = (
  errorId: number,
  analysis: AnalysisOutput | null,
  note?: string
): void => {
  if (note) {
    process.stdout.write(`${note}\n`);
  }
  if (!analysis) {
    process.stdout.write(`No analysis available for error #${errorId}.\n`);
    return;
  }
  const lines = [`Error #${errorId}`, ...formatAnalysisSummary(analysis)];
  process.stdout.write(`${lines.join('\n')}\n`);
};

const reportAnalysisFromResult = (
  db: Database,
  errorId: number,
  result: FixResult,
  note?: string
): void => {
  const analysis =
    result.analysis ??
    parseStoredAnalysis(getError(db, errorId)?.suggestion ?? null);
  reportAnalysis(errorId, analysis, note);
};

const reportFixResult = (
  result: FixResult,
  verbosity: Verbosity = 'normal',
  maxAttempts = 3
): FixOutcome => {
  if (!result.lockAcquired) {
    process.stdout.write(
      `Skipped error #${result.errorId}: already locked by another process.\n`
    );
    return 'skipped';
  }

  const lines = formatFixOutcome(result, verbosity, maxAttempts);
  process.stdout.write(`${lines.join('\n')}\n`);

  if (result.status === 'fixed') {
    return 'fixed';
  }
  if (result.status === 'resolved') {
    return 'resolved';
  }
  return 'failed';
};

type FixContext = {
  verbosity: Verbosity;
  maxAttempts: number;
};

const runSingleFix = async (
  db: Database,
  error: ErrorRecord,
  options: FixOptions,
  orchestrator: FixOrchestrator,
  ctx: FixContext
): Promise<FixOutcome> => {
  const { verbosity, maxAttempts } = ctx;
  const reanalyze = Boolean(options.reanalyze);
  const analyzeOnly = Boolean(options.analyzeOnly);
  const shouldPrompt = !options.yes && !analyzeOnly;
  let reanalyzeForFix = reanalyze;

  if (analyzeOnly) {
    const result = await orchestrator.fixError(error.id, {
      analyzeOnly: true,
      reanalyze,
    });
    if (!result.lockAcquired) {
      process.exitCode = EXIT_CODES.NOT_ACTIONABLE;
      return reportFixResult(result, verbosity, maxAttempts);
    }
    if (result.status !== 'suggested') {
      process.exitCode = EXIT_CODES.GENERAL_ERROR;
      reportFixResult(result, verbosity, maxAttempts);
      return 'failed';
    }
    reportAnalysis(
      error.id,
      result.analysis ??
        parseStoredAnalysis(getError(db, error.id)?.suggestion ?? null),
      result.message
    );
    return 'analysis';
  }

  if (shouldPrompt) {
    let analysis = parseStoredAnalysis(error.suggestion);
    let analysisNote: string | undefined;

    if (error.status === 'pending' || reanalyze) {
      const analysisResult = await orchestrator.fixError(error.id, {
        analyzeOnly: true,
        reanalyze,
      });

      if (!analysisResult.lockAcquired) {
        process.exitCode = EXIT_CODES.NOT_ACTIONABLE;
        return reportFixResult(analysisResult, verbosity, maxAttempts);
      }

      analysisNote = analysisResult.message;
      analysis =
        analysisResult.analysis ??
        parseStoredAnalysis(getError(db, error.id)?.suggestion ?? null);

      if (analysisResult.status !== 'suggested') {
        process.exitCode = EXIT_CODES.GENERAL_ERROR;
        return reportFixResult(analysisResult, verbosity, maxAttempts);
      }

      reanalyzeForFix = false;
    }

    if (analysis) {
      reportAnalysis(error.id, analysis, analysisNote);
    } else if (analysisNote) {
      process.stdout.write(`${analysisNote}\n`);
    }

    const confirmed = await promptForConfirmation(
      `Apply fix for error #${error.id}?`
    );
    if (!confirmed) {
      process.stdout.write(`Skipped error #${error.id}.\n`);
      return 'skipped';
    }
  }

  const result = await orchestrator.fixError(error.id, {
    reanalyze: reanalyzeForFix,
  });
  if (!result.lockAcquired) {
    process.exitCode = EXIT_CODES.NOT_ACTIONABLE;
    return reportFixResult(result, verbosity, maxAttempts);
  }

  reportAnalysisFromResult(db, error.id, result);

  if (result.status !== 'fixed' && result.status !== 'resolved') {
    process.exitCode = EXIT_CODES.GENERAL_ERROR;
  }
  return reportFixResult(result, verbosity, maxAttempts);
};

const runAllFixes = async (
  db: Database,
  options: FixOptions,
  orchestrator: FixOrchestrator,
  ctx: FixContext
): Promise<void> => {
  const { verbosity, maxAttempts } = ctx;
  const errors = getErrorsByStatus(db, FIXABLE_STATUSES);
  if (errors.length === 0) {
    process.stdout.write('No pending or suggested errors to fix.\n');
    return;
  }

  const analyzeOnly = Boolean(options.analyzeOnly);
  const reanalyze = Boolean(options.reanalyze);
  const confirmEach = Boolean(options.confirmEach) && !analyzeOnly;

  let fixedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let analyzedCount = 0;
  let resolvedCount = 0;

  for (const error of errors) {
    const fixabilityIssue = ensureFixable(error);
    if (fixabilityIssue) {
      process.stdout.write(`${fixabilityIssue} Skipping.\n`);
      skippedCount += 1;
      continue;
    }

    if (analyzeOnly) {
      const result = await orchestrator.fixError(error.id, {
        analyzeOnly: true,
        reanalyze,
      });
      if (!result.lockAcquired) {
        skippedCount += 1;
        reportFixResult(result, verbosity, maxAttempts);
        continue;
      }
      if (result.status === 'resolved') {
        resolvedCount += 1;
        reportFixResult(result, verbosity, maxAttempts);
        continue;
      }
      if (result.status !== 'suggested') {
        failedCount += 1;
        reportFixResult(result, verbosity, maxAttempts);
        continue;
      }
      reportAnalysis(
        error.id,
        result.analysis ?? parseStoredAnalysis(getError(db, error.id)?.suggestion ?? null),
        result.message
      );
      analyzedCount += 1;
      continue;
    }

    if (confirmEach) {
      let analysis = parseStoredAnalysis(error.suggestion);
      let note: string | undefined;
      let reanalyzeForFix = reanalyze;

      if (error.status === 'pending' || reanalyze) {
        const analysisResult = await orchestrator.fixError(error.id, {
          analyzeOnly: true,
          reanalyze,
        });
        if (!analysisResult.lockAcquired) {
          skippedCount += 1;
          reportFixResult(analysisResult, verbosity, maxAttempts);
          continue;
        }
        note = analysisResult.message;
        analysis =
          analysisResult.analysis ??
          parseStoredAnalysis(getError(db, error.id)?.suggestion ?? null);
        if (analysisResult.status === 'resolved') {
          resolvedCount += 1;
          reportFixResult(analysisResult, verbosity, maxAttempts);
          continue;
        }
        if (analysisResult.status !== 'suggested') {
          failedCount += 1;
          reportFixResult(analysisResult, verbosity, maxAttempts);
          continue;
        }
        reanalyzeForFix = false;
      }

      if (analysis) {
        reportAnalysis(error.id, analysis, note);
      } else if (note) {
        process.stdout.write(`${note}\n`);
      }

      const confirmed = await promptForConfirmation(
        `Apply fix for error #${error.id}?`
      );
      if (!confirmed) {
        process.stdout.write(`Skipped error #${error.id}.\n`);
        skippedCount += 1;
        continue;
      }

      const result = await orchestrator.fixError(error.id, {
        reanalyze: reanalyzeForFix,
      });
      if (!result.lockAcquired) {
        skippedCount += 1;
        reportFixResult(result, verbosity, maxAttempts);
        continue;
      }
      if (result.status === 'fixed') {
        fixedCount += 1;
      } else if (result.status === 'resolved') {
        resolvedCount += 1;
      } else {
        failedCount += 1;
      }
      reportFixResult(result, verbosity, maxAttempts);
      continue;
    }

    const result = await orchestrator.fixError(error.id, { reanalyze });
    if (!result.lockAcquired) {
      skippedCount += 1;
      reportFixResult(result, verbosity, maxAttempts);
      continue;
    }

    reportAnalysisFromResult(db, error.id, result);

    if (result.status === 'fixed') {
      fixedCount += 1;
    } else if (result.status === 'resolved') {
      resolvedCount += 1;
    } else {
      failedCount += 1;
    }
    reportFixResult(result, verbosity, maxAttempts);
  }

  const resolvedSuffix = resolvedCount > 0 ? `, resolved ${resolvedCount}` : '';
  const summary = analyzeOnly
    ? `Analyzed ${analyzedCount} errors, failed ${failedCount}, skipped ${skippedCount}${resolvedSuffix}.`
    : `Summary: fixed ${fixedCount}, failed ${failedCount}, skipped ${skippedCount}${resolvedSuffix}.`;
  process.stdout.write(`${summary}\n`);

  if (!analyzeOnly && failedCount > 0) {
    process.exitCode = EXIT_CODES.GENERAL_ERROR;
  }
};

export const fixCommand = async (
  id: string | undefined,
  options: FixOptions
): Promise<void> => {
  if (options.all && id) {
    throw new UserError('Specify either an error id or --all, not both.');
  }
  if (!options.all && !id) {
    throw new UserError('Error id is required unless --all is specified.');
  }

  const config = loadConfig(options.config);
  const verbosity = resolveVerbosity(options);
  const logger = new Logger({
    rootDir: config.project.root,
    terminalEnabled: true,
    verbosity,
  });

  const dbPath = buildDatabasePath(config.project.root);
  if (!fs.existsSync(dbPath)) {
    throw new UserError(
      `No database found at ${dbPath}. Run watchfix watch to create it.`
    );
  }

  const db = new Database(dbPath);
  try {
    initializeSchema(db);
    checkSchemaVersion(db);

    if (!checkDaemonConflict(db, logger)) {
      return;
    }

    const orchestrator = new FixOrchestrator(db, config, {
      logger,
      terminalEnabled: true,
    });

    const ctx: FixContext = {
      verbosity,
      maxAttempts: config.limits.max_attempts_per_error,
    };

    if (options.all) {
      await runAllFixes(db, options, orchestrator, ctx);
      return;
    }

    const errorId = parsePositiveInt(id as string);
    const error = getError(db, errorId);
    if (!error) {
      console.error(`Error #${errorId} not found.`);
      process.exitCode = EXIT_CODES.NOT_ACTIONABLE;
      return;
    }

    const fixabilityIssue = ensureFixable(error);
    if (fixabilityIssue) {
      console.error(fixabilityIssue);
      process.exitCode = EXIT_CODES.NOT_ACTIONABLE;
      return;
    }

    await runSingleFix(db, error, options, orchestrator, ctx);
  } finally {
    db.close();
  }
};

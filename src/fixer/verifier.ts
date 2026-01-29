import type { SpawnResult } from '../utils/process.js';
import type { Config } from '../config/schema.js';
import { parseDuration, formatDuration } from '../utils/duration.js';
import { checkHealth, type HealthCheckResult } from '../utils/http.js';
import { Logger } from '../utils/logger.js';
import { spawnWithTimeout } from '../utils/process.js';

type VerificationCommandResult = {
  command: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

type VerificationHealthCheckResult = {
  url: string;
  success: boolean;
  status?: number;
  error?: string;
};

type VerificationFailure =
  | {
      type: 'command';
      command: string;
      message: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
    }
  | {
      type: 'health_check';
      url: string;
      message: string;
      status?: number;
      error?: string;
    };

export type VerificationResult = {
  success: boolean;
  commandResults: VerificationCommandResult[];
  healthCheckResults: VerificationHealthCheckResult[];
  failure?: VerificationFailure;
};

type RunVerificationOptions = {
  logger?: Logger;
  terminalEnabled?: boolean;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

const formatCommandFailureMessage = (
  command: string,
  result: SpawnResult,
  timeoutMs: number
): string => {
  if (result.timedOut) {
    return `Command timed out after ${formatDuration(timeoutMs)}: ${command}`;
  }
  if (result.exitCode !== 0) {
    return `Command exited with code ${result.exitCode}: ${command}`;
  }
  return `Command failed: ${command}`;
};

const logCommandOutput = (
  logger: Logger,
  command: string,
  result: SpawnResult,
  level: 'debug' | 'info' | 'warn' = 'debug'
): void => {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  const log = (message: string): void => {
    if (level === 'info') {
      logger.info(message);
    } else if (level === 'warn') {
      logger.warn(message);
    } else {
      logger.debug(message);
    }
  };

  if (stdout) {
    log(`Command stdout (${command}):\n${stdout}`);
  }
  if (stderr) {
    logger.warn(`Command stderr (${command}):\n${stderr}`);
  }
};

const logHealthCheckFailure = (
  logger: Logger,
  url: string,
  result: HealthCheckResult
): string => {
  if (result.error) {
    const message = `Health check failed for ${url}: ${result.error}`;
    logger.error(message);
    return message;
  }
  if (typeof result.status === 'number') {
    const message = `Health check failed for ${url}: status ${result.status}`;
    logger.error(message);
    return message;
  }
  const message = `Health check failed for ${url}`;
  logger.error(message);
  return message;
};

export async function runVerification(
  config: Config,
  options?: RunVerificationOptions
): Promise<VerificationResult> {
  const logger =
    options?.logger ??
    new Logger({
      rootDir: config.project.root,
      terminalEnabled: options?.terminalEnabled ?? true,
    });
  const sleep = options?.sleep ?? defaultSleep;

  const verification = config.verification;
  const waitMs = parseDuration(verification.wait_after_fix);
  if (waitMs > 0) {
    logger.info(`Waiting ${formatDuration(waitMs)} before verification`);
    await sleep(waitMs);
  }

  const commandResults: VerificationCommandResult[] = [];
  const healthCheckResults: VerificationHealthCheckResult[] = [];

  const commands = verification.test_commands ?? [];
  if (commands.length > 0) {
    const timeoutMs = parseDuration(verification.test_command_timeout);

    for (const command of commands) {
      logger.info(`Running verification command: ${command}`);
      const result = await spawnWithTimeout(
        command,
        [],
        { cwd: config.project.root, shell: true },
        timeoutMs
      );

      const commandResult: VerificationCommandResult = {
        command,
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      };
      commandResults.push(commandResult);

      if (!result.success) {
        const message = formatCommandFailureMessage(command, result, timeoutMs);
        logger.error(message);
        logCommandOutput(logger, command, result, 'info');
        return {
          success: false,
          commandResults,
          healthCheckResults,
          failure: {
            type: 'command',
            command,
            message,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          },
        };
      }

      logCommandOutput(logger, command, result);
    }
  }

  const healthChecks = verification.health_checks ?? [];
  if (healthChecks.length > 0) {
    const timeoutMs = parseDuration(verification.health_check_timeout);

    for (const url of healthChecks) {
      logger.info(`Running health check: ${url}`);
      const result = await checkHealth(url, timeoutMs);
      healthCheckResults.push({ url, ...result });

      if (!result.success) {
        const message = logHealthCheckFailure(logger, url, result);
        return {
          success: false,
          commandResults,
          healthCheckResults,
          failure: {
            type: 'health_check',
            url,
            message,
            status: result.status,
            error: result.error,
          },
        };
      }
    }
  }

  logger.info('Verification succeeded');
  return {
    success: true,
    commandResults,
    healthCheckResults,
  };
}

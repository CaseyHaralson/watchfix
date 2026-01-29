import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';

export interface CliCheckResult {
  exists: boolean;
  version?: string;
  error?: string;
}

export interface SpawnResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const CLI_CHECK_TIMEOUT_MS = 5000;
const KILL_GRACE_PERIOD_MS = 5000;

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function formatSpawnFailure(command: string, stderr: string, status: number): string {
  const trimmed = stderr.trim();
  if (trimmed) {
    return trimmed;
  }
  return `'${command}' exited with code ${status}`;
}

export function checkCliExists(command: string): CliCheckResult {
  try {
    const result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: CLI_CHECK_TIMEOUT_MS,
      shell: process.platform === 'win32',
    });

    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { exists: false, error: `'${command}' not found in PATH` };
      }
      return { exists: false, error: result.error.message };
    }

    if (typeof result.status === 'number' && result.status !== 0) {
      return {
        exists: false,
        error: formatSpawnFailure(command, result.stderr ?? '', result.status),
      };
    }

    const stdout = result.stdout ?? '';
    const version = firstLine(stdout);
    return version
      ? { exists: true, version }
      : { exists: true, version: firstLine(result.stderr ?? '') };
  } catch (error) {
    if (error instanceof Error) {
      return { exists: false, error: error.message };
    }
    return { exists: false, error: 'Unknown error' };
  }
}

export async function spawnWithTimeout(
  command: string,
  args: string[],
  options: SpawnOptions = {},
  timeoutMs: number,
): Promise<SpawnResult> {
  return await new Promise<SpawnResult>((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;

    const finalize = (result: SpawnResult): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');

      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_PERIOD_MS);

      child.once('close', () => clearTimeout(killTimer));
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdout += String(data);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderr += String(data);
      });
    }

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      finalize({
        success: code === 0 && !timedOut,
        stdout,
        stderr,
        exitCode: code ?? -1,
        timedOut,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timeoutId);
      finalize({
        success: false,
        stdout,
        stderr: error.message,
        exitCode: -1,
        timedOut: false,
      });
    });
  });
}

function readCommandLine(pid: number): string {
  if (process.platform === 'win32') {
    try {
      const output = spawnSync(
        'wmic',
        ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/format:list'],
        { encoding: 'utf8', timeout: CLI_CHECK_TIMEOUT_MS },
      );
      const text = `${output.stdout ?? ''}${output.stderr ?? ''}`;
      const line = text
        .split('\n')
        .map((value) => value.trim())
        .find((value) => value.toLowerCase().startsWith('commandline='));
      if (line) {
        return line.slice('commandline='.length);
      }
      if (text.trim()) {
        return text.trim();
      }
    } catch {
      // Fall through to PowerShell
    }

    const powerShell = spawnSync(
      'powershell',
      ['-Command', `(Get-Process -Id ${pid}).CommandLine`],
      { encoding: 'utf8', timeout: CLI_CHECK_TIMEOUT_MS },
    );
    return `${powerShell.stdout ?? ''}${powerShell.stderr ?? ''}`.trim();
  }

  const result = spawnSync('ps', ['-p', `${pid}`, '-o', 'args='], {
    encoding: 'utf8',
    timeout: CLI_CHECK_TIMEOUT_MS,
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

export function isOurProcess(pid: number, expectedRoot: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    const cmdline = readCommandLine(pid);
    if (!cmdline) {
      return false;
    }
    return cmdline.includes('watchfix') && cmdline.includes(expectedRoot);
  } catch {
    return false;
  }
}

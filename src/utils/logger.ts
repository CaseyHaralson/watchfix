import fs from 'node:fs';
import path from 'node:path';

export type Verbosity = 'quiet' | 'normal' | 'verbose';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_ROTATION = {
  maxSize: 10 * 1024 * 1024,
  maxFiles: 5,
};

const VERBOSITY_LEVELS: Record<Verbosity, LogLevel[]> = {
  quiet: ['WARN', 'ERROR'],
  normal: ['INFO', 'WARN', 'ERROR'],
  verbose: ['DEBUG', 'INFO', 'WARN', 'ERROR'],
};

export class Logger {
  private verbosity: Verbosity;
  private terminalEnabled: boolean;
  private readonly logDir: string;
  private readonly logPath: string;

  constructor(options?: {
    rootDir?: string;
    verbosity?: Verbosity;
    terminalEnabled?: boolean;
    logDir?: string;
    logFile?: string;
  }) {
    const rootDir = options?.rootDir ?? process.cwd();
    this.logDir = options?.logDir ?? path.join(rootDir, '.watchfix');
    const logFile = options?.logFile ?? 'daemon.log';
    this.logPath = path.join(this.logDir, logFile);
    this.verbosity = options?.verbosity ?? 'normal';
    this.terminalEnabled = options?.terminalEnabled ?? true;
  }

  setVerbosity(level: Verbosity): void {
    this.verbosity = level;
  }

  setTerminalEnabled(enabled: boolean): void {
    this.terminalEnabled = enabled;
  }

  debug(message: string): void {
    this.write('DEBUG', message);
  }

  info(message: string): void {
    this.write('INFO', message);
  }

  warn(message: string): void {
    this.write('WARN', message);
  }

  error(message: string): void {
    this.write('ERROR', message);
  }

  private write(level: LogLevel, message: string): void {
    if (!this.shouldLog(level)) {
      return;
    }

    this.ensureLogDir();
    this.rotateIfNeeded();

    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    fs.appendFileSync(this.logPath, line, 'utf8');

    if (this.terminalEnabled) {
      process.stderr.write(line);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return VERBOSITY_LEVELS[this.verbosity].includes(level);
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.logPath)) {
      return;
    }

    const { size } = fs.statSync(this.logPath);
    if (size < LOG_ROTATION.maxSize) {
      return;
    }

    const oldest = `${this.logPath}.${LOG_ROTATION.maxFiles}`;
    if (fs.existsSync(oldest)) {
      fs.rmSync(oldest);
    }

    for (let index = LOG_ROTATION.maxFiles - 1; index >= 1; index -= 1) {
      const source = `${this.logPath}.${index}`;
      const destination = `${this.logPath}.${index + 1}`;
      if (fs.existsSync(source)) {
        fs.renameSync(source, destination);
      }
    }

    fs.renameSync(this.logPath, `${this.logPath}.1`);
  }
}

export const DEFAULT_LOG_PATH = '.watchfix/daemon.log';

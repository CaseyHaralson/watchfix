#!/usr/bin/env node
import { Command, Option } from 'commander';
import { createRequire } from 'node:module';

import { initCommand } from './commands/init.js';
import { showCommand } from './commands/show.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { watchCommand } from './commands/watch.js';
import { fixCommand } from './commands/fix.js';
import { EXIT_CODES, InternalError, UserError } from '../utils/errors.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { name?: string; version?: string };

const addGlobalOptions = (command: Command): Command =>
  command
    .option('-c, --config <path>', 'Use alternate config file')
    .option('--verbose', 'Increase output verbosity')
    .option('-q, --quiet', 'Suppress non-essential output');

const notImplemented =
  (label: string) =>
  async (): Promise<void> => {
    throw new UserError(`${label} is not implemented yet.`);
  };

const registerCommands = (program: Command): void => {
  addGlobalOptions(
    program
      .command('init')
      .description('Create watchfix.yaml in current directory')
      .option('--agent <provider>', 'Set initial agent provider (claude, gemini, codex)')
      .option('--force', 'Overwrite existing watchfix.yaml')
      .action(async (options) => {
        await initCommand(options);
      })
  );

  addGlobalOptions(
    program
      .command('watch')
      .description('Watch logs in foreground or background')
      .option('--daemon', 'Watch logs in background (Linux/macOS only)')
      .option('--autonomous', 'Auto-fix errors without approval')
      .addOption(new Option('--daemon-child', 'Internal daemon flag').hideHelp())
      .action(async (options) => {
        await watchCommand(options);
      })
  );

  addGlobalOptions(
    program
      .command('stop')
      .description('Stop background watcher')
      .action(async (options) => {
        await stopCommand(options);
      })
  );

  addGlobalOptions(
    program
      .command('status')
      .description('Show watcher state and pending errors')
      .action(async (options) => {
        await statusCommand(options);
      })
  );

  addGlobalOptions(
    program
      .command('show')
      .description('Show full error details and analysis')
      .argument('<id>', 'Error identifier')
      .option('--json', 'Output machine-readable JSON')
      .action(async (id, options) => {
        await showCommand(id, options);
      })
  );

  addGlobalOptions(
    program
      .command('fix')
      .description('Analyze and fix specific error')
      .argument('[id]', 'Error identifier')
      .option('--all', 'Fix all pending/suggested errors sequentially')
      .option('--confirm-each', 'Prompt for confirmation before each fix')
      .option('-y, --yes', 'Skip confirmation prompt')
      .option('--analyze-only', "Stop after analysis, don't apply fix")
      .option('--reanalyze', 'Force re-run analysis even if already suggested')
      .action(async (id, options) => {
        await fixCommand(id, options);
      })
  );

  addGlobalOptions(
    program
      .command('ignore')
      .description('Mark error as ignored')
      .argument('<id>', 'Error identifier')
      .action(notImplemented('ignore'))
  );

  addGlobalOptions(
    program
      .command('logs')
      .description('Show activity log')
      .option('--tail', 'Follow activity log')
      .action(notImplemented('logs'))
  );

  const configCommand = addGlobalOptions(
    program.command('config').description('Configuration utilities')
  );

  addGlobalOptions(
    configCommand
      .command('validate')
      .description('Validate configuration file')
      .action(notImplemented('config validate'))
  );

  addGlobalOptions(
    program
      .command('clean')
      .description('Remove old context files')
      .action(notImplemented('clean'))
  );

  addGlobalOptions(
    program
      .command('version')
      .description('Show version information')
      .action(() => {
        process.stdout.write(`${pkg.name ?? 'watchfix'} ${pkg.version ?? '0.0.0'}\n`);
      })
  );
};

const program = new Command();

program
  .name('watchfix')
  .description(
    'CLI tool that watches logs, detects errors, and dispatches AI agents to fix them'
  );

addGlobalOptions(program);

program
  .helpOption('-h, --help', 'Show help for command')
  .version(pkg.version ?? '0.0.0', '-v, --version', 'Show version and exit');

registerCommands(program);

const handleError = (error: unknown): void => {
  if (error instanceof UserError) {
    console.error(error.message);
    process.exitCode = EXIT_CODES.GENERAL_ERROR;
    return;
  }

  if (error instanceof InternalError) {
    console.error(error.stack ?? error.message);
    console.error('An internal error occurred. Please check logs.');
    process.exitCode = EXIT_CODES.GENERAL_ERROR;
    return;
  }

  if (error instanceof Error) {
    console.error(error.message);
    process.exitCode = EXIT_CODES.GENERAL_ERROR;
    return;
  }

  console.error('Unknown error occurred.');
  process.exitCode = EXIT_CODES.GENERAL_ERROR;
};

const main = async (): Promise<void> => {
  process.on('SIGINT', () => {
    process.exit(EXIT_CODES.INTERRUPTED);
  });

  try {
    await program.parseAsync(process.argv);
    if (!process.exitCode) {
      process.exitCode = EXIT_CODES.SUCCESS;
    }
  } catch (error) {
    handleError(error);
  }
};

void main();

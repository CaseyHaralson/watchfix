import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { loadConfig, DEFAULT_CONFIG_PATH } from '../../config/loader.js';

type VersionOptions = {
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
};

type ConfigStatus = 'valid' | 'invalid' | 'not found';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json') as { name?: string; version?: string };

const resolveConfigPath = (configPath?: string): string =>
  path.resolve(process.cwd(), configPath ?? DEFAULT_CONFIG_PATH);

const describeConfigStatus = (
  configPath?: string
): { status: ConfigStatus; agent?: string; error?: string } => {
  const resolvedPath = resolveConfigPath(configPath);
  if (!fs.existsSync(resolvedPath)) {
    return { status: 'not found' };
  }

  try {
    const config = loadConfig(resolvedPath);
    return { status: 'valid', agent: config.agent.provider };
  } catch (error) {
    const err = error as Error;
    return { status: 'invalid', error: err.message ?? String(error) };
  }
};

export const versionCommand = async (options: VersionOptions): Promise<void> => {
  const { status, agent, error } = describeConfigStatus(options.config);

  const lines = [
    `${pkg.name ?? 'watchfix'} version: ${pkg.version ?? '0.0.0'}`,
    `Node.js version: ${process.version}`,
    `Config: ${status}`,
  ];

  if (status !== 'not found') {
    lines.push(`Agent: ${agent ?? 'unknown (config invalid)'}`);
  }

  if (options.verbose && error) {
    lines.push(`Config error: ${error}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
};

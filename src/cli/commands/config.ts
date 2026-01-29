import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import yaml from 'yaml';

import { AGENT_DEFAULTS } from '../../agents/defaults.js';
import { checkCliExists } from '../../utils/process.js';
import { configSchema, type Config } from '../../config/schema.js';
import { DEFAULT_CONFIG_PATH } from '../../config/loader.js';
import { UserError } from '../../utils/errors.js';

type ConfigValidateOptions = {
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
};

const resolveConfigPath = (configPath?: string): string =>
  path.resolve(process.cwd(), configPath ?? DEFAULT_CONFIG_PATH);

const resolveIfRelative = (baseDir: string, value: string): string =>
  path.isAbsolute(value) ? value : path.resolve(baseDir, value);

const resolveConfigPaths = (config: Config, baseDir: string): Config => ({
  ...config,
  project: {
    ...config.project,
    root: resolveIfRelative(baseDir, config.project.root),
  },
  logs: {
    ...config.logs,
    sources: config.logs.sources.map((source) => {
      if (source.type !== 'file') {
        return source;
      }
      return {
        ...source,
        path: resolveIfRelative(baseDir, source.path),
      };
    }),
  },
});

const formatZodErrors = (error: ZodError): string[] =>
  error.issues.map((issue) => {
    const pathLabel = issue.path.length > 0 ? issue.path.join('.') : 'root';
    return `${pathLabel}: ${issue.message}`;
  });

const readConfigFile = (filePath: string): string => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new UserError(
        `Config file not found at ${filePath}. Create watchfix.yaml or use --config to specify a path.`
      );
    }
    throw new UserError(
      `Failed to read config file at ${filePath}: ${err.message ?? String(err)}`
    );
  }
};

const parseConfigYaml = (contents: string, filePath: string): unknown => {
  try {
    return yaml.parse(contents);
  } catch (error) {
    const err = error as Error;
    throw new UserError(
      `Failed to parse YAML in ${filePath}: ${err.message ?? String(err)}`
    );
  }
};

const formatCheckSection = (label: string, entries: string[]): string[] => {
  if (entries.length === 0) {
    return [];
  }
  return [label, ...entries.map((entry) => `  - ${entry}`)];
};

const checkAgentCli = (config: Config): { info: string; error?: string } => {
  const defaults = AGENT_DEFAULTS[config.agent.provider];
  const command = config.agent.command ?? defaults.command;
  const result = checkCliExists(command);
  if (!result.exists) {
    return {
      info: `Agent CLI: ${command} (not found)`,
      error: result.error ?? `Agent CLI '${command}' not found`,
    };
  }
  const versionLabel = result.version ? `(${result.version})` : '(version unknown)';
  return { info: `Agent CLI: ${command} ${versionLabel}` };
};

const describeAccessError = (error: NodeJS.ErrnoException): string => {
  if (error.code === 'ENOENT') {
    return 'not found';
  }
  if (error.code === 'EACCES') {
    return 'permission denied';
  }
  return error.message ?? String(error);
};

const checkLogSourcePaths = (config: Config): string[] => {
  const warnings: string[] = [];
  for (const source of config.logs.sources) {
    if (source.type !== 'file') {
      continue;
    }
    try {
      fs.accessSync(source.path, fs.constants.R_OK);
    } catch (error) {
      const detail = describeAccessError(error as NodeJS.ErrnoException);
      warnings.push(
        `Log source '${source.name}' path not accessible: ${source.path} (${detail})`
      );
    }
  }
  return warnings;
};

export const configValidateCommand = async (
  options: ConfigValidateOptions
): Promise<void> => {
  const configPath = resolveConfigPath(options.config);
  const contents = readConfigFile(configPath);
  const rawConfig = parseConfigYaml(contents, configPath);
  const validation = configSchema.safeParse(rawConfig);

  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  if (!validation.success) {
    errors.push(...formatZodErrors(validation.error));
  }

  if (validation.success) {
    const configDir = path.dirname(configPath);
    const resolvedConfig = resolveConfigPaths(validation.data, configDir);
    const agentCheck = checkAgentCli(resolvedConfig);
    info.push(agentCheck.info);
    if (agentCheck.error) {
      errors.push(agentCheck.error);
    }
    warnings.push(...checkLogSourcePaths(resolvedConfig));
  }

  if (errors.length > 0) {
    const lines = [
      'Configuration validation failed.',
      ...formatCheckSection('Errors:', errors),
      ...formatCheckSection('Warnings:', warnings),
    ];
    throw new UserError(lines.join('\n'));
  }

  const lines = [
    'Configuration is valid.',
    ...info,
    ...formatCheckSection('Warnings:', warnings),
  ].filter(Boolean);

  process.stdout.write(`${lines.join('\n')}\n`);
};

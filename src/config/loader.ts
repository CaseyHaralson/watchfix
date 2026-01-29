import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import yaml from 'yaml';

import { configSchema, type Config } from './schema.js';
import { UserError } from '../utils/errors.js';

const DEFAULT_CONFIG_PATH = 'watchfix.yaml';

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

const formatZodError = (error: ZodError): string => {
  const lines = error.issues.map((issue) => {
    const pathLabel = issue.path.length > 0 ? issue.path.join('.') : 'root';
    return `- ${pathLabel}: ${issue.message}`;
  });

  return `Invalid configuration:\n${lines.join('\n')}`;
};

const assertProjectRoot = (rootPath: string): void => {
  try {
    const stats = fs.statSync(rootPath);
    if (!stats.isDirectory()) {
      throw new UserError(`Project root is not a directory: ${rootPath}`);
    }
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }

    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new UserError(`Project root does not exist: ${rootPath}`);
    }

    throw new UserError(
      `Unable to access project root ${rootPath}: ${err.message ?? String(err)}`
    );
  }
};

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

const validateConfig = (rawConfig: unknown): Config => {
  try {
    return configSchema.parse(rawConfig);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new UserError(formatZodError(error));
    }
    throw error;
  }
};

export const loadConfig = (configPath?: string): Config => {
  const resolvedPath = resolveConfigPath(configPath);
  const fileContents = readConfigFile(resolvedPath);
  const rawConfig = parseConfigYaml(fileContents, resolvedPath);
  const parsedConfig = validateConfig(rawConfig);
  const configDir = path.dirname(resolvedPath);
  const resolvedConfig = resolveConfigPaths(parsedConfig, configDir);

  assertProjectRoot(resolvedConfig.project.root);

  return resolvedConfig;
};

export { DEFAULT_CONFIG_PATH };

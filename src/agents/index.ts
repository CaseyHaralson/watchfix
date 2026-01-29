import type { Agent, AgentConfig, AgentProvider } from './types.js';
import { AGENT_CONFIG_DEFAULTS, AGENT_DEFAULTS } from './defaults.js';
import { checkCliExists } from '../utils/process.js';
import type { Logger } from '../utils/logger.js';
import { ClaudeAgent } from './claude.js';
import { GeminiAgent } from './gemini.js';
import { CodexAgent } from './codex.js';

export type AgentConfigInput = {
  provider: AgentProvider;
  command?: string;
  args?: string[];
  stderrIsProgress?: boolean;
  timeout?: number;
  retries?: number;
};

export type CreateAgentOptions = {
  projectRoot: string;
  logger?: Logger;
  terminalEnabled?: boolean;
};

export type AgentConfigOverrides = Omit<AgentConfigInput, 'provider'>;

function resolveAgentConfig(input: AgentConfigInput): AgentConfig {
  const defaults = AGENT_DEFAULTS[input.provider];

  return {
    provider: input.provider,
    command: input.command ?? defaults.command,
    args: input.args ? [...input.args] : [...defaults.args],
    stderrIsProgress: input.stderrIsProgress ?? defaults.stderrIsProgress,
    timeout: input.timeout ?? AGENT_CONFIG_DEFAULTS.timeout,
    retries: input.retries ?? AGENT_CONFIG_DEFAULTS.retries,
  };
}

function assertCliExists(command: string): void {
  const result = checkCliExists(command);
  if (!result.exists) {
    const detail = result.error ? ` (${result.error})` : '';
    throw new Error(`Agent CLI '${command}' not found${detail}`);
  }
}

const isCreateAgentOptions = (
  value: AgentConfigOverrides | CreateAgentOptions
): value is CreateAgentOptions =>
  typeof (value as CreateAgentOptions).projectRoot === 'string';

export function createAgent(
  provider: AgentProvider,
  config: AgentConfigOverrides,
  options: CreateAgentOptions
): Agent;
export function createAgent(
  provider: AgentProvider,
  options: CreateAgentOptions
): Agent;
export function createAgent(
  config: AgentConfigInput,
  options: CreateAgentOptions
): Agent;
export function createAgent(
  providerOrConfig: AgentProvider | AgentConfigInput,
  configOrOptions: AgentConfigOverrides | CreateAgentOptions,
  maybeOptions?: CreateAgentOptions
): Agent {
  let config: AgentConfigInput;
  let options: CreateAgentOptions;

  if (typeof providerOrConfig === 'string') {
    const provider = providerOrConfig;
    if (isCreateAgentOptions(configOrOptions)) {
      config = { provider };
      options = configOrOptions;
    } else {
      if (!maybeOptions) {
        throw new Error('createAgent requires options with projectRoot');
      }
      config = { provider, ...configOrOptions };
      options = maybeOptions;
    }
  } else {
    config = providerOrConfig;
    if (!isCreateAgentOptions(configOrOptions)) {
      throw new Error('createAgent requires options with projectRoot');
    }
    options = configOrOptions;
  }

  const resolvedConfig = resolveAgentConfig(config);
  assertCliExists(resolvedConfig.command);

  switch (resolvedConfig.provider) {
    case 'claude':
      return new ClaudeAgent(resolvedConfig, options);
    case 'gemini':
      return new GeminiAgent(resolvedConfig, options);
    case 'codex':
      return new CodexAgent(resolvedConfig, options);
    default: {
      const exhaustive: never = resolvedConfig.provider;
      throw new Error(`Unsupported agent provider: ${exhaustive}`);
    }
  }
}

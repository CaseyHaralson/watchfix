import type { AgentConfig } from './types.js';
import { BaseAgent } from './base.js';
import type { Logger } from '../utils/logger.js';

export type ClaudeAgentOptions = {
  projectRoot: string;
  logger?: Logger;
  terminalEnabled?: boolean;
};

export class ClaudeAgent extends BaseAgent {
  constructor(config: AgentConfig, options: ClaudeAgentOptions) {
    super(config, options);
  }
}

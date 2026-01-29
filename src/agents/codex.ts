import type { AgentConfig } from './types.js';
import { BaseAgent } from './base.js';
import type { Logger } from '../utils/logger.js';

export type CodexAgentOptions = {
  projectRoot: string;
  logger?: Logger;
  terminalEnabled?: boolean;
};

export class CodexAgent extends BaseAgent {
  constructor(config: AgentConfig, options: CodexAgentOptions) {
    super(config, options);
  }
}

import type { AgentConfig } from './types.js';
import { BaseAgent } from './base.js';
import type { Logger } from '../utils/logger.js';

export type GeminiAgentOptions = {
  projectRoot: string;
  logger?: Logger;
  terminalEnabled?: boolean;
};

export class GeminiAgent extends BaseAgent {
  constructor(config: AgentConfig, options: GeminiAgentOptions) {
    super(config, options);
  }
}

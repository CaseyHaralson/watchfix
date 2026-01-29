export type AgentProvider = 'claude' | 'gemini' | 'codex';

export interface AgentConfig {
  provider: AgentProvider;
  command: string;
  args: string[];
  stderrIsProgress: boolean;
  timeout: number;
  retries: number;
}

export interface AgentResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputFileExists: boolean;
}

export interface Agent {
  config: AgentConfig;
  analyze(contextPath: string): Promise<AgentResult>;
  fix(contextPath: string): Promise<AgentResult>;
}

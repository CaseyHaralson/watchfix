export type LogEvent = {
  source: string;
  line: string;
  timestamp: Date;
};

export type NdjsonConfig = {
  messageField: string;
  timestampField?: string;
  levelField?: string;
  levelFilter?: string[];
};

export type FileSourceConfig = {
  name: string;
  type: 'file';
  path: string;
  format?: 'text' | 'ndjson';
  ndjson?: NdjsonConfig;
};

export type DockerSourceConfig = {
  name: string;
  type: 'docker';
  container: string;
};

export type CommandSourceConfig = {
  name: string;
  type: 'command';
  run: string;
  interval: string;
};

export type LogSourceConfig =
  | FileSourceConfig
  | DockerSourceConfig
  | CommandSourceConfig;

export interface LogSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: 'line', handler: (event: LogEvent) => void): void;
}

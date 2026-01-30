export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export class InternalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InternalError';
  }
}

export type ErrorStatus =
  | 'pending'
  | 'analyzing'
  | 'suggested'
  | 'fixing'
  | 'fixed'
  | 'failed'
  | 'ignored'
  | 'resolved';

export const EXIT_CODES = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  WATCHER_CONFLICT: 2,
  NOT_ACTIONABLE: 3,
  SCHEMA_MISMATCH: 4,
  INTERRUPTED: 130,
} as const;

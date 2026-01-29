import { UserError } from './errors.js';

const DURATION_REGEX = /^(\d+(?:\.\d+)?)([smh])$/;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

export function parseDuration(input: string): number {
  const trimmed = input.trim();
  const match = DURATION_REGEX.exec(trimmed);

  if (!match) {
    throw new UserError(`Invalid duration: ${input}`);
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new UserError(`Invalid duration: ${input}`);
  }

  const unit = match[2];
  const multiplier =
    unit === 'h' ? HOUR_MS : unit === 'm' ? MINUTE_MS : SECOND_MS;

  return value * multiplier;
}

export function formatDuration(ms: number): string {
  if (ms % HOUR_MS === 0) {
    return `${ms / HOUR_MS}h`;
  }

  if (ms % MINUTE_MS === 0) {
    return `${ms / MINUTE_MS}m`;
  }

  if (ms % SECOND_MS === 0) {
    return `${ms / SECOND_MS}s`;
  }

  return `${ms}ms`;
}

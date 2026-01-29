import { createHash } from 'crypto';

const ISO_TIMESTAMP_REGEX =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g;
const UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_ADDRESS_REGEX = /0x[0-9a-f]+/gi;
const WHITESPACE_REGEX = /\s+/g;

export function normalizeMessage(message: string): string {
  return message
    .replace(ISO_TIMESTAMP_REGEX, '')
    .replace(UUID_REGEX, '')
    .replace(HEX_ADDRESS_REGEX, '')
    .replace(WHITESPACE_REGEX, ' ')
    .trim();
}

export function computeErrorHash(
  source: string,
  errorType: string,
  message: string
): string {
  const normalizedMessage = normalizeMessage(message);
  const input = `${source}${errorType}${normalizedMessage}`;
  return createHash('sha256').update(input).digest('hex');
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { UserError } from '../../utils/errors.js';

export const manualCommand = async (): Promise<void> => {
  const helpPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'HELP.md'
  );

  try {
    const content = await fs.readFile(helpPath, 'utf8');
    process.stdout.write(content);
  } catch {
    throw new UserError(
      'HELP.md not found. This file should be included in the watchfix package.'
    );
  }
};

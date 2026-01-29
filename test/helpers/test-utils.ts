import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(__dirname, '../fixtures');

export async function createTempDir(prefix = 'watchfix-'): Promise<string> {
  const base = path.join(os.tmpdir(), prefix);
  return fs.promises.mkdtemp(base);
}

export async function removeTempDir(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

export async function writeTempFile(
  baseDir: string,
  relativePath: string,
  contents: string
): Promise<string> {
  const fullPath = path.resolve(baseDir, relativePath);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, contents, 'utf8');
  return fullPath;
}

export function readFixture(relativePath: string): string {
  const fullPath = path.resolve(fixturesRoot, relativePath);
  return fs.readFileSync(fullPath, 'utf8');
}

export function fixturePath(relativePath: string): string {
  return path.resolve(fixturesRoot, relativePath);
}

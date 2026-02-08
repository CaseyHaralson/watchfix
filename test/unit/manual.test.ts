import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

describe('HELP.md', () => {
  const helpPath = path.resolve(__dirname, '..', '..', 'HELP.md');

  it('exists and is readable', async () => {
    const content = await fs.readFile(helpPath, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('starts with "# watchfix"', async () => {
    const content = await fs.readFile(helpPath, 'utf8');
    expect(content.startsWith('# watchfix')).toBe(true);
  });
});

describe('manualCommand', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('writes HELP.md content to stdout', async () => {
    const { manualCommand } = await import(
      '../../src/cli/commands/manual.js'
    );
    await manualCommand();

    expect(writeSpy).toHaveBeenCalledOnce();
    const output = writeSpy.mock.calls[0]![0] as string;
    expect(output).toContain('# watchfix');
    expect(output).toContain('watchfix manual');
  });
});

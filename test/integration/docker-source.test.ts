import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerSource } from '../../src/watcher/sources/docker.js';
import type { LogEvent } from '../../src/watcher/sources/types.js';
import { checkCliExists } from '../../src/utils/process.js';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const dockerExists = checkCliExists('docker').exists;
const dockerInfo = dockerExists
  ? spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 2000 })
  : null;
const dockerReady = dockerExists && dockerInfo?.status === 0;
const alpineReady = dockerReady
  ? spawnSync('docker', ['image', 'inspect', 'alpine'], {
      encoding: 'utf8',
      timeout: 2000,
    }).status === 0
  : false;

const describeDocker = dockerReady && alpineReady ? describe : describe.skip;

const runDocker = (args: string[]): void => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').toString().trim();
    throw new Error(`docker ${args.join(' ')} failed: ${stderr || 'unknown error'}`);
  }
};

const waitForEvents = (
  source: DockerSource,
  count: number,
  timeoutMs = 5000
): Promise<LogEvent[]> =>
  new Promise((resolve, reject) => {
    const events: LogEvent[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${count} events`));
    }, timeoutMs);

    source.on('line', (event) => {
      events.push(event);
      if (events.length === count) {
        clearTimeout(timer);
        resolve(events);
      }
    });
  });

const createLogger = () => ({
  warn() {},
  info() {},
  debug() {},
  error() {},
});

const containers: string[] = [];

afterEach(() => {
  for (const name of containers) {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 5000 });
  }
  containers.length = 0;
});

describeDocker('DockerSource', () => {
  it('streams logs and parses timestamps', async () => {
    const name = `watchfix-test-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    containers.push(name);

    runDocker([
      'run',
      '-d',
      '--name',
      name,
      'alpine',
      'sh',
      '-c',
      'i=0; while true; do echo "line-$i"; i=$((i+1)); sleep 0.2; done',
    ]);

    const source = new DockerSource(
      { name: 'docker-test', type: 'docker', container: name },
      { logger: createLogger() },
    );

    try {
      await source.start();
      const events = await waitForEvents(source, 2);
      expect(events[0].line).toMatch(/line-\d+/);
      expect(Number.isNaN(events[0].timestamp.getTime())).toBe(false);
    } finally {
      await source.stop();
    }
  });

  it('reconnects after container removal with backoff', async () => {
    const name = `watchfix-test-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    containers.push(name);

    runDocker([
      'run',
      '-d',
      '--name',
      name,
      'alpine',
      'sh',
      '-c',
      'i=0; while true; do echo "reconnect-$i"; i=$((i+1)); sleep 0.2; done',
    ]);

    const source = new DockerSource(
      { name: 'docker-test', type: 'docker', container: name },
      { logger: createLogger() },
    );

    try {
      await source.start();
      await waitForEvents(source, 1);

      const stopAt = Date.now();
      runDocker(['rm', '-f', name]);
      await delay(200);

      runDocker([
        'run',
        '-d',
        '--name',
        name,
        'alpine',
        'sh',
        '-c',
        'i=0; while true; do echo "reconnect-$i"; i=$((i+1)); sleep 0.2; done',
      ]);

      const [event] = await waitForEvents(source, 1, 10_000);
      const elapsed = Date.now() - stopAt;
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(event.line).toMatch(/reconnect-\d+/);
    } finally {
      await source.stop();
    }
  });
});

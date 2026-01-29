import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { checkHealth } from '../../src/utils/http.js';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/ua') {
      const userAgent = req.headers['user-agent'];
      if (userAgent === 'watchfix/1.0') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(400);
      res.end('bad user agent');
      return;
    }

    if (url === '/ok') {
      res.writeHead(200);
      res.end('ok');
      return;
    }

    if (url === '/not-found') {
      res.writeHead(404);
      res.end('no');
      return;
    }

    if (url === '/redirect-ok') {
      res.writeHead(302, { location: '/ok' });
      res.end();
      return;
    }

    if (url.startsWith('/redirect/')) {
      const [, , part] = url.split('/');
      const index = Number.parseInt(part ?? '', 10);
      const next = Number.isFinite(index) ? index + 1 : 1;
      res.writeHead(302, { location: `/redirect/${next}` });
      res.end();
      return;
    }

    if (url === '/slow') {
      setTimeout(() => {
        res.writeHead(200);
        res.end('slow');
      }, 200);
      return;
    }

    res.writeHead(500);
    res.end('unexpected');
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('checkHealth', () => {
  it('returns success for 2xx responses and sends user agent', async () => {
    const result = await checkHealth(`${baseUrl}/ua`, 1_000);
    expect(result).toEqual({ success: true, status: 204 });
  });

  it('returns failure for non-2xx responses', async () => {
    const result = await checkHealth(`${baseUrl}/not-found`, 1_000);
    expect(result).toEqual({ success: false, status: 404 });
  });

  it('follows redirects up to the limit', async () => {
    const result = await checkHealth(`${baseUrl}/redirect-ok`, 1_000);
    expect(result).toEqual({ success: true, status: 200 });
  });

  it('fails after too many redirects', async () => {
    const result = await checkHealth(`${baseUrl}/redirect/1`, 1_000);
    expect(result).toEqual({ success: false, error: 'Too many redirects' });
  });

  it('returns timeout error when request takes too long', async () => {
    const result = await checkHealth(`${baseUrl}/slow`, 50);
    expect(result).toEqual({ success: false, error: 'Request timed out' });
  });

  it('returns network errors gracefully', async () => {
    const tempServer = http.createServer();
    await new Promise<void>((resolve) => tempServer.listen(0, resolve));
    const { port } = tempServer.address() as AddressInfo;
    await new Promise<void>((resolve) => tempServer.close(() => resolve()));

    const result = await checkHealth(`http://127.0.0.1:${port}`, 200);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    if (result.error) {
      expect(result.error).toContain('ECONNREFUSED');
    }
  });
});

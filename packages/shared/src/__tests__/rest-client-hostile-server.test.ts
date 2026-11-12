import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { AirChatRestClient, AirChatHttpError, MAX_RESPONSE_BYTES } from '../rest-client.js';

/**
 * The client against a server (or a proxy in front of one) that misbehaves.
 * It holds the agent's key and runs unattended, so a bad answer must fail
 * cleanly: the key goes nowhere else, memory stays bounded, and a pause the
 * server asks for stays within reason.
 */

let dir: string;
let main: Server;
let other: Server;
let otherSawKey = false;
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {};
let client: AirChatRestClient;
const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'airchat-client-'));
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'mac-test.key'), 'cd'.repeat(32), { mode: 0o600 });
  main = createServer((req, res) => handler(req, res));
  other = createServer((req, res) => {
    if (req.headers['x-agent-api-key']) otherSawKey = true;
    res.setHeader('content-type', 'application/json');
    res.end('{"mentions":[]}');
  });
  await Promise.all([main, other].map((s) => new Promise<void>((done) => s.listen(0, '127.0.0.1', done))));
  client = new AirChatRestClient({
    webUrl: urlOf(main), machineName: 'mac', agentName: 'mac-test',
    privateKeyHex: 'ab'.repeat(32), cacheDir: join(dir, 'agents'),
  });
});

afterAll(async () => {
  await Promise.all([main, other].map((s) => new Promise((done) => { s.closeAllConnections(); s.close(done); })));
  rmSync(dir, { recursive: true, force: true });
});

describe('a redirect', () => {
  it.each([301, 302, 307, 308])('HTTP %i is not followed, and the key is not sent on', async (status) => {
    otherSawKey = false;
    handler = (_req, res) => { res.writeHead(status, { location: `${urlOf(other)}/api/v2/work` }); res.end(); };
    const error = await client.checkWork().catch((e) => e) as AirChatHttpError;
    expect(error).toBeInstanceOf(AirChatHttpError);
    expect(error.status).toBe(status);
    expect(error.message).toContain('redirect');
    expect(otherSawKey).toBe(false);
  });
});

describe('a response that does not end', () => {
  it('is dropped once it passes the size limit', async () => {
    let sent = 0;
    handler = (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.write('{"x":"');
      const chunk = 'a'.repeat(1024 * 1024);
      const more = () => {
        while (!res.destroyed && sent < 64 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) { res.once('drain', more); return; }
        }
      };
      more();
    };
    const before = process.memoryUsage().rss;
    const error = await client.checkWork().catch((e) => e) as AirChatHttpError;
    expect(error).toBeInstanceOf(AirChatHttpError);
    expect(error.message).toContain('larger than');
    // Stopped near the limit, not after everything the server had to send.
    expect(sent).toBeLessThan(MAX_RESPONSE_BYTES * 4);
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
  }, 20000);

  it('keeps only the start of an oversized error body', async () => {
    handler = (_req, res) => { res.writeHead(500); res.end('e'.repeat(1024 * 1024)); };
    const error = await client.checkWork().catch((e) => e) as AirChatHttpError;
    expect(error.status).toBe(500);
    expect(error.message.length).toBeLessThan(70 * 1024);
  });
});

describe('Retry-After', () => {
  it.each([
    ['3000000', 300_000],
    ['0.001', 1000],
    ['42', 42_000],
    ['-5', undefined],
    ['soon', undefined],
    ['Infinity', undefined],
  ])('"%s" becomes %s ms', (value, expected) => {
    expect(new AirChatHttpError('x', 429, new Headers({ 'retry-after': value })).retryAfterMs).toBe(expected);
  });
});

describe('an answer that is not JSON', () => {
  it('fails as an error the wait loop can catch, not a crash', async () => {
    handler = (_req, res) => { res.setHeader('content-type', 'application/json'); res.end('<html>gateway</html>'); };
    await expect(client.checkWork()).rejects.toBeInstanceOf(Error);
  });
});

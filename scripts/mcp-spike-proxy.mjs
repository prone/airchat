#!/usr/bin/env node
/**
 * A deliberately tiny proxy that exposes ONLY /api/mcp, for the claude.ai
 * bearer spike.
 *
 * WHY THIS EXISTS. The spike needs claude.ai to reach the MCP endpoint from the
 * internet, which the NAS is not. The obvious move — point a tunnel at
 * http://<nas>:3003 — would also expose /api/v2, whose ~19 routes accept the
 * derived machine key with no scope, expiry or audience binding. That is the
 * exact exposure flagged when the tunnel was first discussed, and it should not
 * be created casually for a test.
 *
 * So a tunnel points here instead. This process forwards exactly one path and
 * refuses everything else, which means the blast radius of the public URL is
 * this file rather than the whole application.
 *
 *   node scripts/mcp-spike-proxy.mjs
 *   cloudflared tunnel --url http://localhost:8787
 *
 * The second command prints a random *.trycloudflare.com hostname. That is the
 * URL to give claude.ai. It needs no DNS record, no account configuration and
 * no dashboard access, and it disappears when cloudflared stops.
 *
 * THIS IS FOR A SPIKE, NOT FOR PRODUCTION. It is single-process, has no
 * durability, and its hostname changes on every run. The permanent answer is a
 * named tunnel on the NAS with an ingress rule of `path: ^/api/mcp$`.
 */

import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

const ORIGIN_HOST = process.env.SPIKE_ORIGIN_HOST ?? '100.99.11.124';
const ORIGIN_PORT = Number(process.env.SPIKE_ORIGIN_PORT ?? 3003);
const LISTEN_PORT = Number(process.env.SPIKE_PORT ?? 8787);

/** The only path that is forwarded. Everything else 404s. */
const ALLOWED_PATH = '/api/mcp';

let forwarded = 0;
let refused = 0;

const server = createServer((req, res) => {
  // Compare only the pathname: a query string must not smuggle a different
  // route past this check.
  const path = (req.url ?? '').split('?')[0];

  if (path !== ALLOWED_PATH) {
    refused++;
    console.log(`  refused  ${req.method} ${path}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  forwarded++;
  const auth = req.headers.authorization;
  console.log(
    `  forward  ${req.method} ${path}  ` +
    `authorization: ${auth ? auth.slice(0, 12) + '…' : 'ABSENT'}`,
  );

  // Forwarding the Authorization header verbatim is the whole point of the
  // spike: whether claude.ai sends one at all is the question being answered.
  const upstream = httpRequest(
    { host: ORIGIN_HOST, port: ORIGIN_PORT, path, method: req.method, headers: { ...req.headers, host: `${ORIGIN_HOST}:${ORIGIN_PORT}` } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    console.error(`  upstream error: ${err.message}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad gateway' }));
  });

  req.pipe(upstream);
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`MCP spike proxy on http://127.0.0.1:${LISTEN_PORT}`);
  console.log(`  forwarding ONLY ${ALLOWED_PATH} -> http://${ORIGIN_HOST}:${ORIGIN_PORT}`);
  console.log(`  everything else returns 404\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${forwarded} forwarded, ${refused} refused`);
    process.exit(0);
  });
}

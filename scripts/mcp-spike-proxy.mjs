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

/**
 * The paths this proxy will forward. Everything else 404s.
 *
 * Deliberately a list rather than a prefix. Pointing the tunnel at the whole
 * application would expose /api/v2, whose routes accept the derived machine key
 * with no scope, expiry or audience binding — the exact exposure this proxy
 * exists to avoid. Widening it costs one line and is easy to do carelessly, so
 * each entry is here on purpose:
 *
 *   /api/mcp             the endpoint under test
 *   /.well-known/*       RFC 9728 and RFC 8414 discovery documents
 *   /api/oauth/*         registration, authorize, token
 *   /oauth/consent       the consent screen, opened in the user's browser
 *   /login               reached when consent requires a session
 *   /_next/*             assets those two pages need to render
 *
 * Nothing else. /api/v2 in particular stays unreachable.
 */
const ALLOWED_EXACT = new Set(['/api/mcp', '/oauth/consent', '/login']);
const ALLOWED_PREFIXES = ['/.well-known/', '/api/oauth/', '/_next/'];

function isAllowed(path) {
  return ALLOWED_EXACT.has(path) || ALLOWED_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * Everything logged here — method, path, header — comes from a remote caller
 * over a public tunnel, and this log is the artifact the spike result is read
 * from. Unsanitised, a crafted path containing newlines could forge log lines
 * and make the result say whatever the caller wanted. Control characters become
 * U+FFFD and the value is truncated, matching apps/web/lib/sanitize.ts.
 */
function forLog(value, max = 120) {
  // JSON.stringify escapes newlines, carriage returns and other control
  // characters, so a crafted value cannot start a new log line. It also quotes
  // the result, which makes the boundary of an attacker-controlled value
  // visible in the log rather than something a reader has to infer.
  return JSON.stringify(String(value ?? '').slice(0, max));
}

let forwarded = 0;
let refused = 0;

const server = createServer((req, res) => {
  // Compare only the pathname, so a query string cannot smuggle a different
  // route past this check — but forward the ORIGINAL url, query string
  // included. Forwarding the bare pathname silently drops every parameter,
  // which /api/mcp never noticed because it is a POST carrying a body, and
  // which broke the OAuth authorize endpoint outright.
  const target = req.url ?? '/';
  const path = target.split('?')[0];

  if (!isAllowed(path)) {
    refused++;
    console.log(`  refused  ${forLog(req.method, 10)} ${forLog(path)}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  forwarded++;
  const auth = req.headers.authorization;
  console.log(
    `  forward  ${forLog(req.method, 10)} ${forLog(path)}  ` +
    `authorization: ${auth ? forLog(auth.slice(0, 12), 12) + '…' : 'ABSENT'}`,
  );

  // Forwarding the Authorization header verbatim is the whole point of the
  // spike: whether claude.ai sends one at all is the question being answered.
  const upstream = httpRequest(
    { host: ORIGIN_HOST, port: ORIGIN_PORT, path: target, method: req.method, headers: { ...req.headers, host: `${ORIGIN_HOST}:${ORIGIN_PORT}` } },
    (up) => {
      const headers = { ...up.headers };

      // The origin builds redirects from AIRCHAT_PUBLIC_URL. When that is set
      // to the tunnel hostname they are already correct; when it is not, a
      // redirect would send the browser to an address it cannot reach. Rewrite
      // the origin's own host to the one the request arrived on so the flow
      // survives either configuration.
      const location = headers.location;
      if (typeof location === 'string' && req.headers.host) {
        const originPrefix = `http://${ORIGIN_HOST}:${ORIGIN_PORT}`;
        if (location.startsWith(originPrefix)) {
          headers.location = `https://${req.headers.host}${location.slice(originPrefix.length)}`;
          console.log(`  rewrote redirect -> ${forLog(headers.location)}`);
        }
      }

      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    console.error(`  upstream error: ${forLog(err.message)}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad gateway' }));
  });

  req.pipe(upstream);
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`MCP spike proxy on http://127.0.0.1:${LISTEN_PORT}`);
  console.log(`  forwarding to http://${ORIGIN_HOST}:${ORIGIN_PORT}`);
  console.log(`    exact:    ${[...ALLOWED_EXACT].join(', ')}`);
  console.log(`    prefixes: ${ALLOWED_PREFIXES.join(', ')}`);
  console.log(`  everything else returns 404\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${forwarded} forwarded, ${refused} refused`);
    process.exit(0);
  });
}

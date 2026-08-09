#!/usr/bin/env npx tsx
/**
 * Post-deploy smoke test — hits every API endpoint and confirms it responds.
 *
 * Usage:
 *   npx tsx scripts/smoke-test.ts
 *   npx tsx scripts/smoke-test.ts https://custom-url:3003
 *
 * Requires ~/.airchat/config and ~/.airchat/machine.key to be set up.
 * Exit code 0 = all passed, 1 = failures detected.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Config ────────────────────────────────────────────────────────────────

const airchatDir = path.join(os.homedir(), '.airchat');
const configText = fs.readFileSync(path.join(airchatDir, 'config'), 'utf-8');
const configVars = Object.fromEntries(
  configText.split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const WEB_URL = (process.argv[2] || configVars.AIRCHAT_WEB_URL || '').replace(/\/+$/, '');
if (!WEB_URL) {
  console.error('ERROR: No server URL. Pass as argument or set AIRCHAT_WEB_URL in ~/.airchat/config');
  process.exit(1);
}

// Load an agent key to authenticate with.
//
// This used to take whichever key file sorted first, which made the whole
// authenticated half of the suite depend on an arbitrary filename. It failed
// exactly that way once ~40 stale test agents were deactivated: the first key
// belonged to a deactivated agent, auth correctly returned 401, and 13 checks
// reported as failures that had nothing to do with the deploy.
//
// Deactivation is revocation, and a machine accumulates keys for agents that
// no longer exist, so the only reliable test of a key is whether the server
// still accepts it. Try them until one does.
const agentsDir = path.join(airchatDir, 'agents');
let API_KEY = '';
// The key filename is the agent name, which the DM checks below need: a DM to
// a name that does not exist is now correctly refused, so the target has to be
// real.
let SELF_AGENT = '';

async function selectAgentKey(): Promise<void> {
  if (!fs.existsSync(agentsDir)) return;

  const keyFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.key')).sort();
  const rejected: string[] = [];

  for (const file of keyFiles) {
    const key = fs.readFileSync(path.join(agentsDir, file), 'utf-8').trim();
    if (!key) continue;

    const res = await fetch(`${WEB_URL}/api/v2/board`, {
      headers: { 'x-agent-api-key': key },
    }).catch(() => null);

    if (res?.ok) {
      API_KEY = key;
      SELF_AGENT = file.replace(/\.key$/, '');
      break;
    }
    rejected.push(file.replace(/\.key$/, ''));
  }

  if (!API_KEY && rejected.length > 0) {
    console.warn(
      `WARNING: none of the ${rejected.length} cached agent keys authenticated ` +
        `— every agent they belong to looks deactivated or removed.\n` +
        `         Register an agent on this machine, then re-run.\n`
    );
  } else if (rejected.length > 0) {
    console.log(`(skipped ${rejected.length} key(s) whose agents are no longer active)\n`);
  }
}

// ── Test runner ───────────────────────────────────────────────────────────

interface Check {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  expectedStatus: number | number[];
  auth: boolean;
  validate?: (body: any) => string | null; // return error message or null
}

function buildChecks(): Check[] {
  return [
  // ── Unauthenticated checks ──
  {
    name: 'Root page loads',
    method: 'GET',
    path: '/',
    expectedStatus: 200,
    auth: false,
  },
  {
    name: 'Auth required on v2/board',
    method: 'GET',
    path: '/api/v2/board',
    expectedStatus: 401,
    auth: false,
  },

  // ── Authenticated reads ──
  {
    name: 'GET /api/v2/board',
    method: 'GET',
    path: '/api/v2/board',
    expectedStatus: 200,
    auth: true,
    validate: (b) => b?.data?.channels ? null : 'missing data.channels',
  },
  {
    name: 'GET /api/v2/channels',
    method: 'GET',
    path: '/api/v2/channels',
    expectedStatus: 200,
    auth: true,
    validate: (b) => b?.data?.channels ? null : 'missing data.channels',
  },
  {
    name: 'GET /api/v2/messages',
    method: 'GET',
    path: '/api/v2/messages?channel=general&limit=1',
    expectedStatus: 200,
    auth: true,
    validate: (b) => b?.data?.messages ? null : 'missing data.messages',
  },
  {
    name: 'GET /api/v2/search',
    method: 'GET',
    path: '/api/v2/search?q=test',
    expectedStatus: 200,
    auth: true,
    validate: (b) => b?.data?.results ? null : 'missing data.results',
  },
  {
    name: 'GET /api/v2/mentions',
    method: 'GET',
    path: '/api/v2/mentions?unread=false&limit=1',
    expectedStatus: 200,
    auth: true,
    validate: (b) => b?.data?.mentions ? null : 'missing data.mentions',
  },
  {
    name: 'GET /api/v2/gossip (status)',
    method: 'GET',
    path: '/api/v2/gossip',
    expectedStatus: 200,
    auth: true,
    validate: (b) => b?.data?.instance !== undefined ? null : 'missing data.instance',
  },
  {
    name: 'GET /api/v2/gossip/peers',
    method: 'GET',
    path: '/api/v2/gossip/peers',
    expectedStatus: 200,
    auth: true,
    validate: (b) => b?.data?.peers ? null : 'missing data.peers',
  },

  // ── Authenticated writes (send to a dedicated smoke-test channel) ──
  {
    name: 'POST /api/v2/messages (send)',
    method: 'POST',
    path: '/api/v2/messages',
    body: { channel: 'smoke-test', content: `Smoke test ${new Date().toISOString()}` },
    expectedStatus: [200, 201],
    auth: true,
    validate: (b) => b?.data?.message?.id ? null : 'missing data.message.id',
  },
  {
    // Targets a REAL agent (this one). The previous version addressed
    // 'smoke-test-target', which does not exist — and passed, because a DM to a
    // nonexistent agent used to succeed silently: the message was posted with
    // an @mention nobody matched, so no mention row was created and nothing was
    // ever delivered. The test was asserting the bug.
    name: 'POST /api/v2/dm (send DM)',
    method: 'POST',
    path: '/api/v2/dm',
    body: { target_agent: SELF_AGENT, content: 'Smoke test DM' },
    expectedStatus: [200, 201],
    auth: true,
    validate: (b) => b?.data?.message ? null : 'missing data.message',
  },

  // ── Validation checks (should return 400) ──
  {
    // Guards the fix above: silent loss on the one endpoint whose entire
    // purpose is reaching a specific agent is worse than an error.
    name: 'POST /api/v2/dm rejects an unknown target',
    method: 'POST',
    path: '/api/v2/dm',
    body: { target_agent: 'no-such-agent-smoke', content: 'should not send' },
    expectedStatus: 404,
    auth: true,
  },
  {
    name: 'POST /api/v2/messages rejects empty content',
    method: 'POST',
    path: '/api/v2/messages',
    body: { channel: 'smoke-test', content: '' },
    expectedStatus: 400,
    auth: true,
  },
  {
    name: 'POST /api/v2/messages rejects invalid channel',
    method: 'POST',
    path: '/api/v2/messages',
    body: { channel: 'INVALID!!!', content: 'test' },
    expectedStatus: 400,
    auth: true,
  },
  {
    name: 'GET /api/v2/channels rejects invalid type',
    method: 'GET',
    path: '/api/v2/channels?type=bogus',
    expectedStatus: 400,
    auth: true,
  },

  // ── File API checks ──
  {
    name: 'PUT /api/files (upload)',
    method: 'PUT',
    path: '/api/files',
    body: { filename: 'smoke-test.txt', content: 'smoke', channel: 'smoke-test', post_message: false },
    expectedStatus: [200, 500], // 500 acceptable if storage not configured
    auth: true,
  },
  {
    name: 'GET /api/files rejects path traversal',
    method: 'GET',
    path: '/api/files?path=../../../etc/passwd',
    expectedStatus: 400,
    auth: true,
  },
  ];
}

// ── Runner ────────────────────────────────────────────────────────────────

async function runCheck(check: Check): Promise<{ pass: boolean; detail: string }> {
  const url = `${WEB_URL}${check.path}`;
  const headers: Record<string, string> = {};
  const init: RequestInit = { method: check.method, headers, signal: AbortSignal.timeout(15000) };

  if (check.auth && API_KEY) {
    headers['x-agent-api-key'] = API_KEY;
  }
  if (check.body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(check.body);
  }

  try {
    const res = await fetch(url, init);
    const expected = Array.isArray(check.expectedStatus) ? check.expectedStatus : [check.expectedStatus];

    if (!expected.includes(res.status)) {
      return { pass: false, detail: `expected ${expected.join('|')}, got ${res.status}` };
    }

    if (check.validate && expected.includes(res.status) && res.status >= 200 && res.status < 300) {
      try {
        const body = await res.json();
        const err = check.validate(body);
        if (err) return { pass: false, detail: `validation failed: ${err}` };
      } catch {
        return { pass: false, detail: 'failed to parse response JSON' };
      }
    }

    return { pass: true, detail: `${res.status} OK` };
  } catch (e: any) {
    return { pass: false, detail: `fetch error: ${e.message}` };
  }
}

async function main() {
  await selectAgentKey();
  const checks = buildChecks();

  console.log(`\nSmoke testing: ${WEB_URL}\n`);

  if (!API_KEY) {
    console.warn('WARNING: No agent key found — skipping authenticated checks\n');
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const check of checks) {
    if (check.auth && !API_KEY) {
      console.log(`  SKIP  ${check.name}`);
      skipped++;
      continue;
    }

    const result = await runCheck(check);
    if (result.pass) {
      console.log(`  PASS  ${check.name}`);
      passed++;
    } else {
      console.log(`  FAIL  ${check.name} — ${result.detail}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (${checks.length} total)\n`);

  if (failed > 0) {
    console.error('SMOKE TEST FAILED');
    process.exit(1);
  } else {
    console.log('SMOKE TEST PASSED');
  }
}

main();

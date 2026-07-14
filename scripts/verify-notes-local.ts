#!/usr/bin/env npx tsx
/**
 * End-to-end runtime verification of the knowledge layer (Phases 1 + 1.5)
 * against a LOCAL Supabase stack + local Next.js dev server. Never run
 * against production.
 *
 * Usage:
 *   WEB_URL=http://localhost:3111 \
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   npx tsx scripts/verify-notes-local.ts
 */

import { createClient } from '@supabase/supabase-js';
import { generateKeypair, hashKey, generateDerivedKey } from '../packages/shared/src/crypto.js';
import { AirChatRestClient } from '../packages/shared/src/rest-client.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WEB_URL = process.env.WEB_URL!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!WEB_URL || !SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('Missing env: WEB_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!SUPABASE_URL.includes('127.0.0.1') && !SUPABASE_URL.includes('localhost')) {
  console.error('Refusing to run against a non-local Supabase URL');
  process.exit(1);
}

const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Unwrap the v2 jsonResponse boundary envelope ({_airchat, _notice, data}). */
function un(r: any): any {
  return r?.data ?? r;
}

async function expectError(name: string, fn: () => Promise<unknown>, needle: string) {
  try {
    await fn();
    check(name, false, 'expected an error, got success');
  } catch (e: any) {
    check(name, String(e?.message ?? e).includes(needle), `got: ${e?.message}`);
  }
}

async function main() {
  console.log('\n── Setup: register test machine ──');
  const { publicKey, privateKey } = generateKeypair();
  const machineName = `verifytest${Date.now() % 100000}`;
  const { error: mkErr } = await service.from('machine_keys').insert({
    machine_name: machineName, public_key: publicKey, active: true,
    // key_hash is the legacy pre-00008 column, still NOT NULL
    key_hash: hashKey(generateDerivedKey()),
  });
  check('machine_keys insert', !mkErr, mkErr?.message);

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-verify-'));
  const mkClient = (project: string) => new AirChatRestClient({
    webUrl: WEB_URL, machineName, privateKeyHex: privateKey,
    agentName: `${machineName}-${project}`, cacheDir,
  });
  const agentA = mkClient('proja');
  const agentB = mkClient('projb');
  const RUN = String(Date.now() % 100000);
  const CH = `project-verify-${RUN}`;

  console.log('\n── Phase 1: agent flows ──');

  // Write a note with channel-scoped and global wiki-links
  const w1 = un(await agentA.writeNote({
    channel: CH, slug: 'deploy-runbook', title: 'Deploy Runbook',
    body_md: `# Steps\n\nSee [[db-schema]] and [[global/agent-directory-${RUN}]].\n\n1. Build\n2. Ship`,
  }));
  check('write_note creates rev 1', w1?.note?.current_revision === 1, JSON.stringify(w1));

  const r1 = un(await agentA.readNote(CH, 'deploy-runbook'));
  check('read_note round-trip', r1?.note?.body_md?.includes('[[db-schema]]'));
  check('recent_revisions attached', Array.isArray(r1?.recent_revisions) && r1.recent_revisions.length === 1);

  // Note-side links created stubs
  const stub = un(await agentA.readNote(CH, 'db-schema'));
  check('channel-scoped stub created', stub?.note?.is_stub === true);
  const gstub = un(await agentA.readNote(null, `agent-directory-${RUN}`));
  check('global stub created', gstub?.note?.is_stub === true);

  // Message-side links: recorded as backlinks, never stubs
  await agentA.sendMessage(CH, 'Deploying now per [[deploy-runbook]], also see [[never-a-note]]');
  const bl = un(await agentA.getNoteBacklinks(CH, 'deploy-runbook'));
  check('message backlink recorded', bl?.backlinks?.some((b: any) => b.source_type === 'message'));
  const noStub = await agentA.readNote(CH, 'never-a-note').catch(() => null);
  check('message link did NOT create stub', noStub === null);

  // Backlinks of the stub include the linking note
  const bl2 = un(await agentA.getNoteBacklinks(CH, 'db-schema'));
  check('note backlink recorded', bl2?.backlinks?.some((b: any) => b.source_type === 'note' && b.source_label === 'deploy-runbook'));

  // Second agent edits (upsert), then optimistic concurrency conflict
  const w2 = un(await agentB.writeNote({
    channel: CH, slug: 'deploy-runbook', title: 'Deploy Runbook',
    body_md: 'Updated by B. See [[db-schema]].', expected_revision: 1,
  }));
  check('cross-agent update to rev 2', w2?.note?.current_revision === 2);
  await expectError('stale expected_revision rejected (409)', () => agentA.writeNote({
    channel: CH, slug: 'deploy-runbook', title: 'x', body_md: 'stale write', expected_revision: 1,
  }), '409');

  // Historical revision read
  const rv = un(await agentA.readNote(CH, 'deploy-runbook', 1));
  check('historical revision readable',
    rv?.revision_body?.body_md?.includes('Steps') && rv?.note?.current_revision === 2,
    JSON.stringify(rv)?.slice(0, 200));

  // Protected notes
  await agentA.writeNote({ channel: CH, slug: 'canonical-runbook', title: 'Canonical', body_md: 'protected content', protect: true });
  await expectError('protected note rejects other agents (403)', () => agentB.writeNote({
    channel: CH, slug: 'canonical-runbook', title: 'hijack', body_md: 'rewrite',
  }), '403');

  // Stub fill via write
  const fill = un(await agentB.writeNote({ channel: CH, slug: 'db-schema', title: 'DB Schema', body_md: 'Tables: notes, messages' }));
  check('stub filled (is_stub cleared)', fill?.note?.is_stub === false && fill?.note?.current_revision >= 1);

  // List + FTS
  const list = un(await agentA.listNotes({ channel: CH }));
  check('list_notes returns notes', Array.isArray(list?.notes) && list.notes.length >= 3, JSON.stringify(list)?.slice(0, 200));
  const fts = un(await agentA.listNotes({ channel: CH, query: 'protected content' }));
  check('FTS search finds note', fts?.notes?.some((n: any) => n.slug === 'canonical-runbook'), JSON.stringify(fts)?.slice(0, 200));

  // Informational: pre-existing search_messages RPC behavior via v2 API
  const msgSearch = un(await agentA.searchMessages('Deploying'));
  console.log(`  INFO  search_messages via v2 API returned ${msgSearch?.results?.length ?? 0} results (pre-existing RPC scoping question)`);

  // Federated channels rejected
  await expectError('notes rejected on gossip channels', () => agentA.writeNote({
    channel: 'gossip-test', slug: 'x', title: 'x', body_md: 'x',
  }), '400');

  console.log('\n── RLS: anon key sees nothing ──');
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  for (const table of ['notes', 'note_revisions', 'note_links']) {
    const { data, error } = await anon.from(table).select('*').limit(5);
    check(`anon blocked from ${table}`, !error && (data?.length ?? 0) === 0, error?.message ?? `got ${data?.length} rows`);
  }

  console.log('\n── Phase 1.5: human edit path ──');
  const email = `verify-${Date.now()}@example.com`;
  const password = 'verify-test-password-1';
  const { data: created, error: userErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  check('auth user created', !userErr && !!created?.user, userErr?.message);

  const authClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: signin, error: signinErr } = await authClient.auth.signInWithPassword({ email, password });
  check('password sign-in', !signinErr && !!signin?.session, signinErr?.message);

  // Build the @supabase/ssr cookie the server route reads
  const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(signin!.session)).toString('base64url');
  const cookieName = `sb-${ref}-auth-token`;
  const chunks: string[] = [];
  const CHUNK = 3180;
  if (cookieValue.length <= CHUNK) {
    chunks.push(`${cookieName}=${cookieValue}`);
  } else {
    for (let i = 0; i * CHUNK < cookieValue.length; i++) {
      chunks.push(`${cookieName}.${i}=${cookieValue.slice(i * CHUNK, (i + 1) * CHUNK)}`);
    }
  }
  const cookieHeader = chunks.join('; ');

  const { data: chRow } = await service.from('channels').select('id').eq('name', CH).single();
  const current = un(await agentA.readNote(CH, 'deploy-runbook'));

  const humanRes = await fetch(`${WEB_URL}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({
      channel_id: chRow!.id, slug: 'deploy-runbook', title: 'Deploy Runbook (human reviewed)',
      body_md: 'Human-reviewed. See [[db-schema]].', expected_revision: current?.note?.current_revision,
    }),
  });
  const humanBody: any = await humanRes.json().catch(() => ({}));
  check('human edit accepted', humanRes.ok, `HTTP ${humanRes.status}: ${JSON.stringify(humanBody)}`);
  check('human attribution set', humanBody?.note?.updated_by === null && humanBody?.note?.updated_by_user_email === email);

  const humanConflict = await fetch(`${WEB_URL}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ channel_id: chRow!.id, slug: 'deploy-runbook', title: 'x', body_md: 'stale', expected_revision: current?.note?.current_revision }),
  });
  check('human stale edit rejected (409)', humanConflict.status === 409);

  const unauth = await fetch(`${WEB_URL}/api/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_id: chRow!.id, slug: 'deploy-runbook', title: 'x', body_md: 'x', expected_revision: 1 }),
  });
  check('unauthenticated human edit rejected (401)', unauth.status === 401);

  // Agents see the human author in revision history
  const afterHuman = un(await agentA.readNote(CH, 'deploy-runbook'));
  check('agent sees human revision author',
    afterHuman?.recent_revisions?.some((r: any) => String(r.author_name).includes(email)),
    JSON.stringify(afterHuman?.recent_revisions)?.slice(0, 200));

  // XOR constraint holds at the DB level
  const { data: noteRow } = await service.from('notes').select('id').eq('slug', 'deploy-runbook').eq('channel_id', chRow!.id).single();
  const { error: xorErr } = await service.from('note_revisions').insert({
    note_id: noteRow!.id, revision: 999, title: 'x', body_md: 'x', properties: {},
    author_agent_id: null, author_user: null,
  });
  check('XOR constraint rejects author-less revision', !!xorErr && xorErr.message.includes('note_revisions_single_author'), xorErr?.message);

  console.log(`\n${'─'.repeat(40)}\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

import { readFileSync } from 'node:fs';
import type { AirChatRestClient } from '@airchat/shared/rest-client';

// A note's scope on the CLI is a channel name or the literal "global".
function parseScope(scope: string): string | null {
  if (scope === 'global') return null;
  if (!/^[a-z0-9][a-z0-9-]{1,99}$/.test(scope)) {
    console.error(`Invalid scope "${scope}". Use a channel name (e.g. project-airchat) or "global".`);
    process.exit(1);
  }
  return scope;
}

// Body for write-note: --body, --body-file, or piped stdin (in that order).
function resolveBody(opts: { body?: string; bodyFile?: string }): string {
  if (opts.body !== undefined) return opts.body;
  if (opts.bodyFile) return readFileSync(opts.bodyFile, 'utf8');
  if (!process.stdin.isTTY) {
    try { return readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  }
  return '';
}

export async function notesList(
  client: AirChatRestClient,
  channel: string | undefined,
  opts: { search?: string; stubs?: boolean; limit?: string },
) {
  const res = await client.listNotes({
    channel,
    query: opts.search,
    include_stubs: opts.stubs,
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
  }) as { notes?: Array<{ slug: string; title: string; channel_name: string | null; is_stub?: boolean; protected?: boolean; current_revision?: number; updated_at: string }> };

  const notes = res.notes ?? [];
  const where = channel ? `#${channel}` : 'all channels + global';
  console.log(`\n📓 Notes (${notes.length}) — ${where}\n`);
  for (const n of notes) {
    const scope = n.channel_name ? `#${n.channel_name}` : 'global';
    const tags = [n.protected ? 'protected' : '', n.is_stub ? 'stub' : ''].filter(Boolean).join(', ');
    console.log(`  ${n.title}${tags ? `  [${tags}]` : ''}`);
    console.log(`    ${scope}/${n.slug}${n.current_revision ? ` · rev ${n.current_revision}` : ''} · updated ${new Date(n.updated_at).toLocaleString()}`);
  }
  if (notes.length === 0) console.log('  (none)');
  console.log('');
}

export async function noteRead(
  client: AirChatRestClient,
  scope: string,
  slug: string,
  opts: { revision?: string },
) {
  const channel = parseScope(scope);
  const revision = opts.revision ? parseInt(opts.revision, 10) : undefined;
  const res = await client.readNote(channel, slug, revision) as {
    note?: { title: string; body_md: string; current_revision: number; protected?: boolean; is_stub?: boolean; updated_at?: string };
    revision_body?: { title: string; body_md: string; revision: number };
  };
  if (!res.note) {
    console.error(`Note ${scope}/${slug} not found.`);
    process.exit(1);
  }
  const title = res.revision_body?.title ?? res.note.title;
  const body = res.revision_body?.body_md ?? res.note.body_md;
  const rev = res.revision_body?.revision ?? res.note.current_revision;
  console.log(`\n# ${title}`);
  console.log(`${scope}/${slug} · rev ${rev}${res.note.protected ? ' · protected' : ''}${res.note.is_stub ? ' · stub' : ''}\n`);
  console.log(res.note.is_stub && !body ? '(empty stub)' : body);
  console.log('');
}

export async function noteWrite(
  client: AirChatRestClient,
  scope: string,
  slug: string,
  opts: { title?: string; body?: string; bodyFile?: string; protect?: boolean; expectedRevision?: string },
) {
  const channel = parseScope(scope);
  const body_md = resolveBody(opts);
  const res = await client.writeNote({
    channel,
    slug,
    title: opts.title ?? slug,
    body_md,
    protect: opts.protect,
    expected_revision: opts.expectedRevision ? parseInt(opts.expectedRevision, 10) : undefined,
  }) as { note?: { current_revision: number } };
  console.log(`✅ Wrote ${scope}/${slug}${res.note ? ` (rev ${res.note.current_revision})` : ''}`);
}

export async function noteBacklinks(client: AirChatRestClient, scope: string, slug: string) {
  const channel = parseScope(scope);
  const res = await client.getNoteBacklinks(channel, slug) as {
    backlinks?: Array<{ source_type: string; source_label?: string; channel_name?: string | null }>;
  };
  const links = res.backlinks ?? [];
  console.log(`\n🔗 Backlinks to ${scope}/${slug} (${links.length})\n`);
  for (const l of links) {
    const where = l.channel_name ? `#${l.channel_name}` : 'global';
    console.log(`  [${l.source_type}] ${l.source_label ?? ''} (${where})`);
  }
  if (links.length === 0) console.log('  (nothing links here yet)');
  console.log('');
}

export async function summarize(
  client: AirChatRestClient,
  channel: string,
  opts: { kind?: string; window?: string },
) {
  const kind = opts.kind === 'project' ? 'project' : 'activity';
  const windowDays = opts.window ? parseInt(opts.window, 10) : undefined;
  console.log(`Summarizing #${channel} (${kind})…`);
  const res = await client.summarizeChannel(channel, windowDays, kind) as {
    summary?: { slug?: string; title?: string; body_md?: string };
  };
  const s = res.summary;
  if (s?.title) console.log(`\n# ${s.title}${s.slug ? `  (${s.slug})` : ''}\n`);
  if (s?.body_md) console.log(s.body_md);
  else console.log('✅ Summary requested. View it in the channel notes.');
  console.log('');
}

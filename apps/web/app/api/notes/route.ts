import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseClient, isDashboardAdmin, resolveDashboardAdminAgent } from '@/lib/api-v2-auth';
import { extractWikiLinks } from '@airchat/shared';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 300;
const MAX_BODY_LENGTH = 100_000;

// Rebuild a note's outgoing [[wiki-links]] from its body. Global links target
// the null scope, channel-qualified links resolve the channel by name, and
// bare links stay in the note's own scope. No stub creation on the human path.
async function syncOutgoingLinks(
  service: SupabaseClient,
  note: { id: string; channel_id: string | null; body_md: string },
): Promise<void> {
  const links = extractWikiLinks(note.body_md);
  await service.from('note_links').delete().eq('source_type', 'note').eq('source_id', note.id);
  if (!links.length) return;
  const rows = [];
  for (const link of links) {
    let targetScope: string | null | undefined;
    if (link.global) {
      targetScope = null;
    } else if (link.channel) {
      const { data: ch } = await service.from('channels').select('id').eq('name', link.channel).single();
      targetScope = ch?.id ?? undefined;
      if (targetScope === undefined) continue;
    } else {
      targetScope = note.channel_id;
    }
    rows.push({ source_type: 'note', source_id: note.id, target_channel_id: targetScope, target_slug: link.slug });
  }
  if (rows.length) {
    await service
      .from('note_links')
      .upsert(rows, { onConflict: 'source_type,source_id,target_channel_id,target_slug', ignoreDuplicates: true });
  }
}

// POST /api/notes — human (dashboard) note editing and creation.
//
// Attribution is the typed union from migration 00017: human edits set
// updated_by_user (+ email for display) and leave updated_by null. Identity
// comes from the verified Supabase session, never from the request body.
// Humans are dashboard admins, so they may edit protected notes (operator
// override).
//
// With `create: true`, a human can also create a new note (used by the wiki to
// add standalone/global notes). notes.created_by references an agent, so
// created_by is set to the `dashboard-admin` agent while the human identity is
// captured on the revision via author_user. Edits to a missing note still 404.
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await isDashboardAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: {
    channel_id?: string | null;
    slug: string;
    title: string;
    body_md: string;
    expected_revision?: number;
    create?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { channel_id, slug, title, body_md, expected_revision, create } = body;

  if (!slug || !SLUG_RE.test(slug)) {
    return NextResponse.json({ error: 'Valid slug required' }, { status: 400 });
  }
  if (channel_id && !UUID_RE.test(channel_id)) {
    return NextResponse.json({ error: 'Invalid channel_id (expected UUID)' }, { status: 400 });
  }
  if (!title?.trim() || title.length > MAX_TITLE_LENGTH) {
    return NextResponse.json({ error: `Title required (max ${MAX_TITLE_LENGTH} chars)` }, { status: 400 });
  }
  if (typeof body_md !== 'string' || body_md.length > MAX_BODY_LENGTH) {
    return NextResponse.json({ error: `body_md required (max ${MAX_BODY_LENGTH} chars)` }, { status: 400 });
  }
  if (!create && (!Number.isInteger(expected_revision) || (expected_revision ?? 0) < 1)) {
    return NextResponse.json({ error: 'expected_revision required (positive integer)' }, { status: 400 });
  }

  const service = getSupabaseClient();

  // Locate the note in its scope
  let noteQuery = service.from('notes').select('*').eq('slug', slug);
  noteQuery = channel_id ? noteQuery.eq('channel_id', channel_id) : noteQuery.is('channel_id', null);
  const { data: note } = await noteQuery.single();

  // Create path: a human adds a new note (wiki). Attributed to dashboard-admin
  // for created_by; the human is captured on the revision via author_user.
  if (!note) {
    if (!create) {
      return NextResponse.json({ error: 'Note not found (edits require an existing note)' }, { status: 404 });
    }
    const admin = await resolveDashboardAdminAgent();
    if (!admin) {
      return NextResponse.json({ error: 'Note authoring is not provisioned' }, { status: 500 });
    }
    const { data: createdNote, error: createErr } = await service
      .from('notes')
      .insert({
        channel_id: channel_id ?? null,
        slug,
        title: title.trim(),
        body_md,
        created_by: admin.id,
        updated_by: null,
        updated_by_user: user.id,
        updated_by_user_email: user.email ?? null,
        is_stub: false,
        current_revision: 1,
      })
      .select('*')
      .single();

    if (createErr || !createdNote) {
      // Unique (scope, slug) collision → someone created it first.
      return NextResponse.json(
        { error: 'A note with that slug already exists in this scope. Reload and edit it instead.' },
        { status: 409 },
      );
    }

    await service.from('note_revisions').insert({
      note_id: createdNote.id,
      revision: 1,
      title: createdNote.title,
      body_md: createdNote.body_md,
      properties: createdNote.properties,
      author_agent_id: null,
      author_user: user.id,
      author_user_email: user.email ?? null,
    });

    await syncOutgoingLinks(service, createdNote);

    return NextResponse.json({ note: createdNote });
  }

  if (note.current_revision !== expected_revision) {
    return NextResponse.json(
      { error: `Conflict: note is at revision ${note.current_revision}, you edited revision ${expected_revision}. Reload and retry.` },
      { status: 409 }
    );
  }

  // Conditional update on current_revision avoids a read-then-write race
  const { data: updated, error: updateErr } = await service
    .from('notes')
    .update({
      title: title.trim(),
      body_md,
      updated_by: null,
      updated_by_user: user.id,
      updated_by_user_email: user.email ?? null,
      updated_at: new Date().toISOString(),
      is_stub: false,
      current_revision: note.current_revision + 1,
    })
    .eq('id', note.id)
    .eq('current_revision', note.current_revision)
    .select('*')
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      { error: 'Conflict: note was modified concurrently. Reload and retry.' },
      { status: 409 }
    );
  }

  await service.from('note_revisions').insert({
    note_id: updated.id,
    revision: updated.current_revision,
    title: updated.title,
    body_md: updated.body_md,
    properties: updated.properties,
    author_agent_id: null,
    author_user: user.id,
    author_user_email: user.email ?? null,
  });

  await syncOutgoingLinks(service, updated);

  return NextResponse.json({ note: updated });
}

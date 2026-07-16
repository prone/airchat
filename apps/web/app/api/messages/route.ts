import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase-server';
import { DASHBOARD_ADMIN_AGENT } from '@airchat/shared';
import { getStorageAdapter, getSupabaseClient, isDashboardAdmin } from '@/lib/api-v2-auth';

// POST /api/messages — send a message from the dashboard as `dashboard-admin`.
//
// Uses the service-role storage adapter (same path as the digest worker and
// /api/notes) rather than the legacy agent-API-key flow, which no longer works
// under v2 auth (the dashboard-admin agent has no key hash). Session-auth +
// admin-gated: the dashboard is admin-only.
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(await isDashboardAdmin(user.id))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let channel: string, content: string, parent_message_id: string | undefined;
  try {
    const body = await request.json();
    channel = body.channel;
    content = body.content;
    parent_message_id = body.parent_message_id;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!channel || !content?.trim()) {
    return NextResponse.json({ error: 'Channel and content are required' }, { status: 400 });
  }
  if (!/^[a-z0-9][a-z0-9-]{1,99}$/.test(channel)) {
    return NextResponse.json({ error: 'Invalid channel name' }, { status: 400 });
  }
  if (content.length > 32000) {
    return NextResponse.json({ error: 'Content too long (max 32000 chars)' }, { status: 400 });
  }

  // Resolve (or provision) the dashboard-admin agent — the author of
  // dashboard messages. It has no key hash; it's service-role only.
  const svc = getSupabaseClient();
  let admin: { id: string; name: string } | null = null;
  const { data: existing } = await svc.from('agents').select('id, name').eq('name', DASHBOARD_ADMIN_AGENT).single();
  if (existing) {
    admin = existing;
  } else {
    const { data: created, error: createErr } = await svc
      .from('agents')
      .insert({ name: DASHBOARD_ADMIN_AGENT, description: 'Dashboard message author. Not machine-owned.', api_key_hash: null, active: true })
      .select('id, name')
      .single();
    if (createErr || !created) {
      // Lost a race, or insert failed — re-read
      const { data: reread } = await svc.from('agents').select('id, name').eq('name', DASHBOARD_ADMIN_AGENT).single();
      admin = reread ?? null;
    } else {
      admin = created;
    }
  }
  if (!admin) {
    return NextResponse.json({ error: 'Dashboard messaging is not provisioned' }, { status: 500 });
  }

  try {
    const scoped = getStorageAdapter().forAgent({ agentId: admin.id, agentName: admin.name, machineId: '' });
    const message = await scoped.sendMessage(
      channel,
      content.trim(),
      { source: 'dashboard', user_email: user.email ?? undefined },
      parent_message_id,
    );
    return NextResponse.json({ message });
  } catch (e) {
    console.error('Failed to send message:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}

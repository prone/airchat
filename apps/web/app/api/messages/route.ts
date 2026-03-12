import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServer, createSupabaseAdmin } from '@/lib/supabase-server';

export async function POST(request: NextRequest) {
  // Verify the caller is authenticated
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { channel, content, parent_message_id } = await request.json();

  if (!channel || !content?.trim()) {
    return NextResponse.json({ error: 'Channel and content are required' }, { status: 400 });
  }

  const admin = createSupabaseAdmin();

  // Ensure a dashboard-admin agent exists for human messages
  const agentName = 'dashboard-admin';
  const { data: agent } = await admin
    .from('agents')
    .select('id')
    .eq('name', agentName)
    .single();

  let agentId = agent?.id;

  if (!agentId) {
    const { data: newAgent, error: createErr } = await admin
      .from('agents')
      .insert({ name: agentName, description: 'Human messages from the web dashboard', active: true })
      .select('id')
      .single();

    if (createErr) {
      return NextResponse.json({ error: 'Failed to create dashboard agent' }, { status: 500 });
    }
    agentId = newAgent.id;
  }

  // Get or create the channel
  let { data: ch } = await admin
    .from('channels')
    .select('id')
    .eq('name', channel)
    .single();

  if (!ch) {
    const type = channel.startsWith('project-') ? 'project'
      : channel.startsWith('tech-') ? 'technology'
      : 'global';
    const { data: newCh, error: chErr } = await admin
      .from('channels')
      .insert({ name: channel, type, created_by: agentId })
      .select('id')
      .single();
    if (chErr) {
      return NextResponse.json({ error: 'Failed to find or create channel' }, { status: 400 });
    }
    ch = newCh;
  }

  // Ensure membership
  await admin
    .from('channel_memberships')
    .upsert({ agent_id: agentId, channel_id: ch.id }, { onConflict: 'agent_id,channel_id' });

  // Post the message with the user's email in metadata
  const { data: message, error: msgErr } = await admin
    .from('messages')
    .insert({
      channel_id: ch.id,
      author_agent_id: agentId,
      content: content.trim(),
      parent_message_id: parent_message_id || null,
      metadata: { source: 'dashboard', user_email: user.email },
    })
    .select('id, content, created_at')
    .single();

  if (msgErr) {
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }

  return NextResponse.json({ message });
}

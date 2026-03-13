import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';

export async function POST(request: NextRequest) {
  // Verify the caller is authenticated via Supabase Auth
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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

  // Use the machine key from ~/.agentchat/config (via env) to post as dashboard-admin
  // This avoids needing the service role key
  const agentApiKey = process.env.AGENTCHAT_API_KEY || process.env.SLACK_AGENT_API_KEY;
  if (!agentApiKey) {
    return NextResponse.json({ error: 'No AGENTCHAT_API_KEY configured for dashboard messaging' }, { status: 500 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 });
  }

  const agentClient = createClient(
    supabaseUrl,
    anonKey,
    {
      global: {
        headers: {
          'x-agent-api-key': agentApiKey,
          'x-agent-name': 'dashboard-admin',
        },
      },
    }
  );

  // Ensure the dashboard-admin agent exists
  const { error: regErr } = await agentClient.rpc('ensure_agent_exists', { p_agent_name: 'dashboard-admin' });
  if (regErr) {
    return NextResponse.json({ error: `Agent registration failed: ${regErr.message}` }, { status: 500 });
  }

  // Post via send_message_with_auto_join (handles channel creation, membership, and triggers)
  const { data, error: msgErr } = await agentClient.rpc('send_message_with_auto_join', {
    channel_name: channel,
    content: content.trim(),
    parent_message_id: parent_message_id || null,
    message_metadata: { source: 'dashboard', user_email: user.email },
  });

  if (msgErr) {
    return NextResponse.json({ error: `Failed to send: ${msgErr.message}` }, { status: 500 });
  }

  const message = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({ message });
}

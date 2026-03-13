import { NextRequest, NextResponse } from 'next/server';
// createSupabaseAdmin not needed — messages are sent via agent client
import crypto from 'crypto';

// Slack webhook endpoint: receives slash commands and posts messages to AgentChat
// Setup: Create a Slack app with a Slash Command pointing to /api/slack
//
// Slack sends: /agentchat @server-myproject check docker containers
// This endpoint: posts "@server-myproject check docker containers" to #direct-messages
//
// Environment variables:
//   SLACK_SIGNING_SECRET - Slack app signing secret for request verification
//   SLACK_AGENT_API_KEY  - AgentChat API key to post messages as

function verifySlackRequest(body: string, timestamp: string, signature: string, secret: string): boolean {
  const fiveMinutes = 5 * 60;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > fiveMinutes) return false;

  const sigBase = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
  const computed = `v0=${hmac}`;

  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

export async function POST(request: NextRequest) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const agentApiKey = process.env.SLACK_AGENT_API_KEY;

  if (!signingSecret || !agentApiKey) {
    return NextResponse.json({ text: 'Slack integration not configured.' }, { status: 500 });
  }

  // Read and verify the request
  const body = await request.text();
  const timestamp = request.headers.get('x-slack-request-timestamp') || '';
  const signature = request.headers.get('x-slack-signature') || '';

  if (!verifySlackRequest(body, timestamp, signature, signingSecret)) {
    return NextResponse.json({ text: 'Invalid signature.' }, { status: 401 });
  }

  // Parse the Slack slash command payload (URL-encoded form data)
  const params = new URLSearchParams(body);
  const text = params.get('text')?.trim() || '';
  const slackUser = params.get('user_name') || 'slack-user';

  if (!text) {
    return NextResponse.json({
      response_type: 'ephemeral',
      text: 'Usage: `/agentchat @agent-name your message here`\n\nExample: `/agentchat @server-myproject check docker containers`',
    });
  }

  // Determine channel and content
  // If the message starts with @agent-name, post to #direct-messages
  // Otherwise post to #general
  const mentionMatch = text.match(/^@([a-zA-Z0-9_-]+)\s+([\s\S]+)$/);
  const channel = mentionMatch ? 'direct-messages' : 'general';
  const content = mentionMatch
    ? `@${mentionMatch[1]} ${mentionMatch[2]} (via Slack from ${slackUser})`
    : `${text} (via Slack from ${slackUser})`;

  // Use the agent API key to resolve identity, then post via RPC
  // We need to call the RPC with the agent's API key in headers
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ text: 'Missing Supabase configuration.' }, { status: 500 });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const agentClient = createClient(
    supabaseUrl,
    anonKey,
    {
      global: {
        headers: {
          'x-agent-api-key': agentApiKey,
          'x-agent-name': 'slack-bridge',
        },
      },
    }
  );

  // Ensure the slack-bridge agent exists
  await agentClient.rpc('ensure_agent_exists', { p_agent_name: 'slack-bridge' });

  const { error } = await agentClient.rpc('send_message_with_auto_join', {
    channel_name: channel,
    content,
    parent_message_id: null,
    message_metadata: { source: 'slack', slack_user: slackUser },
  });

  if (error) {
    return NextResponse.json({
      response_type: 'ephemeral',
      text: `Failed to send: ${error.message}`,
    });
  }

  const target = mentionMatch ? mentionMatch[1] : null;
  return NextResponse.json({
    response_type: 'in_channel',
    text: target
      ? `Sent to @${target} in #${channel}. They'll be notified on their next prompt.`
      : `Posted to #${channel}.`,
  });
}

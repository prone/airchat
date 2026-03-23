import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createAgentClient } from '@airchat/shared/supabase';
import { DIRECT_MESSAGES_CHANNEL, SLACK_BRIDGE_AGENT, HUMAN_MESSAGES_CHANNEL } from '@airchat/shared';
import { ensureAgentRegistered } from '@/lib/api-auth';

// Slack slash command endpoint for AirChat (webhook mode, alternative to Socket Mode)
//
// Subcommands:
//   /airchat @agent-name message  — DM an agent via #direct-messages
//   /airchat #channel-name message — post to a specific channel
//   /airchat agents                — list registered agents
//   /airchat channels              — list channels
//   /airchat message               — post to #human-messages
//
// Environment variables:
//   SLACK_SIGNING_SECRET - Slack app signing secret for request verification
//   SLACK_AGENT_API_KEY  - AirChat API key to post messages as

const MAX_MESSAGE_LENGTH = 32000;
const MAX_CHANNEL_LENGTH = 100;

function verifySlackRequest(body: string, timestamp: string, signature: string, secret: string): boolean {
  if (!timestamp || !signature) return false;

  const fiveMinutes = 5 * 60;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > fiveMinutes) return false;

  const sigBase = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
  const computed = `v0=${hmac}`;

  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

function slackResponse(text: string, inChannel = false) {
  return NextResponse.json({
    response_type: inChannel ? 'in_channel' : 'ephemeral',
    text,
  });
}

export async function POST(request: NextRequest) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const agentApiKey = process.env.SLACK_AGENT_API_KEY;

  if (!signingSecret || !agentApiKey) {
    return NextResponse.json({ text: 'Slack integration not configured.' }, { status: 500 });
  }

  const body = await request.text();
  const timestamp = request.headers.get('x-slack-request-timestamp') || '';
  const signature = request.headers.get('x-slack-signature') || '';

  if (!verifySlackRequest(body, timestamp, signature, signingSecret)) {
    return NextResponse.json({ text: 'Invalid signature.' }, { status: 401 });
  }

  const params = new URLSearchParams(body);
  const text = params.get('text')?.trim() || '';
  const slackUserId = params.get('user_id') || 'unknown';
  const slackUser = params.get('user_name') || 'slack-user';

  if (!text) {
    return slackResponse(
      'Usage:\n' +
      '• `/airchat @agent-name message` — send to an agent\n' +
      '• `/airchat #channel-name message` — post to a channel\n' +
      '• `/airchat message` — post to #human-messages\n' +
      '• `/airchat agents` — list active agents\n' +
      '• `/airchat channels` — list channels'
    );
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    return slackResponse(`Message too long (max ${MAX_MESSAGE_LENGTH} chars).`);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ text: 'Missing Supabase configuration.' }, { status: 500 });
  }

  const agentClient = createAgentClient(supabaseUrl, anonKey, agentApiKey, SLACK_BRIDGE_AGENT);

  // --- Subcommand: agents ---
  if (text === 'agents') {
    const { data, error } = await agentClient
      .from('agents')
      .select('name, active, last_seen_at')
      .order('last_seen_at', { ascending: false, nullsFirst: false });

    if (error || !data) {
      return slackResponse('Failed to fetch agents.');
    }

    if (data.length === 0) {
      return slackResponse('No agents registered yet.');
    }

    const lines = data.map(a => {
      const status = a.active ? 'active' : 'inactive';
      const seen = a.last_seen_at
        ? `last seen ${new Date(a.last_seen_at).toLocaleDateString()}`
        : 'never seen';
      return `• \`${a.name}\` — ${status}, ${seen}`;
    });

    return slackResponse(`*AirChat Agents (${data.length}):*\n${lines.join('\n')}`);
  }

  // --- Subcommand: channels ---
  if (text === 'channels') {
    const { data, error } = await agentClient
      .from('channels')
      .select('name, created_at')
      .order('created_at', { ascending: false });

    if (error || !data) {
      return slackResponse('Failed to fetch channels.');
    }

    if (data.length === 0) {
      return slackResponse('No channels yet.');
    }

    const lines = data.map(c => `• \`#${c.name}\``);
    return slackResponse(`*AirChat Channels (${data.length}):*\n${lines.join('\n')}`);
  }

  // --- Message routing ---
  await ensureAgentRegistered(SLACK_BRIDGE_AGENT, agentApiKey);

  const mentionMatch = text.match(/^@([a-zA-Z0-9_-]+)\s+([\s\S]+)$/);
  const channelMatch = text.match(/^#([a-zA-Z0-9_-]+)\s+([\s\S]+)$/);

  let channel: string;
  let content: string;

  if (mentionMatch) {
    channel = DIRECT_MESSAGES_CHANNEL;
    const targetAgent = mentionMatch[1].slice(0, MAX_CHANNEL_LENGTH);
    // Strip @ from user message body to prevent mention injection
    const safeMessage = mentionMatch[2].replace(/(?<!\S)@(?=[a-zA-Z0-9_-])/g, '');
    content = `@${targetAgent} ${safeMessage}`;
  } else if (channelMatch) {
    channel = channelMatch[1].slice(0, MAX_CHANNEL_LENGTH);
    const safeMessage = channelMatch[2].replace(/(?<!\S)@(?=[a-zA-Z0-9_-])/g, '');
    content = safeMessage;
  } else {
    channel = HUMAN_MESSAGES_CHANNEL;
    content = text.replace(/(?<!\S)@(?=[a-zA-Z0-9_-])/g, '');
  }

  const { error } = await agentClient.rpc('send_message_with_auto_join', {
    channel_name: channel,
    content,
    parent_message_id: null,
    message_metadata: { source: 'slack', slack_user: slackUser, slack_user_id: slackUserId },
  });

  if (error) {
    return slackResponse('Failed to send message. Please try again.');
  }

  return slackResponse(
    mentionMatch
      ? `Sent to @${mentionMatch[1]} in #${channel}. They'll be notified on their next prompt.`
      : `Posted to #${channel}.`,
    true,
  );
}

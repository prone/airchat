#!/usr/bin/env node

/**
 * AirChat Slack Bridge — Socket Mode
 *
 * Connects Slack to a local AirChat instance via Slack's Socket Mode
 * (no public URL required). All messages stay local.
 *
 * Slash commands:
 *   /airchat @agent-name message  — DM an agent via #direct-messages
 *   /airchat #channel-name message — post to a specific channel
 *   /airchat agents                — list registered agents
 *   /airchat channels              — list channels
 *   /airchat message               — post to #human-messages
 *
 * Config (from ~/.airchat/config):
 *   SLACK_BOT_TOKEN    — xoxb-... bot token
 *   SLACK_APP_TOKEN    — xapp-... app-level token (for Socket Mode)
 *   AIRCHAT_WEB_URL    — local AirChat web server URL
 */

import { App } from '@slack/bolt';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AirChatRestClient } from '@airchat/shared/rest-client';
import {
  HUMAN_MESSAGES_CHANNEL,
  DIRECT_MESSAGES_CHANNEL,
  SLACK_BRIDGE_SUFFIX,
} from '@airchat/shared';

const MAX_MESSAGE_LENGTH = 32000;
const MAX_NAME_LENGTH = 100;

// ── Config ──────────────────────────────────────────────────────────────────

interface SlackBridgeConfig {
  slackBotToken: string;
  slackAppToken: string;
  slackWebhookUrl?: string;
  airchatWebUrl: string;
  machineName: string;
  privateKeyHex: string;
}

function loadConfig(): SlackBridgeConfig {
  const configPath = join(homedir(), '.airchat', 'config');
  let configVars: Record<string, string> = {};

  try {
    const text = readFileSync(configPath, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      configVars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    console.error('Missing ~/.airchat/config — run "npx airchat" to set up.');
    process.exit(1);
  }

  const slackBotToken = process.env.SLACK_BOT_TOKEN || configVars.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN || configVars.SLACK_APP_TOKEN;
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || configVars.SLACK_WEBHOOK_URL;
  const airchatWebUrl = process.env.AIRCHAT_WEB_URL || configVars.AIRCHAT_WEB_URL;
  const machineName = process.env.MACHINE_NAME || configVars.MACHINE_NAME;

  if (!slackBotToken || !slackAppToken) {
    console.error(
      'Missing Slack credentials. Add to ~/.airchat/config:\n' +
      '  SLACK_BOT_TOKEN=xoxb-...\n' +
      '  SLACK_APP_TOKEN=xapp-...\n\n' +
      'See: https://api.slack.com/apps → Create App → Socket Mode'
    );
    process.exit(1);
  }

  if (!airchatWebUrl) {
    console.error('Missing AIRCHAT_WEB_URL in ~/.airchat/config');
    process.exit(1);
  }

  if (!machineName) {
    console.error('Missing MACHINE_NAME in ~/.airchat/config');
    process.exit(1);
  }

  // Validate webhook URL if provided
  if (slackWebhookUrl && !slackWebhookUrl.startsWith('https://hooks.slack.com/')) {
    console.error('SLACK_WEBHOOK_URL must start with https://hooks.slack.com/');
    process.exit(1);
  }

  let privateKeyHex: string;
  try {
    privateKeyHex = readFileSync(join(homedir(), '.airchat', 'machine.key'), 'utf-8').trim();
  } catch {
    console.error('Missing ~/.airchat/machine.key — run "npx airchat" to set up.');
    process.exit(1);
  }

  return { slackBotToken, slackAppToken, slackWebhookUrl, airchatWebUrl, machineName, privateKeyHex };
}

// ── AirChat Client ──────────────────────────────────────────────────────────

function createAirChatClient(config: SlackBridgeConfig): AirChatRestClient {
  const agentName = `${config.machineName}-${SLACK_BRIDGE_SUFFIX}`;
  return new AirChatRestClient({
    webUrl: config.airchatWebUrl,
    machineName: config.machineName,
    privateKeyHex: config.privateKeyHex,
    agentName,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeSlackMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Agent Cache ─────────────────────────────────────────────────────────────

let _cachedAgents: { name: string; last_seen_at: string | null }[] = [];
let _agentCacheTime = 0;
const AGENT_CACHE_TTL = 30_000; // 30 seconds

async function getCachedAgents(client: AirChatRestClient): Promise<{ name: string; last_seen_at: string | null }[]> {
  if (Date.now() - _agentCacheTime < AGENT_CACHE_TTL && _cachedAgents.length > 0) {
    return _cachedAgents;
  }
  try {
    const result = await client.listAgents() as any;
    const allAgents = result?.data?.agents || result?.agents || [];
    _cachedAgents = allAgents.filter((a: any) =>
      !a.name.startsWith('nonce-test-') && a.last_seen_at
    );
    _agentCacheTime = Date.now();
  } catch (e: any) {
    console.error('[slack-bridge] Agent cache refresh failed:', e.message);
  }
  return _cachedAgents;
}

// ── Modal ───────────────────────────────────────────────────────────────────

function buildModal() {
  return {
    type: 'modal' as const,
    callback_id: 'airchat_send',
    title: { type: 'plain_text' as const, text: 'AirChat' },
    submit: { type: 'plain_text' as const, text: 'Send' },
    blocks: [
      {
        type: 'section' as const,
        text: { type: 'mrkdwn' as const, text: 'Send a message to an agent or channel.' },
      },
      {
        type: 'actions' as const,
        block_id: 'destination_type',
        elements: [
          {
            type: 'radio_buttons' as const,
            action_id: 'dest_type',
            initial_option: {
              text: { type: 'plain_text' as const, text: 'Agent' },
              value: 'agent',
            },
            options: [
              { text: { type: 'plain_text' as const, text: 'Agent' }, value: 'agent' },
              { text: { type: 'plain_text' as const, text: 'Channel' }, value: 'channel' },
              { text: { type: 'plain_text' as const, text: 'Everyone (#human-messages)' }, value: 'broadcast' },
            ],
          },
        ],
      },
      {
        type: 'input' as const,
        block_id: 'agent_select',
        optional: true,
        label: { type: 'plain_text' as const, text: 'Agent' },
        element: {
          type: 'external_select' as const,
          action_id: 'agent_name',
          placeholder: { type: 'plain_text' as const, text: 'Search agents...' },
          min_query_length: 0,
        },
      },
      {
        type: 'input' as const,
        block_id: 'channel_input',
        optional: true,
        label: { type: 'plain_text' as const, text: 'Channel' },
        element: {
          type: 'external_select' as const,
          action_id: 'channel_name',
          placeholder: { type: 'plain_text' as const, text: 'Search channels...' },
          min_query_length: 0,
        },
      },
      {
        type: 'input' as const,
        block_id: 'message_input',
        label: { type: 'plain_text' as const, text: 'Message' },
        element: {
          type: 'plain_text_input' as const,
          action_id: 'message_text',
          multiline: true,
          placeholder: { type: 'plain_text' as const, text: 'What do you want to say?' },
        },
      },
    ],
  };
}

// ── Slash Command Handler ───────────────────────────────────────────────────

async function handleSlashCommand(
  text: string,
  slackUser: string,
  slackUserId: string,
  client: AirChatRestClient,
): Promise<{ text: string; inChannel: boolean }> {

  if (text.length > MAX_MESSAGE_LENGTH) {
    return { text: `Message too long (max ${MAX_MESSAGE_LENGTH} chars).`, inChannel: false };
  }

  // Subcommand: agents
  if (text === 'agents') {
    try {
      const agents = await getCachedAgents(client);

      if (agents.length === 0) {
        return { text: 'No agents registered yet.', inChannel: false };
      }

      const lines = agents.map((a: any) => {
        const seen = a.last_seen_at
          ? `last seen ${new Date(a.last_seen_at).toLocaleDateString()}`
          : 'never seen';
        return `• \`${a.name}\` — ${seen}`;
      });

      return { text: `*AirChat Agents (${agents.length}):*\n${lines.join('\n')}`, inChannel: false };
    } catch (e: any) {
      return { text: 'Failed to fetch agents.', inChannel: false };
    }
  }

  // Subcommand: channels
  if (text === 'channels') {
    try {
      const result = await client.listChannels() as any;
      const channels = result?.data?.channels || result?.channels || [];

      if (!Array.isArray(channels) || channels.length === 0) {
        return { text: 'No channels yet.', inChannel: false };
      }

      const lines = channels.map((c: any) => `• \`#${c.name}\``);
      return { text: `*AirChat Channels (${channels.length}):*\n${lines.join('\n')}`, inChannel: false };
    } catch (e: any) {
      return { text: 'Failed to fetch channels.', inChannel: false };
    }
  }

  // Message routing
  const mentionMatch = text.match(/^@([a-zA-Z0-9_-]+)\s+([\s\S]+)$/);
  const channelMatch = text.match(/^#([a-zA-Z0-9_-]+)\s+([\s\S]+)$/);

  let channel: string;
  let content: string;

  if (mentionMatch) {
    channel = DIRECT_MESSAGES_CHANNEL;
    const targetAgent = mentionMatch[1].slice(0, MAX_NAME_LENGTH);
    // Strip @ from user message body to prevent mention injection
    const safeMessage = mentionMatch[2].replace(/(?<!\S)@(?=[a-zA-Z0-9_-])/g, '');
    content = `@${targetAgent} ${safeMessage}`;
  } else if (channelMatch) {
    channel = channelMatch[1].slice(0, MAX_NAME_LENGTH);
    const safeMessage = channelMatch[2].replace(/(?<!\S)@(?=[a-zA-Z0-9_-])/g, '');
    content = safeMessage;
  } else {
    channel = HUMAN_MESSAGES_CHANNEL;
    content = text.replace(/(?<!\S)@(?=[a-zA-Z0-9_-])/g, '');
  }

  try {
    await client.sendMessage(channel, content, undefined, {
      source: 'slack',
      slack_user: slackUser,
      slack_user_id: slackUserId,
    });

    const response = mentionMatch
      ? `Sent to @${mentionMatch[1]} in #${channel}. They'll be notified on their next prompt.`
      : `Posted to #${channel}.`;

    return { text: response, inChannel: true };
  } catch (e: any) {
    console.error('[slack-bridge] Send error:', e.message);
    return { text: 'Failed to send message. Please try again.', inChannel: false };
  }
}

// ── Message Forwarder (AirChat → Slack) ─────────────────────────────────────

function startForwarder(
  airchatClient: AirChatRestClient,
  webhookUrl: string,
  watchedChannels: string[],
): NodeJS.Timeout {
  let lastPollTime = new Date(Date.now() - 60_000).toISOString();

  const poll = async () => {
    try {
      for (const channel of watchedChannels) {
        const result = await airchatClient.readMessages(channel, 50) as any;
        const messages = result?.messages || [];

        for (const msg of messages) {
          const timestamp = msg.timestamp || msg.created_at;
          if (!timestamp || timestamp <= lastPollTime) continue;

          // Skip messages originating from Slack (metadata-based echo prevention)
          if (msg.project === 'slack' || msg.metadata?.source === 'slack') continue;

          const author = msg.author || msg.agents?.name || 'unknown';

          const mentionsHuman = /\b@human\b/i.test(msg.content);
          const prefix = mentionsHuman ? ':rotating_light: ' : '';
          const safeAuthor = escapeSlackMrkdwn(author);
          const safeContent = escapeSlackMrkdwn(msg.content);
          const slackText = `${prefix}*${safeAuthor}* in #${escapeSlackMrkdwn(channel)}:\n${safeContent}`;

          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: slackText }),
          });
        }
      }
    } catch (e: any) {
      console.error('[slack-bridge] Poll error:', e.message);
    }

    lastPollTime = new Date().toISOString();
  };

  poll(); // Initial poll
  return setInterval(poll, 30_000);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const airchatClient = createAirChatClient(config);

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  let pollInterval: NodeJS.Timeout | null = null;

  // Handle /airchat slash command
  app.command('/airchat', async ({ command, ack, respond, client }) => {
    await ack();

    const text = command.text?.trim() || '';
    const slackUser = command.user_name || 'slack-user';
    const slackUserId = command.user_id || 'unknown';

    // No text → open modal with agent/channel picker
    if (!text) {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: buildModal(),
      });
      return;
    }

    const result = await handleSlashCommand(text, slackUser, slackUserId, airchatClient);

    await respond({
      response_type: result.inChannel ? 'in_channel' : 'ephemeral',
      text: result.text,
    });
  });

  // Handle external_select options for agent picker
  app.options('agent_name', async ({ options, ack }) => {
    const query = (options.value || '').toLowerCase();
    const agents = await getCachedAgents(airchatClient);
    const filtered = agents
      .filter(a => a.name.toLowerCase().includes(query))
      .slice(0, 20)
      .map(a => ({
        text: { type: 'plain_text' as const, text: a.name },
        value: a.name,
      }));
    await ack({ options: filtered });
  });

  // Handle external_select options for channel picker
  app.options('channel_name', async ({ options, ack }) => {
    const query = (options.value || '').toLowerCase();
    try {
      const result = await airchatClient.listChannels() as any;
      const channels = result?.data?.channels || result?.channels || [];
      const filtered = channels
        .filter((c: any) => c.name.toLowerCase().includes(query))
        .slice(0, 20)
        .map((c: any) => ({
          text: { type: 'plain_text' as const, text: `#${c.name}` },
          value: c.name,
        }));
      await ack({ options: filtered });
    } catch {
      await ack({ options: [] });
    }
  });

  // Ignore radio button actions (Slack requires an action handler)
  app.action('dest_type', async ({ ack }) => { await ack(); });

  // Handle modal submission
  app.view('airchat_send', async ({ ack, view, body }) => {
    await ack();

    const values = view.state.values;
    const destType = values.destination_type?.dest_type?.selected_option?.value || 'broadcast';
    const agentName = values.agent_select?.agent_name?.selected_option?.value;
    const channelName = values.channel_input?.channel_name?.selected_option?.value;
    const messageText = values.message_input?.message_text?.value || '';
    const slackUser = body.user.name || body.user.id;
    const slackUserId = body.user.id;

    if (!messageText.trim()) return;
    if (messageText.length > MAX_MESSAGE_LENGTH) return;

    let channel: string;
    let content: string;
    // Strip @ from user content to prevent mention injection
    const safeMessage = messageText.replace(/(?<!\S)@(?=[a-zA-Z0-9_-])/g, '');

    if (destType === 'agent' && agentName) {
      channel = DIRECT_MESSAGES_CHANNEL;
      content = `@${agentName} ${safeMessage}`;
    } else if (destType === 'channel' && channelName) {
      channel = channelName;
      content = safeMessage;
    } else {
      channel = HUMAN_MESSAGES_CHANNEL;
      content = safeMessage;
    }

    try {
      await airchatClient.sendMessage(channel, content, undefined, {
        source: 'slack',
        slack_user: slackUser,
        slack_user_id: slackUserId,
      });
    } catch (e: any) {
      console.error('[slack-bridge] Modal send error:', e.message);
    }
  });

  // Start the Slack app
  await app.start();
  console.log('[slack-bridge] Connected to Slack (Socket Mode)');
  console.log(`[slack-bridge] AirChat: ${config.airchatWebUrl}`);

  // Start forwarding if webhook URL is configured
  if (config.slackWebhookUrl) {
    console.log('[slack-bridge] Forwarding AirChat → Slack enabled');
    pollInterval = startForwarder(airchatClient, config.slackWebhookUrl, [HUMAN_MESSAGES_CHANNEL]);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[slack-bridge] Shutting down...');
    if (pollInterval) clearInterval(pollInterval);
    await app.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[slack-bridge] Fatal:', err.message);
  process.exit(1);
});

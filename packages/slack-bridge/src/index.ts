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

const HUMAN_MESSAGES_CHANNEL = 'human-messages';
const DIRECT_MESSAGES_CHANNEL = 'direct-messages';
const BRIDGE_AGENT_SUFFIX = 'slack-bridge';

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
  const agentName = `${config.machineName}-${BRIDGE_AGENT_SUFFIX}`;
  return new AirChatRestClient({
    webUrl: config.airchatWebUrl,
    machineName: config.machineName,
    privateKeyHex: config.privateKeyHex,
    agentName,
  });
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
  } catch {}
  return _cachedAgents;
}

// ── Modal ───────────────────────────────────────────────────────────────────

function buildModal(): any {
  return {
    type: 'modal',
    callback_id: 'airchat_send',
    title: { type: 'plain_text', text: 'AirChat' },
    submit: { type: 'plain_text', text: 'Send' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Send a message to an agent or channel.' },
      },
      {
        type: 'actions',
        block_id: 'destination_type',
        elements: [
          {
            type: 'radio_buttons',
            action_id: 'dest_type',
            initial_option: {
              text: { type: 'plain_text', text: 'Agent' },
              value: 'agent',
            },
            options: [
              { text: { type: 'plain_text', text: 'Agent' }, value: 'agent' },
              { text: { type: 'plain_text', text: 'Channel' }, value: 'channel' },
              { text: { type: 'plain_text', text: 'Everyone (#human-messages)' }, value: 'broadcast' },
            ],
          },
        ],
      },
      {
        type: 'input',
        block_id: 'agent_select',
        optional: true,
        label: { type: 'plain_text', text: 'Agent' },
        element: {
          type: 'external_select',
          action_id: 'agent_name',
          placeholder: { type: 'plain_text', text: 'Search agents...' },
          min_query_length: 0,
        },
      },
      {
        type: 'input',
        block_id: 'channel_input',
        optional: true,
        label: { type: 'plain_text', text: 'Channel' },
        element: {
          type: 'external_select',
          action_id: 'channel_name',
          placeholder: { type: 'plain_text', text: 'Search channels...' },
          min_query_length: 0,
        },
      },
      {
        type: 'input',
        block_id: 'message_input',
        label: { type: 'plain_text', text: 'Message' },
        element: {
          type: 'plain_text_input',
          action_id: 'message_text',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'What do you want to say?' },
        },
      },
    ],
  };
}

// ── Slash Command Handler ───────────────────────────────────────────────────

async function handleSlashCommand(
  text: string,
  slackUser: string,
  client: AirChatRestClient,
): Promise<{ text: string; inChannel: boolean }> {

  // Subcommand: agents
  if (text === 'agents') {
    try {
      const result = await client.listAgents() as any;
      const allAgents = result?.data?.agents || result?.agents || [];
      const agents = allAgents.filter((a: any) =>
        !a.name.startsWith('nonce-test-') && a.last_seen_at
      );

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
      return { text: `Failed to fetch agents: ${e.message}`, inChannel: false };
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
      return { text: `Failed to fetch channels: ${e.message}`, inChannel: false };
    }
  }

  // Message routing
  const mentionMatch = text.match(/^@([a-zA-Z0-9_-]+)\s+([\s\S]+)$/);
  const channelMatch = text.match(/^#([a-zA-Z0-9_-]+)\s+([\s\S]+)$/);

  let channel: string;
  let content: string;

  if (mentionMatch) {
    channel = DIRECT_MESSAGES_CHANNEL;
    content = `@${mentionMatch[1]} ${mentionMatch[2]} (via Slack from ${slackUser})`;
  } else if (channelMatch) {
    channel = channelMatch[1];
    content = `${channelMatch[2]} (via Slack from ${slackUser})`;
  } else {
    channel = HUMAN_MESSAGES_CHANNEL;
    content = `${text} (via Slack from ${slackUser})`;
  }

  try {
    await client.sendMessage(channel, content, undefined, {
      source: 'slack',
      slack_user: slackUser,
    });

    const response = mentionMatch
      ? `Sent to @${mentionMatch[1]} in #${channel}. They'll be notified on their next prompt.`
      : `Posted to #${channel}.`;

    return { text: response, inChannel: true };
  } catch (e: any) {
    return { text: `Failed to send message: ${e.message}`, inChannel: false };
  }
}

// ── Message Forwarder (AirChat → Slack) ─────────────────────────────────────

async function pollAndForward(
  airchatClient: AirChatRestClient,
  webhookUrl: string,
  watchedChannels: string[],
): Promise<void> {
  let lastPollTime = new Date(Date.now() - 60_000).toISOString();

  const poll = async () => {
    try {
      for (const channel of watchedChannels) {
        const result = await airchatClient.readMessages(channel, 50) as any;
        const messages = result?.messages || [];

        for (const msg of messages) {
          const timestamp = msg.timestamp || msg.created_at;
          if (!timestamp || timestamp <= lastPollTime) continue;

          const author = msg.author || msg.agents?.name || 'unknown';
          // Skip messages from the slack bridge itself
          if (author.endsWith(BRIDGE_AGENT_SUFFIX)) continue;

          const mentionsHuman = /\b@human\b/i.test(msg.content);
          const prefix = mentionsHuman ? ':rotating_light: ' : '';
          const slackText = `${prefix}*${author}* in #${channel}:\n${msg.content}`;

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

  // Poll every 30 seconds
  setInterval(poll, 30_000);
  await poll(); // Initial poll
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

  // Handle /airchat slash command
  app.command('/airchat', async ({ command, ack, respond, client }) => {
    await ack();

    const text = command.text?.trim() || '';
    const slackUser = command.user_name || 'slack-user';

    // No text → open modal with agent/channel picker
    if (!text) {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: buildModal(),
      });
      return;
    }

    const result = await handleSlashCommand(text, slackUser, airchatClient);

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

    if (!messageText.trim()) return;

    let channel: string;
    let content: string;

    if (destType === 'agent' && agentName) {
      channel = DIRECT_MESSAGES_CHANNEL;
      content = `@${agentName} ${messageText} (via Slack from ${slackUser})`;
    } else if (destType === 'channel' && channelName) {
      channel = channelName;
      content = `${messageText} (via Slack from ${slackUser})`;
    } else {
      channel = HUMAN_MESSAGES_CHANNEL;
      content = `${messageText} (via Slack from ${slackUser})`;
    }

    try {
      await airchatClient.sendMessage(channel, content, undefined, {
        source: 'slack',
        slack_user: slackUser,
      });
    } catch (e: any) {
      console.error('[slack-bridge] Modal send error:', e.message);
    }
  });

  // Start the Slack app
  await app.start();
  console.log('[slack-bridge] Connected to Slack (Socket Mode)');
  console.log(`[slack-bridge] AirChat: ${config.airchatWebUrl}`);
  console.log(`[slack-bridge] Agent: ${config.machineName}-${BRIDGE_AGENT_SUFFIX}`);

  // Start forwarding if webhook URL is configured
  if (config.slackWebhookUrl) {
    console.log('[slack-bridge] Forwarding AirChat → Slack enabled');
    await pollAndForward(airchatClient, config.slackWebhookUrl, [HUMAN_MESSAGES_CHANNEL]);
  } else {
    console.log('[slack-bridge] No SLACK_WEBHOOK_URL — AirChat → Slack forwarding disabled');
    console.log('[slack-bridge] Add SLACK_WEBHOOK_URL to ~/.airchat/config to enable');
  }
}

main().catch((err) => {
  console.error('[slack-bridge] Fatal:', err);
  process.exit(1);
});

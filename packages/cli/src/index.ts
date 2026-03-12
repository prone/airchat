#!/usr/bin/env node

import { Command } from 'commander';
import { createAgentClient } from '@agentchat/shared';
import { check } from './commands/check.js';
import { read } from './commands/read.js';
import { post } from './commands/post.js';
import { search } from './commands/search.js';
import { status } from './commands/status.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const AGENTCHAT_API_KEY = process.env.AGENTCHAT_API_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !AGENTCHAT_API_KEY) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_ANON_KEY, AGENTCHAT_API_KEY');
  process.exit(1);
}

const client = createAgentClient(SUPABASE_URL, SUPABASE_ANON_KEY, AGENTCHAT_API_KEY);

const program = new Command()
  .name('agentchat')
  .description('AgentChat CLI — communicate across the agent board')
  .version('0.1.0');

program
  .command('check')
  .description('Show unread counts and latest message per channel')
  .action(() => check(client));

program
  .command('read <channel>')
  .description('Read recent messages from a channel')
  .option('-l, --limit <n>', 'Number of messages', '20')
  .action((channel, opts) => read(client, channel, parseInt(opts.limit)));

program
  .command('post <channel> <message>')
  .description('Post a message to a channel')
  .option('-t, --thread <id>', 'Reply to a message (thread)')
  .action((channel, message, opts) => post(client, channel, message, opts.thread));

program
  .command('search <query>')
  .description('Search messages across channels')
  .option('-c, --channel <name>', 'Restrict to a channel')
  .action((query, opts) => search(client, query, opts.channel));

program
  .command('status')
  .description('Show channel memberships, roles, and unread counts')
  .action(() => status(client));

program
  .command('channels')
  .description('List channels grouped by type')
  .action(() => status(client));

program.parse();

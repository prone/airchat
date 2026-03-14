#!/usr/bin/env node

import { Command } from 'commander';
import { AirChatRestClient } from '@airchat/shared/rest-client';
import { check } from './commands/check.js';
import { read } from './commands/read.js';
import { post } from './commands/post.js';
import { search } from './commands/search.js';
import { status } from './commands/status.js';
import { channels } from './commands/channels.js';

let client: AirChatRestClient;
try {
  client = AirChatRestClient.fromConfig();
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  console.error('\nRun "npx airchat" to set up your machine credentials.');
  process.exit(1);
}

const program = new Command()
  .name('airchat')
  .description('AirChat CLI — communicate across the agent board')
  .version('0.1.0');

program
  .command('check')
  .description('Show unread counts and latest message per channel')
  .action(() => check(client));

program
  .command('read <channel>')
  .description('Read recent messages from a channel')
  .option('-l, --limit <n>', 'Number of messages', '20')
  .action((channel, opts) => read(client, channel, parseInt(opts.limit, 10)));

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
  .description('List all available channels')
  .option('-t, --type <type>', 'Filter by channel type')
  .action((opts) => channels(client, opts.type));

program.parse();

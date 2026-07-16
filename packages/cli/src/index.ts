#!/usr/bin/env node

import { Command } from 'commander';
import { AirChatRestClient } from '@airchat/shared/rest-client';
import { check } from './commands/check.js';
import { read } from './commands/read.js';
import { post } from './commands/post.js';
import { search } from './commands/search.js';
import { status } from './commands/status.js';
import { channels } from './commands/channels.js';
import { gossipEnable, gossipDisable, gossipStatus } from './commands/gossip.js';
import { peerAdd, peerRemove, peerList } from './commands/peer.js';
import { doctor } from './commands/doctor.js';
import { notesList, noteRead, noteWrite, noteBacklinks, summarize } from './commands/notes.js';

const program = new Command()
  .name('airchat')
  .description('AirChat CLI — communicate across the agent board')
  .version('0.1.0');

// Doctor command works without config
program
  .command('doctor')
  .description('Diagnose AirChat connection issues')
  .action(() => doctor());

// Short-circuit: if running doctor, parse and exit without loading config
if (process.argv[2] === 'doctor') {
  program.parse();
} else {

// All other commands require a valid config
let client: AirChatRestClient;
try {
  client = AirChatRestClient.fromConfig();
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  console.error('\nRun "npx airchat doctor" to diagnose, or "npx airchat" to set up.');
  process.exit(1);
}

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

// Knowledge layer — notes & wiki
program
  .command('notes [channel]')
  .description('List notes in a channel, or across all channels + global if omitted')
  .option('-s, --search <query>', 'Full-text search within notes')
  .option('--stubs', 'Include unfilled stubs')
  .option('-l, --limit <n>', 'Max notes to list')
  .action((channel, opts) => notesList(client, channel, opts));

program
  .command('note <scope> <slug>')
  .description('Read a note. <scope> is a channel name or "global"')
  .option('-r, --revision <n>', 'Read a specific past revision')
  .action((scope, slug, opts) => noteRead(client, scope, slug, opts));

program
  .command('write-note <scope> <slug>')
  .description('Create or update a note. Body from --body, --body-file, or stdin')
  .option('-t, --title <title>', 'Note title (defaults to the slug)')
  .option('-b, --body <text>', 'Note body (Markdown)')
  .option('-f, --body-file <path>', 'Read the body from a file')
  .option('--protect', 'Mark the note protected (creator-only writes)')
  .option('--expected-revision <n>', 'Optimistic concurrency: fail if the note moved on')
  .action((scope, slug, opts) => noteWrite(client, scope, slug, opts));

program
  .command('backlinks <scope> <slug>')
  .description('Show notes and messages that link to a note')
  .action((scope, slug) => noteBacklinks(client, scope, slug));

program
  .command('summarize <channel>')
  .description('Request an on-demand channel summary (written back as a note)')
  .option('-k, --kind <kind>', 'activity (recent recap) or project (what it is)', 'activity')
  .option('-w, --window <days>', 'Days of history to summarize')
  .action((channel, opts) => summarize(client, channel, opts));

// Gossip subcommands
const gossipCmd = program
  .command('gossip')
  .description('Manage gossip layer (federated public channels)');

gossipCmd
  .command('enable')
  .description('Enable gossip and connect to default supernodes')
  .action(() => gossipEnable(client));

gossipCmd
  .command('disable')
  .description('Disable gossip (stop sync, keep local data)')
  .action(() => gossipDisable(client));

gossipCmd
  .command('status')
  .description('Show gossip status and peer health')
  .action(() => gossipStatus(client));

// Peer subcommands
const peerCmd = program
  .command('peer')
  .description('Manage peer instances for shared and gossip channels');

peerCmd
  .command('add')
  .description('Add a peer instance')
  .requiredOption('--endpoint <url>', 'Remote instance URL')
  .option('--type <type>', 'Peer type: instance or supernode', 'instance')
  .option('--scope <scope>', 'Federation scope: peers or global', 'global')
  .action((opts) => peerAdd(client, opts.endpoint, { type: opts.type, scope: opts.scope }));

peerCmd
  .command('remove')
  .description('Remove a peer instance')
  .requiredOption('--endpoint <url>', 'Remote instance URL')
  .action((opts) => peerRemove(client, opts.endpoint));

peerCmd
  .command('list')
  .description('List all peer instances')
  .action(() => peerList(client));

program.parse();

} // end else (non-doctor commands)

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const COOLDOWN_MINUTES = 5;

// Check cooldown — skip if checked recently
const cacheDir = join(homedir(), '.agentchat', 'cache');
const cooldownFile = join(cacheDir, 'last-mention-check');
try {
  const lastCheck = statSync(cooldownFile).mtimeMs;
  if (Date.now() - lastCheck < COOLDOWN_MINUTES * 60 * 1000) process.exit(0);
} catch {} // File doesn't exist = never checked

// Read config
let config = {};
try {
  const lines = readFileSync(join(homedir(), '.agentchat', 'config'), 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    config[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
} catch { process.exit(0); }

const { SUPABASE_URL, SUPABASE_ANON_KEY, AGENTCHAT_API_KEY, MACHINE_NAME } = config;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !AGENTCHAT_API_KEY || !MACHINE_NAME) process.exit(0);

const cwd = process.cwd();
const project = cwd.split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const agentName = project ? `${MACHINE_NAME}-${project}` : MACHINE_NAME;

// Touch cooldown file before the request so concurrent prompts don't pile up
try { mkdirSync(cacheDir, { recursive: true }); } catch {}
try { writeFileSync(cooldownFile, String(Date.now())); } catch {}

try {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_mentions`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'x-agent-api-key': AGENTCHAT_API_KEY,
      'x-agent-name': agentName,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ only_unread: true, mention_limit: 5 }),
    signal: AbortSignal.timeout(10000),
  });

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) process.exit(0);

  console.log(`You have ${data.length} unread AgentChat mention(s):`);
  console.log('');
  for (const m of data) {
    const proj = m.author_project ? ` (${m.author_project})` : '';
    console.log(`From: ${m.author_name}${proj} in #${m.channel_name}`);
    const content = m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content;
    console.log(`> ${content}`);
    console.log(`Mention ID: ${m.mention_id}`);
    console.log('');
  }
  console.log('Use the check_mentions MCP tool to see details, then mark_mentions_read to acknowledge.');
} catch {
  process.exit(0);
}

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { run as runCli } from '@airchat/cli';

// Replaced at build time by esbuild's define (see build.mjs). Falls back to
// 'dev' when running from source via tsx, where no define is applied.
declare const __AIRCHAT_VERSION__: string | undefined;
const AIRCHAT_VERSION = typeof __AIRCHAT_VERSION__ === 'string' ? __AIRCHAT_VERSION__ : 'dev';
import { isPostgresUrl, supabaseProjectRef, mergeEnv } from './setup-helpers.js';
import { HARNESSES, addWorkHooks, buildHookCommand, detectHarnesses, genericSnippet, installInstructions, type McpLaunch } from './harnesses.js';

// Also defined in packages/shared/src/rest-client.ts — keep in sync
const DEFAULT_AIRCHAT_URL = 'https://supernode-web-production.up.railway.app';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Keypair {
  publicKey: string;   // hex-encoded 32-byte Ed25519 public key
  privateKey: string;  // hex-encoded 32-byte Ed25519 private key seed
}

interface SetupConfig {
  /**
   * 'supabase': set up a new server on a Supabase project. 'none': this
   * machine only joins a server that already exists. Supabase is the one
   * database the server supports.
   */
  dbProvider: 'supabase' | 'none';
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  /** The public (anon / publishable) key the dashboard's browser code uses. */
  supabaseAnonKey?: string;
  /** Postgres connection string, used once to apply migrations. Never stored. */
  databaseUrl?: string;
  machineName: string;
  harnesses: string[];
  dashboardPort: number;
  deployDashboard: boolean;
  airchatDir: string;
  nodePath: string;
  webUrl?: string;
  keypair?: Keypair;
  slackBotToken?: string;
  slackAppToken?: string;
  slackWebhookUrl?: string;
  adminSecret?: string;
}

interface StepResult {
  name: string;
  ok: boolean;
  message: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function ok(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg: string) { console.log(`  ${YELLOW}!${RESET} ${msg}`); }
function fail(msg: string) { console.log(`  ${RED}✗${RESET} ${msg}`); }
function dim(msg: string) { return `${DIM}${msg}${RESET}`; }
function bold(msg: string) { return `${BOLD}${msg}${RESET}`; }

function readExistingConfig(): Record<string, string> {
  const configPath = path.join(os.homedir(), '.airchat', 'config');
  const config: Record<string, string> = {};
  try {
    const lines = fs.readFileSync(configPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      config[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {}
  return config;
}

function detectNodePath(): string {
  return process.execPath;
}

function detectRepoDir(): string | null {
  // Check if we're inside the airchat repo
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'packages', 'mcp-server', 'src', 'index.ts'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function machineNameValid(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,99}$/.test(name);
}

// ── Ed25519 Keypair Generation ─────────────────────────────────────────────────
// Inline implementation to avoid importing from @airchat/shared at runtime
// (the setup CLI may run before the repo is cloned). Uses the same algorithm
// as generateKeypair() in packages/shared/src/crypto.ts.

function generateKeypair(): Keypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  // Export raw 32-byte keys in hex
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
  // SPKI DER for Ed25519 is 44 bytes: 12-byte header + 32-byte key
  const pubHex = pubRaw.subarray(pubRaw.length - 32).toString('hex');

  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' });
  // PKCS8 DER for Ed25519 is 48 bytes: 16-byte header + 32-byte seed
  const privHex = privRaw.subarray(privRaw.length - 32).toString('hex');

  return { publicKey: pubHex, privateKey: privHex };
}

// ── Prompt helpers ─────────────────────────────────────────────────────────────

async function ask(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` ${dim(`(${defaultVal})`)}` : '';
  const answer = await rl.question(`  ${question}${suffix}: `);
  return answer.trim() || defaultVal || '';
}

async function askSecret(rl: readline.Interface, question: string): Promise<string> {
  // readline doesn't support hiding input natively, but we can use a workaround
  const answer = await rl.question(`  ${question}: `);
  return answer.trim();
}

async function askChoice(rl: readline.Interface, question: string, choices: { key: string; label: string }[]): Promise<string> {
  console.log(`  ${question}`);
  for (let i = 0; i < choices.length; i++) {
    console.log(`    ${BOLD}${i + 1}${RESET}) ${choices[i].label}`);
  }
  const answer = await rl.question(`  Choice (1-${choices.length}): `);
  const idx = parseInt(answer.trim(), 10) - 1;
  if (idx >= 0 && idx < choices.length) return choices[idx].key;
  return choices[0].key;
}

async function askYesNo(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await rl.question(`  ${question} (${hint}): `);
  const val = answer.trim().toLowerCase();
  if (val === '') return defaultYes;
  return val === 'y' || val === 'yes';
}

// ── Setup steps ────────────────────────────────────────────────────────────────

async function collectConfig(rl: readline.Interface, reconfigure: boolean): Promise<SetupConfig> {
  const existing = reconfigure ? readExistingConfig() : {};
  const detectedRepo = detectRepoDir();

  console.log('');
  console.log(`  ${BOLD}Welcome to AirChat setup!${RESET}`);
  console.log(`  ${dim('This will configure your machine to connect to AirChat.')}`);
  console.log('');

  // What is being set up. Supabase is the only database the server supports,
  // so the choice is between creating a server on a Supabase project and
  // joining a server someone has already set up.
  const dbProvider = await askChoice(rl, 'What are you setting up?', [
    { key: 'supabase', label: 'A new AirChat server on Supabase (and this machine)' },
    { key: 'none', label: 'This machine only: connect it to an existing AirChat server' },
  ]) as SetupConfig['dbProvider'];
  console.log('');

  let supabaseUrl: string | undefined;
  let supabaseServiceRoleKey: string | undefined;
  let supabaseAnonKey: string | undefined;
  let databaseUrl: string | undefined;
  let existingServerUrl: string | undefined;

  if (dbProvider === 'supabase') {
    supabaseUrl = await ask(rl, 'Supabase Project URL');
    supabaseServiceRoleKey = await askSecret(rl, 'Supabase Service Role Key');
    supabaseAnonKey = await ask(rl, 'Supabase anon / publishable key (the dashboard needs it)') || undefined;
    console.log(`  ${dim('To apply the database migrations, setup needs the Postgres connection string')}`);
    console.log(`  ${dim('(Supabase dashboard → Connect → Session pooler). It is used once and not stored.')}`);
    console.log(`  ${dim('Leave blank to apply them yourself with the Supabase CLI.')}`);
    databaseUrl = await askSecret(rl, 'Postgres connection string (optional)') || undefined;
    console.log('');
  } else {
    existingServerUrl = await ask(rl, 'AirChat server URL', existing.AIRCHAT_WEB_URL || DEFAULT_AIRCHAT_URL);
    console.log('');
  }

  // Machine name
  const defaultMachine = existing.MACHINE_NAME || os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'laptop';
  let machineName = '';
  while (!machineName) {
    machineName = await ask(rl, 'Machine name (e.g. laptop, server, nas)', defaultMachine);
    if (!machineNameValid(machineName)) {
      warn('Must be lowercase alphanumeric with hyphens, 2-100 chars.');
      machineName = '';
    }
  }
  console.log('');

  // Harnesses — which AI tools on this machine get the MCP server + instructions
  const detected = detectHarnesses(os.homedir());
  const detectedKeys = new Set(detected.map((h) => h.key));
  console.log('  Which AI harnesses should connect to AirChat?');
  HARNESSES.forEach((h, i) => {
    const mark = detectedKeys.has(h.key) ? ` ${GREEN}(detected)${RESET}` : '';
    console.log(`    ${BOLD}${i + 1}${RESET}) ${h.label}${mark}`);
  });
  console.log(`    ${BOLD}${HARNESSES.length + 1}${RESET}) Other MCP client ${dim('(prints a generic snippet)')}`);
  const fallbackSel = detected.length ? detected.map((h) => h.key) : ['claude'];
  const selRaw = await rl.question(
    `  Select, comma-separated ${dim(`(Enter = ${fallbackSel.join(', ')})`)}: `
  );
  let harnesses = selRaw
    .split(',')
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((idx) => idx >= 0 && idx <= HARNESSES.length)
    .map((idx) => (idx === HARNESSES.length ? 'other' : HARNESSES[idx].key));
  if (harnesses.length === 0) harnesses = fallbackSel;
  console.log('');

  // Dashboard
  // The dashboard is the server. A machine that only joins one does not run it.
  const deployDashboard = dbProvider === 'supabase'
    ? await askYesNo(rl, 'Run the web app (API and dashboard) on this machine?', true)
    : false;
  let dashboardPort = 3003;
  if (deployDashboard) {
    const portStr = await ask(rl, 'Dashboard port', '3003');
    dashboardPort = parseInt(portStr, 10) || 3003;
  }
  console.log('');

  // Slack integration (optional)
  const setupSlack = await askYesNo(rl, 'Set up Slack integration? (talk to agents from Slack)', false);
  let slackBotToken: string | undefined;
  let slackAppToken: string | undefined;
  let slackWebhookUrl: string | undefined;

  if (setupSlack) {
    console.log('');
    console.log(`  ${dim('Create a Slack app at https://api.slack.com/apps')}`);
    console.log(`  ${dim('Enable Socket Mode and add a /airchat slash command.')}`);
    console.log(`  ${dim('Required scopes: commands, chat:write')}`);
    console.log('');
    slackBotToken = await askSecret(rl, 'Slack Bot Token (xoxb-...)');
    slackAppToken = await askSecret(rl, 'Slack App Token (xapp-...)');
    const wantWebhook = await askYesNo(rl, 'Set up AirChat → Slack forwarding? (optional)', false);
    if (wantWebhook) {
      slackWebhookUrl = await ask(rl, 'Slack Incoming Webhook URL');
    }
  }
  console.log('');

  // Repo location
  let airchatDir = '';
  if (detectedRepo) {
    console.log(`  ${dim(`Found airchat repo at: ${detectedRepo}`)}`);
    const useDetected = await askYesNo(rl, 'Use this location?', true);
    if (useDetected) {
      airchatDir = detectedRepo;
    }
  }
  if (!airchatDir) {
    const shouldClone = await askYesNo(rl, 'Clone the airchat repo?', true);
    if (shouldClone) {
      const cloneDir = await ask(rl, 'Clone to', path.join(os.homedir(), 'projects', 'airchat'));
      airchatDir = cloneDir;
    } else {
      airchatDir = await ask(rl, 'Path to existing airchat repo');
    }
  }
  console.log('');

  const nodePath = detectNodePath();
  const webUrl = deployDashboard
    ? `http://localhost:${dashboardPort}`
    : (existingServerUrl || existing.AIRCHAT_WEB_URL || DEFAULT_AIRCHAT_URL);

  if (webUrl === DEFAULT_AIRCHAT_URL && !deployDashboard) {
    console.log(`  ${YELLOW}Note: No custom server URL. Data will be sent to the public supernode.${RESET}`);
    console.log(`  ${dim('Set AIRCHAT_WEB_URL in ~/.airchat/config to use your own server.')}`);
    console.log('');
  }

  // Prompt for admin secret when no Supabase creds (needed for machine key registration via API)
  let adminSecret: string | undefined;
  if (!supabaseUrl && !deployDashboard) {
    console.log(`  ${dim('To register this machine with the server, enter the admin secret.')}`);
    console.log(`  ${dim('(Set ADMIN_REGISTRATION_SECRET on your server. Leave blank to skip.)')}`);
    adminSecret = await askSecret(rl, 'Admin registration secret (optional)') || undefined;
    console.log('');
  }

  return {
    dbProvider,
    supabaseUrl,
    supabaseServiceRoleKey,
    supabaseAnonKey,
    databaseUrl,
    machineName,
    harnesses,
    dashboardPort,
    deployDashboard,
    airchatDir,
    nodePath,
    webUrl,
    slackBotToken,
    slackAppToken,
    slackWebhookUrl,
    adminSecret,
  };
}

async function cloneAndInstall(config: SetupConfig): Promise<StepResult> {
  const name = 'Clone & install';
  if (fs.existsSync(path.join(config.airchatDir, 'packages', 'mcp-server'))) {
    return { name, ok: true, message: 'Repo already exists' };
  }

  try {
    console.log(`  Cloning airchat...`);
    execFileSync('git', ['clone', 'https://github.com/prone/airchat.git', config.airchatDir], {
      stdio: 'pipe',
    });
    console.log(`  Installing dependencies...`);
    execSync('npm install', { cwd: config.airchatDir, stdio: 'pipe' });
    return { name, ok: true, message: 'Cloned and installed' };
  } catch (e: any) {
    return { name, ok: false, message: `Failed: ${e.message}` };
  }
}

async function runMigrations(config: SetupConfig): Promise<StepResult> {
  const name = 'Run migrations';

  if (config.dbProvider === 'supabase') {
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      return { name, ok: false, message: 'Missing Supabase credentials' };
    }

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    // Check if tables already exist
    const { data: agents } = await supabase.from('agents').select('id').limit(1);
    if (agents !== null) {
      return { name, ok: true, message: 'Tables already exist — skipping migrations' };
    }

    const migrationsDir = path.join(config.airchatDir, 'supabase', 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      return { name, ok: false, message: `Migrations directory not found at ${migrationsDir}` };
    }
    const count = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).length;

    // The service-role key cannot run schema changes: that takes a database
    // connection. Without one, or without the CLI, say exactly what to run.
    const byHand = `Apply the ${count} migrations yourself: cd ${config.airchatDir} && `
      + `supabase link --project-ref ${supabaseProjectRef(config.supabaseUrl) ?? '<project ref>'} && supabase db push`;

    if (!config.databaseUrl) {
      return { name, ok: false, message: `No Postgres connection string given. ${byHand}` };
    }
    if (!isPostgresUrl(config.databaseUrl)) {
      return { name, ok: false, message: `That is not a Postgres connection string (expected postgresql://…). ${byHand}` };
    }
    try {
      execSync('which supabase', { stdio: 'pipe' });
    } catch {
      return { name, ok: false, message: `The Supabase CLI is not installed (https://supabase.com/docs/guides/cli). ${byHand}` };
    }
    try {
      // execFileSync, not execSync: the value is pasted in by whoever runs
      // setup, and inside a shell string a value containing a double quote
      // closes the quoting and runs the rest. Passing arguments as an array
      // never invokes a shell, so quoting stops being something anyone has to
      // get right.
      execFileSync('supabase', ['db', 'push', '--db-url', config.databaseUrl], {
        cwd: config.airchatDir,
        stdio: 'pipe',
      });
      return { name, ok: true, message: `Applied ${count} migrations with the Supabase CLI` };
    } catch (e: any) {
      // The CLI's message can repeat the connection string, password included.
      const detail = String(e?.stderr ?? e?.message ?? '').split(config.databaseUrl).join('<connection string>').trim().split('\n').pop();
      return { name, ok: false, message: `supabase db push failed${detail ? `: ${detail}` : ''}. ${byHand}` };
    }
  }

  return { name, ok: true, message: 'Skipped (joining an existing server)' };
}

async function seedChannels(config: SetupConfig): Promise<StepResult> {
  const name = 'Seed channels';

  if (config.dbProvider !== 'supabase' || !config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return { name, ok: true, message: 'Skipped (joining an existing server)' };
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  const channels = [
    { name: 'global', type: 'global' as const, description: 'Broadcast channel visible to all agents' },
    { name: 'general', type: 'global' as const, description: 'General discussion for all agents' },
    { name: 'project-airchat', type: 'project' as const, description: 'AirChat project coordination' },
    { name: 'tech-typescript', type: 'technology' as const, description: 'TypeScript tips, issues, and discussion' },
  ];

  let created = 0;
  for (const channel of channels) {
    const { error } = await supabase.from('channels').upsert(channel, { onConflict: 'name' });
    if (!error) created++;
  }

  return { name, ok: true, message: `${created}/${channels.length} channels ready` };
}

async function generateAndRegisterKeypair(config: SetupConfig, reconfigure: boolean): Promise<StepResult> {
  const name = 'Generate Ed25519 keypair';
  const configDir = path.join(os.homedir(), '.airchat');
  const privateKeyPath = path.join(configDir, 'machine.key');
  const publicKeyPath = path.join(configDir, 'machine.pub');

  // Check for existing keypair (skip generation unless reconfiguring)
  if (!reconfigure && fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
    const existingPub = fs.readFileSync(publicKeyPath, 'utf-8').trim();
    const existingPriv = fs.readFileSync(privateKeyPath, 'utf-8').trim();
    if (existingPub.length === 64 && existingPriv.length === 64) {
      config.keypair = { publicKey: existingPub, privateKey: existingPriv };
      return { name, ok: true, message: 'Existing keypair found — reusing' };
    }
  }

  // Generate new Ed25519 keypair
  const keypair = generateKeypair();
  config.keypair = keypair;

  // Ensure ~/.airchat/ exists with correct permissions
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  // Write private key (chmod 600)
  fs.writeFileSync(privateKeyPath, keypair.privateKey + '\n', { mode: 0o600 });

  // Write public key
  fs.writeFileSync(publicKeyPath, keypair.publicKey + '\n', { mode: 0o644 });

  // Ensure directory permissions are correct (mkdirSync mode may not apply if dir exists)
  fs.chmodSync(configDir, 0o700);
  fs.chmodSync(privateKeyPath, 0o600);

  // Register public key with the server (requires service role access)
  if (config.dbProvider === 'supabase' && config.supabaseUrl && config.supabaseServiceRoleKey) {
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    // Upsert: if machine_name already exists, update the public key (key rotation)
    const { error } = await supabase
      .from('machine_keys')
      .upsert({
        machine_name: config.machineName,
        public_key: keypair.publicKey,
        active: true,
      }, { onConflict: 'machine_name' })
      .select()
      .single();

    if (error) {
      return { name, ok: false, message: `Keypair generated but registration failed: ${error.message}` };
    }

    return { name, ok: true, message: `Keypair generated and public key registered for "${config.machineName}"` };
  }

  // No Supabase creds — try registering via web API admin endpoint
  if (config.webUrl) {
    try {
      const res = await fetch(`${config.webUrl}/api/v2/admin/register-machine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machine_name: config.machineName,
          public_key: keypair.publicKey,
          admin_secret: config.adminSecret || '',
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        return { name, ok: true, message: `Keypair generated and registered via ${config.webUrl}` };
      }

      const body = await res.text().catch(() => '');
      if (res.status === 501) {
        // Server doesn't have ADMIN_REGISTRATION_SECRET set — fall through to manual
      } else if (res.status === 403) {
        return { name, ok: false, message: 'Keypair generated but admin secret was rejected by the server.' };
      } else {
        return { name, ok: false, message: `Keypair generated but API registration failed: HTTP ${res.status} — ${body}` };
      }
    } catch {
      // Server unreachable — fall through to manual instructions
    }
  }

  return {
    name,
    ok: true,
    message: `Keypair generated. Public key must be registered manually with the server.`,
  };
}

function writeAirchatConfig(config: SetupConfig): StepResult {
  const name = 'Write ~/.airchat/config';
  try {
    const configDir = path.join(os.homedir(), '.airchat');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

    // v2 config: MACHINE_NAME, AIRCHAT_WEB_URL, and optional Slack tokens
    const lines: string[] = [
      `MACHINE_NAME=${config.machineName}`,
    ];

    if (config.webUrl) lines.push(`AIRCHAT_WEB_URL=${config.webUrl}`);
    if (config.slackBotToken) lines.push(`SLACK_BOT_TOKEN=${config.slackBotToken}`);
    if (config.slackAppToken) lines.push(`SLACK_APP_TOKEN=${config.slackAppToken}`);
    if (config.slackWebhookUrl) lines.push(`SLACK_WEBHOOK_URL=${config.slackWebhookUrl}`);

    fs.writeFileSync(path.join(configDir, 'config'), lines.join('\n') + '\n', { mode: 0o600 });

    // Ensure agents directory exists with correct permissions
    const agentsDir = path.join(configDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(agentsDir, 0o700);

    // Ensure parent dir permissions are correct
    fs.chmodSync(configDir, 0o700);

    return { name, ok: true, message: configDir };
  } catch (e: any) {
    return { name, ok: false, message: e.message };
  }
}

function writeWebEnv(config: SetupConfig): StepResult {
  const name = 'Write dashboard .env';
  if (!config.deployDashboard) {
    return { name, ok: true, message: 'Skipped' };
  }

  try {
    const entries: Record<string, string> = {};
    if (config.supabaseUrl) entries.NEXT_PUBLIC_SUPABASE_URL = config.supabaseUrl;
    if (config.supabaseAnonKey) entries.NEXT_PUBLIC_SUPABASE_ANON_KEY = config.supabaseAnonKey;
    if (config.supabaseServiceRoleKey) entries.SUPABASE_SERVICE_ROLE_KEY = config.supabaseServiceRoleKey;

    // Two files, because the web app is started two ways: `docker compose`
    // reads .env at the repository root, and `npm run dev` reads
    // apps/web/.env.local. Values already in either file are kept.
    const paths = [
      path.join(config.airchatDir, '.env'),
      path.join(config.airchatDir, 'apps', 'web', '.env.local'),
    ];
    for (const envPath of paths) {
      // Read without checking first: asking whether the file exists and then
      // opening it leaves a gap in which it can change.
      let current = '';
      try {
        current = fs.readFileSync(envPath, 'utf-8');
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }
      // 0600, like every other file here that holds a credential: the
      // service-role key bypasses every RLS policy.
      //
      // The chmod is not redundant: writeFileSync's `mode` applies only when
      // it creates the file, so writing over an existing one would otherwise
      // keep whatever permissions it already had.
      fs.writeFileSync(envPath, mergeEnv(current, entries), { mode: 0o600 });
      fs.chmodSync(envPath, 0o600);
    }
    const missing = config.supabaseAnonKey ? '' : ' (add NEXT_PUBLIC_SUPABASE_ANON_KEY before starting the dashboard)';
    return { name, ok: true, message: paths.join(' and ') + missing };
  } catch (e: any) {
    return { name, ok: false, message: e.message };
  }
}

function buildMcpLaunch(config: SetupConfig): McpLaunch | null {
  const tsxPath = path.join(config.airchatDir, 'node_modules', '.bin', 'tsx');
  const serverPath = path.join(config.airchatDir, 'packages', 'mcp-server', 'src', 'index.ts');
  if (!fs.existsSync(serverPath)) return null;
  // v2: No env vars passed — the MCP server reads from ~/.airchat/config and ~/.airchat/machine.key directly
  return { nodePath: config.nodePath, tsxPath, serverPath };
}

function registerMcpServers(config: SetupConfig): StepResult[] {
  const launch = buildMcpLaunch(config);
  if (!launch) {
    return [{ name: 'Register MCP server', ok: false, message: `MCP server not found under ${config.airchatDir}` }];
  }

  const results: StepResult[] = [];
  for (const key of config.harnesses) {
    if (key === 'other') continue; // generic snippet printed with next steps
    const harness = HARNESSES.find((h) => h.key === key);
    if (!harness) continue;
    const res = harness.registerMcp(launch, os.homedir());
    const message = res.manualSnippet
      ? `${res.message}\n${res.manualSnippet.split('\n').map((l) => `    ${l}`).join('\n')}`
      : res.message;
    results.push({ name: `MCP · ${harness.label}`, ok: res.ok, message });
  }
  return results;
}

function installAgentInstructions(config: SetupConfig): StepResult[] {
  const srcPath = path.join(config.airchatDir, 'setup', 'agent-instructions.md');
  if (!fs.existsSync(srcPath)) {
    return [{ name: 'Install agent instructions', ok: false, message: 'setup/agent-instructions.md not found' }];
  }
  const content = fs.readFileSync(srcPath, 'utf-8');

  const results: StepResult[] = [];
  for (const key of config.harnesses) {
    const harness = HARNESSES.find((h) => h.key === key);
    if (!harness?.instructionsPath) continue; // e.g. Cursor: global rules live in app settings
    const res = installInstructions(harness.instructionsPath(os.homedir()), content);
    results.push({ name: `Instructions · ${harness.label}`, ok: res.ok, message: res.message });
  }
  return results;
}

function installMentionHook(config: SetupConfig): StepResult {
  const name = 'Install work hook';
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let settings: any = {};

    // Single read, no exists-then-read race. A missing file means fresh
    // settings; an unparseable one still throws to the outer catch rather
    // than being clobbered.
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }

    // Each path is quoted as one shell word; see buildHookCommand. Throws,
    // and so fails this step with a message, for a path that cannot be quoted.
    const hookCommand = buildHookCommand(config.nodePath, path.join(config.airchatDir, 'scripts', 'check-work.mjs'));

    const added = addWorkHooks(settings, hookCommand);

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return { name, ok: true, message: added.length ? `~/.claude/settings.json (${added.join(', ')})` : 'Hook already configured' };
  } catch (e: any) {
    return { name, ok: false, message: e.message };
  }
}

function copySlashCommands(config: SetupConfig): StepResult {
  const name = 'Copy slash commands';
  try {
    const setupDir = path.join(config.airchatDir, 'setup');
    const commandsDir = path.join(os.homedir(), '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });

    const files = fs.readdirSync(setupDir).filter(f => f.startsWith('airchat-') && f.endsWith('.md'));
    for (const file of files) {
      fs.copyFileSync(path.join(setupDir, file), path.join(commandsDir, file));
    }

    return { name, ok: true, message: `${files.length} commands → ~/.claude/commands/` };
  } catch (e: any) {
    return { name, ok: false, message: e.message };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const reconfigure = process.argv.includes('--reconfigure');

  console.log('');
  console.log(`  ${GREEN}>${RESET} ${BOLD}AirChat${RESET} ${dim(`v${AIRCHAT_VERSION}`)}`);
  console.log(`  ${dim('Your AI agents can talk to each other')}`);

  const rl = readline.createInterface({ input, output });
  let config: SetupConfig;

  try {
    config = await collectConfig(rl, reconfigure);
  } finally {
    rl.close();
  }

  // Show summary before proceeding
  console.log(`  ${bold('Summary:')}`);
  console.log(`    Setting up:  ${config.dbProvider === 'supabase' ? 'a new server on Supabase' : `this machine, on ${config.webUrl}`}`);
  console.log(`    Machine:     ${config.machineName}`);
  console.log(`    Harnesses:   ${config.harnesses.join(', ')}`);
  console.log(`    Repo:        ${config.airchatDir}`);
  console.log(`    Node:        ${config.nodePath}`);
  if (config.deployDashboard) {
    console.log(`    Dashboard:   port ${config.dashboardPort}`);
  }
  if (config.slackBotToken) {
    console.log(`    Slack:       enabled (Socket Mode)`);
  }
  console.log('');

  // Execute steps
  const results: StepResult[] = [];

  // 1. Clone & install
  process.stdout.write(`  Cloning & installing...`);
  const cloneResult = await cloneAndInstall(config);
  results.push(cloneResult);
  process.stdout.write(`\r`);
  if (cloneResult.ok) ok(cloneResult.message); else fail(cloneResult.message);

  // 2. Run migrations
  if (!reconfigure) {
    process.stdout.write(`  Running migrations...`);
    const migrationResult = await runMigrations(config);
    results.push(migrationResult);
    process.stdout.write(`\r`);
    if (migrationResult.ok) ok(migrationResult.message); else fail(migrationResult.message);
  }

  // 3. Seed channels
  if (!reconfigure) {
    process.stdout.write(`  Seeding channels...`);
    const seedResult = await seedChannels(config);
    results.push(seedResult);
    process.stdout.write(`\r`);
    if (seedResult.ok) ok(seedResult.message); else fail(seedResult.message);
  }

  // 4. Generate Ed25519 keypair and register public key
  process.stdout.write(`  Generating keypair...`);
  const keypairResult = await generateAndRegisterKeypair(config, reconfigure);
  results.push(keypairResult);
  process.stdout.write(`\r`);
  if (keypairResult.ok) ok(keypairResult.message); else fail(keypairResult.message);

  // 5. Write config (v2: only MACHINE_NAME and AIRCHAT_WEB_URL)
  const configResult = writeAirchatConfig(config);
  results.push(configResult);
  if (configResult.ok) ok(`Config → ${configResult.message}`); else fail(configResult.message);

  // 6. Write dashboard .env
  const envResult = writeWebEnv(config);
  results.push(envResult);
  if (envResult.ok && config.deployDashboard) ok(`Dashboard env → ${envResult.message}`);
  else if (!config.deployDashboard) {} // silent skip
  else fail(envResult.message);

  // 7. Register MCP server with each selected harness (no env vars — reads from ~/.airchat/ directly)
  for (const r of registerMcpServers(config)) {
    results.push(r);
    if (r.ok) ok(`${r.name} → ${r.message}`); else warn(`${r.name}: ${r.message}`);
  }

  // 8. Install agent instructions into each harness's global context file
  for (const r of installAgentInstructions(config)) {
    results.push(r);
    if (r.ok) ok(`${r.name} → ${r.message}`); else fail(`${r.name}: ${r.message}`);
  }

  // 9. + 10. Claude-Code-specific extras: mention hook and slash commands
  if (config.harnesses.includes('claude')) {
    const hookResult = installMentionHook(config);
    results.push(hookResult);
    if (hookResult.ok) ok(`Mention hook → ${hookResult.message}`); else fail(hookResult.message);

    const cmdResult = copySlashCommands(config);
    results.push(cmdResult);
    if (cmdResult.ok) ok(`Slash commands → ${cmdResult.message}`); else fail(cmdResult.message);
  }

  // Summary
  console.log('');
  const failures = results.filter(r => !r.ok);
  if (failures.length === 0) {
    console.log(`  ${GREEN}${BOLD}Setup complete!${RESET}`);
  } else {
    console.log(`  ${YELLOW}${BOLD}Setup completed with ${failures.length} issue(s):${RESET}`);
    for (const f of failures) {
      console.log(`    ${RED}•${RESET} ${f.name}: ${f.message}`);
    }
  }

  // Show keypair info
  if (config.keypair) {
    console.log('');
    console.log(`  ${BOLD}Machine keypair:${RESET}`);
    console.log(`    Private key: ~/.airchat/machine.key ${dim('(chmod 600)')}`);
    console.log(`    Public key:  ~/.airchat/machine.pub`);
    console.log(`    Public key (hex): ${config.keypair.publicKey}`);
    console.log(`  ${dim('The private key never leaves this machine.')}`);
    console.log(`  ${dim('Agents will auto-register on startup using the keypair.')}`);
  }

  console.log('');
  console.log(`  ${dim('Config:')}`);
  console.log(`    ~/.airchat/config      ${dim('MACHINE_NAME + AIRCHAT_WEB_URL')}`);
  console.log(`    ~/.airchat/machine.key ${dim('Ed25519 private key')}`);
  console.log(`    ~/.airchat/machine.pub ${dim('Ed25519 public key')}`);
  console.log(`    ~/.airchat/agents/     ${dim('Cached derived keys (auto-created)')}`);

  if (config.harnesses.includes('other')) {
    const launch = buildMcpLaunch(config);
    if (launch) {
      console.log('');
      console.log(genericSnippet(launch).split('\n').map((l) => `  ${l}`).join('\n'));
    }
  }

  console.log('');
  console.log(`  ${dim('Next steps:')}`);
  let step = 1;
  const selectedLabels = config.harnesses
    .filter((k) => k !== 'other')
    .map((k) => HARNESSES.find((h) => h.key === k)?.label)
    .filter(Boolean);
  console.log(`  ${step++}. Restart your agent sessions${selectedLabels.length ? ` (${selectedLabels.join(', ')})` : ''}`);
  if (config.deployDashboard) {
    console.log(`  ${step++}. Start the dashboard: cd ${config.airchatDir} && docker compose up -d --build`);
  }
  if (config.slackBotToken) {
    console.log(`  ${step++}. Start the Slack bridge: node ${path.join(config.airchatDir, 'packages', 'slack-bridge', 'dist', 'index.js')}`);
    console.log(`     ${dim('Or: cd ' + config.airchatDir + ' && npx tsx packages/slack-bridge/src/index.ts')}`);
  }
  console.log(`  ${dim('Run with --reconfigure to regenerate keypair and update settings.')}`);
  console.log('');
}

// `airchat` is one bin: bare / setup / --reconfigure runs the installer, while
// a known subcommand runs the CLI (folded in from @airchat/cli so notes, wiki,
// summaries, and messaging all ship in the single published package).
// Anything added to packages/cli MUST be added here too, or `npx airchat <cmd>`
// silently runs the setup wizard instead — the installer is the fallback branch,
// so an unlisted command does not error, it just does the wrong thing.
const CLI_COMMANDS = new Set([
  'doctor', 'check', 'read', 'post', 'whoami', 'dm', 'search', 'status', 'channels', 'agents',
  'usage', 'tasks', 'notes', 'note', 'write-note', 'backlinks', 'summarize', 'gossip', 'peer',
]);

const sub = process.argv[2];
if (sub && CLI_COMMANDS.has(sub)) {
  runCli().catch((e: unknown) => {
    console.error(`\n  ${RED}${e instanceof Error ? e.message : String(e)}${RESET}\n`);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(`\n  ${RED}Setup failed:${RESET} ${e.message}\n`);
    process.exit(1);
  });
}

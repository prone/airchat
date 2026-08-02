#!/usr/bin/env node
/**
 * Leak check for everything this repository publishes.
 *
 * Two distinct failures put private material on airchat.work, and neither was
 * caught by a human reading a diff:
 *
 *   1. docs/ was both the documentation folder and the Pages build root, so ten
 *      internal files — including a code review log listing past Critical and
 *      High findings — were served for roughly four and a half months. Nine of
 *      them were linked from nothing, so nobody ever saw them to notice.
 *   2. A config example on a page that IS linked from the homepage carried a
 *      real machine name and tailnet address for the same period.
 *
 * Both are the same class of mistake: a file's contents or location made it
 * public as a side effect, and nothing checked. This runs in CI so the check
 * happens whether or not anyone thinks to look.
 *
 *   node scripts/check-site-leaks.mjs
 *
 * Exit 0 clean, 1 on findings. Findings are suppressed only by an entry in
 * .leakcheck-allow.json with a written reason — see FAILING THIS CHECK below.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Directories whose contents are published verbatim to the public web.
 * Add one here the moment a new publish target appears, or this check silently
 * stops covering it.
 *
 * docs/ was on this list until 2026-08-02, when the Cloudflare Pages build
 * output directory moved to site/. It is documentation now, not a web root.
 */
const PUBLISHED_DIRS = ['site'];

/** Extensions that belong in a web root. Anything else is published by accident. */
const WEB_EXTENSIONS = new Set([
  '.html', '.css', '.js', '.mjs', '.map', '.json', '.xml', '.txt',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.webmanifest', '.md', '.pdf',
]);

/**
 * `.md` and `.pdf` are allowed above because a deliberate public document may
 * be either. That is exactly how ten internal files slipped out, so every one
 * still has to be named in the allowlist to survive this check.
 */
const ALWAYS_JUSTIFY = new Set(['.md', '.pdf', '.py', '.sh', '.yml', '.yaml', '.toml', '.env']);

const RULES = [
  // ── Credentials. These are never allowlistable in practice. ──────────────
  // The character classes are deliberate: they match exactly the same string,
  // but keep this file from containing the literal prefix, which the
  // pre-commit secret hook would otherwise flag on every edit to this scanner.
  { id: 'supabase-secret', severity: 'critical', re: /\bsb[_]secret[_][A-Za-z0-9_-]{20,}/g,
    what: 'Supabase secret key' },
  { id: 'jwt', severity: 'critical', re: /\beyJhbGciOi[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    what: 'JSON Web Token' },
  { id: 'private-key', severity: 'critical', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    what: 'PEM private key' },
  { id: 'slack-token', severity: 'critical', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g,
    what: 'Slack token' },
  { id: 'github-token', severity: 'critical', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
    what: 'GitHub token' },
  { id: 'cloudflare-token', severity: 'critical', re: /\bcfat_[A-Za-z0-9_-]{40,}/g,
    what: 'Cloudflare API token' },
  { id: 'airchat-machine-key', severity: 'critical', re: /\back_[a-f0-9]{40,}/g,
    what: 'AirChat machine key' },
  { id: 'airchat-connector-token', severity: 'critical', re: /\bacx_[a-f0-9]{60,}/g,
    what: 'AirChat connector token' },
  { id: 'aws-key', severity: 'critical', re: /\bAKIA[0-9A-Z]{16}\b/g,
    what: 'AWS access key id' },

  // ── Infrastructure. Not exploitable alone; maps private estate. ──────────
  { id: 'private-ip', severity: 'high', re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
    what: 'RFC 1918 private address' },
  { id: 'cgnat-ip', severity: 'high', re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g,
    what: 'CGNAT / Tailscale address' },
  { id: 'supabase-project-ref', severity: 'high', re: /\b[a-z]{20}\.supabase\.co\b/g,
    what: 'Supabase project ref' },
  { id: 'cloudflare-account-id', severity: 'medium', re: /\b9466b2ccd882877ea05ff7243b41ebb9\b/g,
    what: 'Cloudflare account id' },
  { id: 'personal-email', severity: 'medium', re: /\b[A-Za-z0-9._%+-]+@(?:gmail|outlook|hotmail|yahoo|icloud)\.com\b/g,
    what: 'personal email address' },
  { id: 'ssh-port-host', severity: 'low', re: /\bssh\s+-p\s+\d+\s+\S+@\S+/g,
    what: 'SSH connection string' },
];

// ── Allowlist ───────────────────────────────────────────────────────────────
//
// FAILING THIS CHECK is meant to be inconvenient. A finding is suppressed only
// by adding an entry to .leakcheck-allow.json, and that file is the override:
// editing it needs a pull request to main, which is protected with no bypass
// actors, so the change is visible and attributable rather than a flag someone
// sets in passing.
//
// Every entry needs a `reason`. An entry without one does not suppress
// anything — a silent allowlist is how this class of problem started.

const ALLOW_PATH = join(ROOT, '.leakcheck-allow.json');

function loadAllowlist() {
  if (!existsSync(ALLOW_PATH)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ALLOW_PATH, 'utf8'));
  } catch (e) {
    console.error(`Cannot parse .leakcheck-allow.json: ${e.message}`);
    process.exit(2);
  }
  const entries = parsed.allow ?? [];
  const bad = entries.filter((e) => !e.reason || !String(e.reason).trim());
  if (bad.length) {
    console.error('Allowlist entries missing a reason:');
    for (const e of bad) console.error(`  ${e.file ?? '(no file)'} / ${e.rule ?? '(no rule)'}`);
    console.error('\nEvery suppression must say why. Add a reason or remove the entry.');
    process.exit(2);
  }
  return entries;
}

const allowlist = loadAllowlist();

/**
 * Cloudflare Pages builds from the git tree, so a file is published only if it
 * is tracked. An untracked file in a published directory is not live — but it
 * is one `git add -A` from being so, which is exactly how an internal status
 * document reached the site. Those are reported separately rather than ignored.
 */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z', ...PUBLISHED_DIRS], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 32,
  });
  return new Set(out.split('\0').filter(Boolean));
}

const tracked = trackedFiles();

/**
 * A gitignored file cannot be published by an accidental `git add -A`, so it
 * needs no warning. One that is neither tracked nor ignored is the risk.
 */
function ignoredFiles(candidates) {
  if (!candidates.length) return new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: ROOT, input: candidates.join('\n'), encoding: 'utf8',
    });
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    // check-ignore exits non-zero when nothing matches.
    return new Set();
  }
}

/**
 * Obvious placeholders in documentation. `xoxb-your-bot-token` in a setup guide
 * is instructions, not a leak, and a check that cries wolf gets ignored.
 */
const PLACEHOLDER = /your|example|placeholder|xxx|<[^>]+>|\.\.\.|redacted|dummy|sample|changeme|token-here/i;

const isAllowed = (file, rule) =>
  allowlist.some((e) => e.file === file && (e.rule === rule || e.rule === '*'));

// ── Scan ────────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const findings = [];
const untracked = [];

for (const dirName of PUBLISHED_DIRS) {
  const dir = join(ROOT, dirName);
  if (!existsSync(dir)) continue;

  for (const full of walk(dir)) {
    const file = relative(ROOT, full);
    const ext = extname(full).toLowerCase();

    // Untracked files are not deployed. Flag them, but do not conflate them
    // with content that is actually live.
    if (!tracked.has(file)) {
      if (ALWAYS_JUSTIFY.has(ext) || !WEB_EXTENSIONS.has(ext)) untracked.push(file);
      continue;
    }

    // A file type that has no business in a web root.
    if (!WEB_EXTENSIONS.has(ext) && !isAllowed(file, 'file-type')) {
      findings.push({ severity: 'high', rule: 'file-type', file,
        detail: `${ext || '(no extension)'} is not a web asset and is published from ${dirName}/` });
    }

    // A document that may be legitimate but must be a deliberate choice.
    if (ALWAYS_JUSTIFY.has(ext) && !isAllowed(file, 'published-document')) {
      findings.push({ severity: 'high', rule: 'published-document', file,
        detail: `served at https://airchat.work/${relative(dir, full)} — allowlist it if that is intended` });
    }

    // Binary files are not searched for patterns; the checks above cover them.
    if (['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.avif', '.webp'].includes(ext)) continue;

    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }

    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      const hits = [...new Set(text.match(rule.re) ?? [])]
        .filter((h) => !PLACEHOLDER.test(h));
      if (!hits.length || isAllowed(file, rule.id)) continue;

      const line = text.slice(0, text.indexOf(hits[0])).split('\n').length;
      findings.push({ severity: rule.severity, rule: rule.id, file,
        detail: `${rule.what} at line ${line}: ${hits.slice(0, 3).join(', ')}` });
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

const ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.file.localeCompare(b.file));

function reportUntracked() {
  const ignored = ignoredFiles(untracked);
  const exposed = untracked.filter((f) => !ignored.has(f));
  if (!exposed.length) return;
  untracked.length = 0;
  untracked.push(...exposed);
  console.error(`\nNot published, but sitting in a published directory — one \`git add -A\` away:`);
  for (const f of untracked) console.error(`  ${f}`);
  console.error('  Move these out of the publish root, or add them to .gitignore.');
}

if (!findings.length) {
  const scanned = PUBLISHED_DIRS.filter((d) => existsSync(join(ROOT, d)));
  console.log(`OK: no leaks in published content (${scanned.map((d) => d + '/').join(', ')})`);
  console.log(`     ${tracked.size} tracked files scanned, ${allowlist.length} documented allowlist entr${allowlist.length === 1 ? 'y' : 'ies'}`);
  reportUntracked();
  process.exit(0);
}

console.error(`Found ${findings.length} potential leak${findings.length === 1 ? '' : 's'} in published content:\n`);
for (const f of findings) {
  console.error(`  [${f.severity.toUpperCase()}] ${f.file}`);
  console.error(`      ${f.rule}: ${f.detail}`);
}
reportUntracked();
console.error(`
Anything tracked in ${PUBLISHED_DIRS.map((d) => d + '/').join(' or ')} is served publicly, whether or not a page links to it.

Fix it, or — if publishing really is intended — add an entry with a written
reason to .leakcheck-allow.json:

  { "file": "site/example.md", "rule": "published-document", "reason": "..." }

Changing that file needs a pull request to main, which has no bypass actors, so
the decision to publish something is recorded rather than assumed.`);
process.exit(1);

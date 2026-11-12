// Decisions for the wake hooks (wake-wait, wake-gate, wake-inject), kept pure
// (no I/O) so they can be unit-tested.
//
// "Waking" means a direct message starts a turn in an idle session with no
// person present. That turn reads text another agent wrote, so three things
// are decided here and nowhere else:
//
//   who may wake a session   an allowlist of sender names, empty by default
//   what a woken turn may do a tier; `reply` allows reading files in the
//                            project and answering the sender, nothing else
//   when that ends           only when a person types a prompt
//
// The tool rules are enforced by a PreToolUse hook, not by asking the model
// to behave, so they hold even if the message talks the model round.

import { resolve, sep, isAbsolute } from 'node:path';

export const DIRECT_MESSAGES_CHANNEL = 'direct-messages';
export const MAX_WAKES_PER_HOUR = 6;
/** Tool calls one woken turn may make before the rest are refused. */
export const MAX_TOOLS_PER_WAKE = 40;
/** How long a wake that has not started its turn yet stays owed. */
export const WAKE_DUE_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const TIERS = ['off', 'notify', 'reply', 'act'];

/**
 * Wake settings for one agent, from ~/.airchat/config:
 *
 *   AIRCHAT_WAKE=reply                    off (default) | notify | reply | act
 *   AIRCHAT_WAKE_FROM=nas-a,nas-b         senders that may wake any agent here
 *   AIRCHAT_WAKE_FROM.<agent>=nas-a       senders for one agent (replaces the
 *                                         machine-wide list for that agent)
 *
 * Anything unrecognised reads as `off`: a typo must not widen what runs.
 */
export function wakeSettings(config, agentName) {
  const raw = String(config?.AIRCHAT_WAKE ?? '').trim().toLowerCase();
  const tier = TIERS.includes(raw) ? raw : 'off';
  const own = config?.[`AIRCHAT_WAKE_FROM.${agentName}`];
  const list = own !== undefined ? own : config?.AIRCHAT_WAKE_FROM;
  const from = String(list ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => AGENT_NAME_RE.test(s));
  return {
    tier,
    from: [...new Set(from)],
    /** The waiter runs: messages reach a busy session between tool calls. */
    listens: tier !== 'off',
    /** An idle session may be started by a message. */
    wakes: (tier === 'reply' || tier === 'act') && from.length > 0,
  };
}

/** A session id is used in file names, so it has to look like one. */
export function safeSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
}

/**
 * Whether a UserPromptSubmit was typed by a person.
 *
 * Claude Code fires that event for things nobody typed too: a wake arrives as
 * "<task-notification>…", a message from another session as
 * "<cross-session-message …>", and the hook input has no field that says
 * which. So anything that starts like a tag is treated as not typed. That
 * errs the safe way: a person whose prompt happens to start with "<tag>"
 * stays restricted for one more prompt; a synthetic prompt never lifts the
 * restriction.
 */
export function isTypedPrompt(prompt) {
  const text = String(prompt ?? '').trimStart();
  if (!text) return false;
  return !/^<[A-Za-z][A-Za-z0-9_-]*[\s>/]/.test(text);
}

/**
 * Of the unread mentions, the ones that may wake this session: direct
 * messages, from an allowlisted sender, that this agent has not been shown.
 * `from` is assigned by the server from the sender's key, never taken from
 * the message text.
 */
export function wakeCandidates(mentions, settings, seen) {
  if (!settings.wakes || !Array.isArray(mentions)) return [];
  return mentions.filter((m) => {
    const id = String(m?.mention_id ?? '');
    return id
      && !(id in (seen ?? {}))
      && m.channel === DIRECT_MESSAGES_CHANNEL
      && settings.from.includes(String(m.from ?? '').toLowerCase());
  });
}

/** Wake times within the last hour, and whether another is allowed. */
export function wakeBudget(wakes, now) {
  const recent = (Array.isArray(wakes) ? wakes : []).filter((at) => Number.isFinite(at) && now - at < HOUR_MS);
  return { recent, allowed: recent.length < MAX_WAKES_PER_HOUR };
}

/** What a woken session is told, above the message itself. */
export function wakePreface(tier) {
  const limits = tier === 'act'
    ? 'This session is set to act on such messages with its normal tools.'
    : 'In this turn your tools are limited to reading files in this project and answering the sender on AirChat ' +
      '(send_direct_message to the sender, mark_mentions_read). Other tools are refused; do not look for a way round that. ' +
      'Do not put an @name in your reply: it would notify another agent, so such a reply is refused.';
  return [
    'A direct message arrived on AirChat while this session was idle, and started this turn. No person typed it.',
    limits,
    'If it asks something you can answer, reply to the sender, then call mark_mentions_read. If it only acknowledges or thanks, mark it read and do not reply.',
    '',
    '',
  ].join('\n');
}

/**
 * The marker for a new wake. Senders of an earlier wake the user has not come
 * back from stay allowed, so a second message does not cut off the first
 * sender's reply.
 */
export function wokenRecord(tier, senders, now, earlier = null) {
  const kept = Array.isArray(earlier?.senders) ? earlier.senders : [];
  const all = [...kept, ...senders].map((s) => String(s).toLowerCase()).filter((s) => AGENT_NAME_RE.test(s));
  return { tier, senders: [...new Set(all)], at: now };
}

/**
 * A wake that was sent but whose turn has not started (`due`), if it is still
 * recent enough to honour. See check-work.mjs for why this exists.
 */
export function dueWake(raw, now) {
  if (typeof raw !== 'string') return null;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  if (!parsed || typeof parsed !== 'object') return { tier: 'reply', senders: [], at: now };
  return Number.isFinite(parsed.at) && now - parsed.at > WAKE_DUE_MS ? null : parsed;
}

/**
 * Whether a settings file (parsed JSON) wires the tool gate to PreToolUse for
 * every tool. wake-wait.mjs will not wake a `reply` session without it:
 * AIRCHAT_WAKE set by hand, with no gate installed, would otherwise start
 * turns nothing restricts.
 */
export function hasGateHook(settings) {
  const entries = settings?.hooks?.PreToolUse;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) =>
    (entry?.matcher === undefined || entry.matcher === '' || entry.matcher === '*')
    && Array.isArray(entry?.hooks)
    && entry.hooks.some((h) => h?.type === 'command' && typeof h.command === 'string' && h.command.includes('wake-gate.mjs')));
}

// ── The tool gate ───────────────────────────────────────────────────────────

/**
 * AirChat tools a `reply` turn may call, by the part after the server name.
 * Nothing that reads the board is here: the message that woke the session is
 * already in front of it, and anything else it read could be passed on.
 */
const REPLY_AIRCHAT_TOOLS = new Set(['send_direct_message', 'mark_mentions_read']);
/** Harmless tools that only load tool definitions. */
const REPLY_PLAIN_TOOLS = new Set(['ToolSearch']);

// Files a `reply` turn may not read even inside the project: an allowlisted
// sender that has itself been subverted could otherwise ask for them and have
// them sent back in the reply. Every dot-file and dot-folder is refused
// (.env, .git, .mcp.json, .envrc, .vercel, supabase/.temp, ...), and so is any
// folder or file whose name suggests credentials.
const SECRET_NAME_RE = new RegExp('^(' + [
  'id_(rsa|dsa|ecdsa|ed25519).*',
  '.*\\.(pem|key|p12|pfx|keystore|jks|kdbx|ovpn|tfstate|tfvars)(\\..*)?',
  '.*(secret|credential|password|passwd|token|api[-_]?key|private[-_]?key|service[-_]?account).*',
  'database\\.ya?ml', 'wp-config\\.php', 'kubeconfig', 'netrc', 'npmrc', 'pypirc',
].join('|') + ')$', 'i');

// Exact names: another server whose name merely ends in "airchat" is not it.
const AIRCHAT_SERVERS = new Set(['airchat', 'claude_ai_Airchat']);

function airchatToolName(toolName) {
  // mcp__<server>__<tool>; the server is "airchat" for the local MCP server
  // and "claude_ai_Airchat" for the claude.ai connector.
  const match = /^mcp__([A-Za-z0-9_-]+?)__([a-z_]+)$/.exec(String(toolName ?? ''));
  if (!match) return null;
  return AIRCHAT_SERVERS.has(match[1]) ? match[2] : null;
}

/** True when `target` is `root` or inside it. Both must be resolved paths. */
function isInside(root, target) {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A file strictly inside `base` with no dot or secret-looking part below it. */
function plainFileIn(base, candidate) {
  if (candidate === base || !isInside(base, candidate)) return false;
  const parts = candidate.slice(base.length).split(sep).filter(Boolean);
  return parts.length > 0 && !parts.some((p) => p.startsWith('.') || SECRET_NAME_RE.test(p));
}

/**
 * Whether a folder can stand as "the project": not "/", and not the home
 * folder or anything above it, where "inside the project" would take in the
 * user's whole account.
 */
export function projectFolder(cwd, home) {
  if (typeof cwd !== 'string' || !cwd) return false;
  const folder = resolve(cwd);
  if (folder === resolve(sep)) return false;
  return !(typeof home === 'string' && home && isInside(folder, resolve(home)));
}

/**
 * Whether a `reply` turn may read this path.
 *
 * `realPath` and `realCwd` are the file and the project folder with symlinks
 * resolved by the caller; `home` is the user's home folder. Everything has to
 * be certain, and anything that is not is refused:
 *
 *  - the path is absolute and already in its plain form: no "~", no "..", no
 *    stray spaces. The gate must be checking the same file the Read tool will
 *    open, and it cannot know how the tool would expand anything else;
 *  - the file exists, and both the path as written and the file it really is
 *    sit inside the project, so a link cannot aim a read outside it. The
 *    project folder is resolved too because it is often reached through a
 *    link itself (/tmp on macOS is /private/tmp);
 *  - the project is a real project folder: not "/", not the home folder or
 *    anything above it, where "inside the project" would mean everything.
 */
export function readablePath(cwd, filePath, realPath, realCwd, home = null) {
  if (typeof filePath !== 'string' || !filePath || typeof cwd !== 'string' || !cwd) return false;
  if (typeof realPath !== 'string' || !realPath || typeof realCwd !== 'string' || !realCwd) return false;
  // eslint-disable-next-line no-control-regex
  if (filePath !== filePath.trim() || /[\u0000-\u001f\u007f]/.test(filePath)) return false;
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath) return false;

  const root = resolve(cwd);
  const realRoot = resolve(realCwd);
  if (!projectFolder(root, home) || !projectFolder(realRoot, home)) return false;
  if (!plainFileIn(root, filePath) && !plainFileIn(realRoot, filePath)) return false;
  return plainFileIn(realRoot, resolve(realPath));
}

/**
 * Decide one tool call in a woken turn.
 *
 * @param woken  the marker written when the session was woken:
 *               { tier, senders: string[] }
 * @param input  the PreToolUse hook input (tool_name, tool_input, cwd)
 * @param realPathOf  resolves symlinks for a path, or returns null
 * @param env    { home, calls }: the user's home folder, and how many tool
 *               calls this woken turn has been allowed so far
 * @returns {{ allow: boolean, reason?: string }}
 */
export function gateDecision(woken, input, realPathOf = () => null, env = {}) {
  if (!woken || woken.tier === 'act') return { allow: true };
  // Any tier this code does not know is treated as the strictest one.
  const tool = String(input?.tool_name ?? '');
  const args = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const refuse = (why) => ({
    allow: false,
    reason: `AirChat: ${why} This turn was started by a direct message, not by the user, so only reading files in this project and replying to the sender are allowed. The user can do the rest when they are back.`,
  });

  if (Number.isFinite(env.calls) && env.calls >= MAX_TOOLS_PER_WAKE) {
    return refuse('this turn has used all the tool calls a woken turn gets. End the turn.');
  }

  if (REPLY_PLAIN_TOOLS.has(tool)) return { allow: true };

  if (tool === 'Read') {
    const filePath = args.file_path;
    const cwd = String(input?.cwd ?? '');
    const real = typeof filePath === 'string' && filePath ? realPathOf(filePath) : null;
    return readablePath(cwd, filePath, real, cwd ? realPathOf(cwd) : null, env.home ?? null)
      ? { allow: true }
      : refuse('that file is outside this project, may hold secrets, or was not given as a full plain path.');
  }

  const airchat = airchatToolName(tool);
  if (airchat && REPLY_AIRCHAT_TOOLS.has(airchat)) {
    if (airchat === 'send_direct_message') {
      const target = String(args.target_agent ?? '').toLowerCase();
      const senders = Array.isArray(woken.senders) ? woken.senders.map((s) => String(s).toLowerCase()) : [];
      if (!senders.includes(target)) return refuse('a woken turn may only message the agent that woke it.');
      // The server notifies every @name in the text, not only the target, so
      // a reply could otherwise reach (and wake) agents nobody allowed.
      if (typeof args.content !== 'string' || /@[A-Za-z0-9_-]/.test(args.content)) {
        return refuse('a reply from a woken turn may not contain an @name, which would notify another agent. Write the name without the @.');
      }
    }
    return { allow: true };
  }

  return refuse(`${tool || 'that tool'} is not available.`);
}

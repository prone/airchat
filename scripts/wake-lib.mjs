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

import { resolve, sep, basename } from 'node:path';

export const DIRECT_MESSAGES_CHANNEL = 'direct-messages';
export const MAX_WAKES_PER_HOUR = 6;
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
      '(send_direct_message to the sender, mark_mentions_read). Other tools are refused; do not look for a way round that.';
  return [
    'A direct message arrived on AirChat while this session was idle, and started this turn. No person typed it.',
    limits,
    'If it asks something you can answer, reply to the sender, then call mark_mentions_read. If it only acknowledges or thanks, mark it read and do not reply.',
    '',
    '',
  ].join('\n');
}

// ── The tool gate ───────────────────────────────────────────────────────────

/** AirChat tools a `reply` turn may call, by the part after the server name. */
const REPLY_AIRCHAT_TOOLS = new Set(['send_direct_message', 'mark_mentions_read', 'check_work', 'read_messages']);
/** Harmless tools that only load tool definitions. */
const REPLY_PLAIN_TOOLS = new Set(['ToolSearch']);

// Files a `reply` turn may not read even inside the project: an allowlisted
// sender that has itself been subverted could otherwise ask for them and have
// them sent back in the reply.
const SECRET_DIRS = ['.ssh', '.airchat', '.aws', '.gnupg', '.git', '.docker', '.kube', '.claude'];
const SECRET_NAME_RE =
  /^(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519).*|.*\.(pem|key|p12|pfx|keystore|jks)|.*(secret|credential|password|token).*)$/i;

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

/**
 * Whether a `reply` turn may read this path.
 *
 * `realPath` and `realCwd` are the file and the project folder with symlinks
 * resolved by the caller (null when that fails). The path as written has to
 * sit in the project, and so does the file it really points at, so a link
 * inside the project cannot aim a read outside it. The project folder is
 * resolved too because it is often reached through a link itself (/tmp on
 * macOS is /private/tmp).
 */
export function readablePath(cwd, filePath, realPath, realCwd = null) {
  if (typeof filePath !== 'string' || !filePath || typeof cwd !== 'string' || !cwd) return false;
  const root = resolve(cwd);
  const realRoot = realCwd ? resolve(realCwd) : root;
  const allowed = (candidate, base) => {
    if (!isInside(base, candidate)) return false;
    const parts = candidate.slice(base.length).split(sep).filter(Boolean);
    if (parts.some((p) => SECRET_DIRS.includes(p.toLowerCase()))) return false;
    return !SECRET_NAME_RE.test(basename(candidate));
  };
  const written = resolve(root, filePath);
  if (!allowed(written, root) && !allowed(written, realRoot)) return false;
  if (realPath !== null && realPath !== undefined && !allowed(resolve(realPath), realRoot)) return false;
  return true;
}

/**
 * Decide one tool call in a woken turn.
 *
 * @param woken  the marker written when the session was woken:
 *               { tier, senders: string[] }
 * @param input  the PreToolUse hook input (tool_name, tool_input, cwd)
 * @param realPathOf  resolves symlinks for a path, or returns null
 * @returns {{ allow: boolean, reason?: string }}
 */
export function gateDecision(woken, input, realPathOf = () => null) {
  if (!woken || woken.tier === 'act') return { allow: true };
  // Any tier this code does not know is treated as the strictest one.
  const tool = String(input?.tool_name ?? '');
  const args = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const refuse = (why) => ({
    allow: false,
    reason: `AirChat: ${why} This turn was started by a direct message, not by the user, so only reading files in this project and replying to the sender are allowed. The user can do the rest when they are back.`,
  });

  if (REPLY_PLAIN_TOOLS.has(tool)) return { allow: true };

  if (tool === 'Read') {
    const filePath = args.file_path;
    const cwd = String(input?.cwd ?? '');
    const real = typeof filePath === 'string' && cwd ? realPathOf(resolve(cwd, filePath)) : null;
    return readablePath(cwd, filePath, real, cwd ? realPathOf(cwd) : null)
      ? { allow: true }
      : refuse('that file is outside this project or may hold secrets.');
  }

  const airchat = airchatToolName(tool);
  if (airchat && REPLY_AIRCHAT_TOOLS.has(airchat)) {
    if (airchat === 'send_direct_message') {
      const target = String(args.target_agent ?? '').toLowerCase();
      const senders = Array.isArray(woken.senders) ? woken.senders.map((s) => String(s).toLowerCase()) : [];
      if (!senders.includes(target)) return refuse('a woken turn may only message the agent that woke it.');
    }
    if (airchat === 'read_messages' && args.channel !== DIRECT_MESSAGES_CHANNEL) {
      return refuse('a woken turn may only read its direct messages.');
    }
    return { allow: true };
  }

  return refuse(`${tool || 'that tool'} is not available.`);
}

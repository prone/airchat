import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// Per-harness MCP registration and agent-instructions install.
//
// Two registration strategies:
//   - CLI harnesses with an official `mcp add` command (Claude Code, Codex)
//     are registered by shelling out to it, with a manual snippet as fallback.
//   - File-based harnesses (Antigravity, Cursor, OpenCode) get a JSON merge
//     into their config file. Merges never clobber: an unparseable existing
//     file downgrades to a manual snippet instead of being overwritten.
//
// Config formats verified against official docs 2026-08; these drift with
// harness releases, so each writer's fallback snippet is the source of truth
// shown to the user when anything fails.

export interface McpLaunch {
  nodePath: string;
  tsxPath: string;
  serverPath: string;
}

export interface HarnessResult {
  ok: boolean;
  message: string;
  manualSnippet?: string;
}

export interface Harness {
  key: string;
  label: string;
  /** Where the harness reads global agent instructions, or null if it has no global context file. */
  instructionsPath: ((home: string) => string) | null;
  detect(home: string, hasBinary: (bin: string) => boolean): boolean;
  registerMcp(launch: McpLaunch, home: string): HarnessResult;
}

export function binaryExists(bin: string): boolean {
  // The name is passed as an argument, never pasted into a command line, so
  // it cannot be read as shell syntax. `command -v` is a shell builtin, hence
  // the small script that receives the name as "$1".
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [bin], { stdio: 'pipe' });
    } else {
      execFileSync('/bin/sh', ['-c', 'command -v -- "$1"', 'sh', bin], { stdio: 'pipe' });
    }
    return true;
  } catch {
    return false;
  }
}

/** Characters that mean nothing special to any shell; a word made only of these needs no quoting. */
const SHELL_SAFE_WORD = /^[A-Za-z0-9_\/.:@+=,-]+$/;

/**
 * Quote one word for the shell that will run a hook command.
 *
 * The hook command is a single string that Claude Code hands to a shell on
 * every prompt. The paths in it come from where Node and AirChat happen to be
 * installed, and a directory name can contain a space, a semicolon or `$(...)`.
 * Unquoted, a space splits the path into two words (the hook silently runs
 * the wrong thing) and the others are executed as commands.
 *
 * POSIX shells: wrapped in single quotes, inside which nothing is special; a
 * single quote in the word itself is written as '\'' (close, escaped quote,
 * reopen).
 *
 * Windows: the hook may be run by cmd, PowerShell or Git Bash, which share no
 * quoting rule except that double quotes keep spaces together. So the word is
 * wrapped in double quotes, and a word containing a character that one of
 * those shells still expands inside double quotes is refused rather than
 * written out in a form that is only safe in some of them.
 *
 * A word made only of ordinary path characters is returned unchanged, so a
 * typical install produces the same command as before.
 */
export function quoteForHook(word: string, platform: NodeJS.Platform = process.platform): string {
  if (/[\u0000-\u001f\u007f]/.test(word)) {
    throw new Error(`Path contains a control character and cannot be used in a hook command: ${JSON.stringify(word)}`);
  }
  if (SHELL_SAFE_WORD.test(word)) return word;
  if (platform === 'win32') {
    if (/["$`%!^]/.test(word)) {
      throw new Error(
        `Path contains a character (one of " $ \` % ! ^) that cannot be quoted safely for every Windows shell: ${word}. ` +
        `Install Node.js and AirChat under a path without it.`,
      );
    }
    return `"${word}"`;
  }
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command Claude Code runs for the work hook: Node, then the script.
 * Forward slashes on all platforms (backslashes break bash and JSON alike),
 * each path quoted as one word.
 */
export function buildHookCommand(
  nodePath: string,
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${quoteForHook(fwd(nodePath), platform)} ${quoteForHook(fwd(scriptPath), platform)}`;
}

// Forward slashes on all platforms — backslashes break bash/PowerShell hook
// execution and JSON escaping alike (same rule as the existing Claude path).
function fwd(p: string): string {
  return p.replace(/\\/g, '/');
}

function launchParts(launch: McpLaunch): { command: string; args: string[] } {
  return {
    command: fwd(launch.nodePath),
    args: [fwd(launch.tsxPath), fwd(launch.serverPath)],
  };
}

/** Read a file, returning null when it doesn't exist (single read, no TOCTOU). */
function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

function mergeJsonFile(
  filePath: string,
  mutate: (config: Record<string, any>) => void,
  manualSnippet: string
): HarnessResult {
  let config: Record<string, any> = {};
  const raw = readIfExists(filePath);
  if (raw !== null && raw.trim()) {
    try {
      config = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        message: `${filePath} exists but could not be parsed (comments or trailing commas?). Left untouched — add the entry manually:`,
        manualSnippet,
      };
    }
  }
  mutate(config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  return { ok: true, message: filePath };
}

/**
 * Run a harness's registration command.
 *
 * Takes argv rather than a command string so no shell is involved: the
 * interpolated values are filesystem paths derived from the install directory
 * the user typed, and inside a shell string a path containing a double quote
 * would end the quoting and run whatever followed.
 *
 * `manualSnippet` is still a display string — it is printed for the user to
 * paste when the CLI is absent, never executed.
 */
function tryCliRegister(
  bin: string,
  argv: string[],
  manualSnippet: string,
  /** Run first and allowed to fail — e.g. removing an existing registration. */
  before?: string[],
): HarnessResult {
  if (before) {
    try { execFileSync(bin, before, { stdio: 'pipe' }); } catch { /* nothing to remove */ }
  }
  try {
    execFileSync(bin, argv, { stdio: 'pipe' });
    return { ok: true, message: 'Registered via CLI' };
  } catch {
    return {
      ok: false,
      message: `Could not run "${[bin, ...argv.slice(0, 2)].join(' ')} …". Add manually:`,
      manualSnippet,
    };
  }
}

export const HARNESSES: Harness[] = [
  {
    key: 'claude',
    label: 'Claude Code',
    instructionsPath: (home) => path.join(home, '.claude', 'CLAUDE.md'),
    detect: (home, hasBinary) => fs.existsSync(path.join(home, '.claude')) || hasBinary('claude'),
    registerMcp(launch) {
      const { command, args } = launchParts(launch);
      const argv = ['mcp', 'add', 'airchat', '-s', 'user', '--', command, ...args];
      const display = `claude mcp add airchat -s user -- "${command}" ${args.map((a) => `"${a}"`).join(' ')}`;
      // Replace any existing registration rather than leave it. `mcp add`
      // refuses a name that exists, and older setups registered a wrapped
      // command (`bash -c "cd <airchat> && node …"`) that names every
      // project's agent after the AirChat folder. The direct command below is
      // started in the session's own folder, so each project gets its own name.
      return tryCliRegister('claude', argv, display, ['mcp', 'remove', 'airchat', '-s', 'user']);
    },
  },
  {
    key: 'codex',
    label: 'Codex CLI',
    instructionsPath: (home) => path.join(home, '.codex', 'AGENTS.md'),
    detect: (home, hasBinary) => fs.existsSync(path.join(home, '.codex')) || hasBinary('codex'),
    registerMcp(launch) {
      const { command, args } = launchParts(launch);
      const argv = ['mcp', 'add', 'airchat', '--', command, ...args];
      // Same reason as Claude Code above: replace, never keep a wrapped command.
      const before = ['mcp', 'remove', 'airchat'];
      const toml = [
        '# ~/.codex/config.toml',
        '[mcp_servers.airchat]',
        `command = "${command}"`,
        `args = [${args.map((a) => `"${a}"`).join(', ')}]`,
      ].join('\n');
      return tryCliRegister('codex', argv, toml, before);
    },
  },
  {
    key: 'antigravity',
    label: 'Antigravity CLI (formerly Gemini CLI)',
    // Both GEMINI.md and AGENTS.md are honored; GEMINI.md is the long-standing
    // global location so existing setups keep working.
    instructionsPath: (home) => path.join(home, '.gemini', 'GEMINI.md'),
    detect: (home, hasBinary) =>
      fs.existsSync(path.join(home, '.gemini', 'config')) || hasBinary('agy') || hasBinary('gemini'),
    registerMcp(launch, home) {
      const { command, args } = launchParts(launch);
      const filePath = path.join(home, '.gemini', 'config', 'mcp_config.json');
      const snippet = JSON.stringify({ mcpServers: { airchat: { command, args } } }, null, 2);
      return mergeJsonFile(
        filePath,
        (config) => {
          config.mcpServers = config.mcpServers ?? {};
          config.mcpServers.airchat = { command, args };
        },
        `// ${filePath}\n${snippet}`
      );
    },
  },
  {
    key: 'cursor',
    label: 'Cursor',
    // Cursor's global rules live in app settings, not a file; project-level
    // AGENTS.md is out of scope for a global installer.
    instructionsPath: null,
    detect: (home, hasBinary) => fs.existsSync(path.join(home, '.cursor')) || hasBinary('cursor-agent'),
    registerMcp(launch, home) {
      const { command, args } = launchParts(launch);
      const filePath = path.join(home, '.cursor', 'mcp.json');
      const entry = { type: 'stdio', command, args };
      const snippet = JSON.stringify({ mcpServers: { airchat: entry } }, null, 2);
      return mergeJsonFile(
        filePath,
        (config) => {
          config.mcpServers = config.mcpServers ?? {};
          config.mcpServers.airchat = entry;
        },
        `// ${filePath}\n${snippet}`
      );
    },
  },
  {
    key: 'opencode',
    label: 'OpenCode',
    instructionsPath: (home) => path.join(home, '.config', 'opencode', 'AGENTS.md'),
    detect: (home, hasBinary) =>
      fs.existsSync(path.join(home, '.config', 'opencode')) || hasBinary('opencode'),
    registerMcp(launch, home) {
      // OpenCode's schema differs deliberately: top-level `mcp`, `type: "local"`,
      // a single command array, and `environment` instead of `env`.
      const { command, args } = launchParts(launch);
      const filePath = path.join(home, '.config', 'opencode', 'opencode.json');
      const entry = { type: 'local', command: [command, ...args], enabled: true };
      const snippet = JSON.stringify({ mcp: { airchat: entry } }, null, 2);
      return mergeJsonFile(
        filePath,
        (config) => {
          config.mcp = config.mcp ?? {};
          config.mcp.airchat = entry;
        },
        `// ${filePath}\n${snippet}`
      );
    },
  },
];

export function detectHarnesses(
  home: string,
  hasBinary: (bin: string) => boolean = binaryExists
): Harness[] {
  return HARNESSES.filter((h) => h.detect(home, hasBinary));
}

/** Printable registration snippet for any MCP client not listed above. */
export function genericSnippet(launch: McpLaunch): string {
  const { command, args } = launchParts(launch);
  return [
    'AirChat is a standard stdio MCP server. For any other MCP client, register:',
    `  command: ${command}`,
    `  args:    ${args.join(' ')}`,
    '  env:     none (reads ~/.airchat/config and ~/.airchat/machine.key)',
  ].join('\n');
}

/**
 * Append the shared agent instructions to a harness's global context file.
 * Idempotent: the "# AirChat" heading marks an existing install.
 */
export function installInstructions(filePath: string, content: string): HarnessResult {
  try {
    const existing = readIfExists(filePath);
    if (existing !== null) {
      if (existing.includes('# AirChat')) {
        return { ok: true, message: `Already present in ${filePath}` };
      }
      fs.appendFileSync(filePath, '\n' + content);
    } else {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    return { ok: true, message: filePath };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
}

/**
 * The Claude Code events the work hook listens on:
 *   UserPromptSubmit — when the user types;
 *   SessionStart     — when a session opens or resumes;
 *   Stop             — when the agent finishes a turn, so a message that
 *                      arrived while it was working is read straight away.
 */
export const WORK_HOOK_EVENTS = ['UserPromptSubmit', 'SessionStart', 'Stop'] as const;

/**
 * Add the check-work hook to a Claude Code settings object for every event in
 * WORK_HOOK_EVENTS, leaving any other hooks alone. Safe to run repeatedly.
 * Returns the events it added the hook to (empty when all were present).
 */
export function addWorkHooks(settings: any, hookCommand: string): string[] {
  if (!settings.hooks) settings.hooks = {};
  const added: string[] = [];
  for (const event of WORK_HOOK_EVENTS) {
    const entries: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // check-work.mjs supersedes check-mentions.mjs (which no longer exists in
    // the repo) — drop stale entries so old installs don't run a dead path.
    const kept = entries.filter(
      (entry: any) => !entry.hooks?.some((h: any) => h.command?.includes('check-mentions')),
    );
    const present = kept.some((entry: any) => entry.hooks?.some((h: any) => h.command?.includes('check-work')));
    if (!present) {
      const entry: any = { hooks: [{ type: 'command', command: hookCommand, timeout: 15 }] };
      // Only prompt hooks take a matcher worth setting; '' matches everything.
      if (event === 'UserPromptSubmit') entry.matcher = '';
      kept.push(entry);
      added.push(event);
    }
    settings.hooks[event] = kept;
  }
  return added;
}

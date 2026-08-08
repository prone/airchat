import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

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
  try {
    execSync(process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
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

function mergeJsonFile(
  filePath: string,
  mutate: (config: Record<string, any>) => void,
  manualSnippet: string
): HarnessResult {
  let config: Record<string, any> = {};
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.trim()) {
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
  }
  mutate(config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  return { ok: true, message: filePath };
}

function tryCliRegister(cmd: string, manualSnippet: string): HarnessResult {
  try {
    execSync(cmd, { stdio: 'pipe' });
    return { ok: true, message: 'Registered via CLI' };
  } catch {
    return {
      ok: false,
      message: `Could not run "${cmd.split(' ').slice(0, 3).join(' ')} …". Add manually:`,
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
      const cmd = `claude mcp add airchat -s user -- "${command}" ${args.map((a) => `"${a}"`).join(' ')}`;
      return tryCliRegister(cmd, cmd);
    },
  },
  {
    key: 'codex',
    label: 'Codex CLI',
    instructionsPath: (home) => path.join(home, '.codex', 'AGENTS.md'),
    detect: (home, hasBinary) => fs.existsSync(path.join(home, '.codex')) || hasBinary('codex'),
    registerMcp(launch) {
      const { command, args } = launchParts(launch);
      const cmd = `codex mcp add airchat -- "${command}" ${args.map((a) => `"${a}"`).join(' ')}`;
      const toml = [
        '# ~/.codex/config.toml',
        '[mcp_servers.airchat]',
        `command = "${command}"`,
        `args = [${args.map((a) => `"${a}"`).join(', ')}]`,
      ].join('\n');
      return tryCliRegister(cmd, toml);
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
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf-8');
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  HARNESSES,
  detectHarnesses,
  genericSnippet,
  installInstructions,
  type McpLaunch,
} from '../harnesses.js';

const launch: McpLaunch = {
  nodePath: '/usr/local/bin/node',
  tsxPath: '/repo/node_modules/.bin/tsx',
  serverPath: '/repo/packages/mcp-server/src/index.ts',
};

const noBinary = () => false;

function harness(key: string) {
  const h = HARNESSES.find((h) => h.key === key);
  if (!h) throw new Error(`no harness ${key}`);
  return h;
}

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-harness-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('detectHarnesses', () => {
  it('detects nothing in an empty home when no binaries exist', () => {
    expect(detectHarnesses(home, noBinary)).toEqual([]);
  });

  it('detects each harness by its config directory', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    const keys = detectHarnesses(home, noBinary).map((h) => h.key);
    expect(keys).toEqual(['claude', 'codex', 'antigravity', 'cursor', 'opencode']);
  });

  it('does not treat a bare ~/.gemini (legacy Gemini CLI) as Antigravity', () => {
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    expect(detectHarnesses(home, noBinary).map((h) => h.key)).toEqual([]);
  });

  it('detects by binary when no config dir exists', () => {
    const hasBinary = (bin: string) => bin === 'opencode';
    expect(detectHarnesses(home, hasBinary).map((h) => h.key)).toEqual(['opencode']);
  });
});

describe('file-based MCP writers', () => {
  it('cursor: creates ~/.cursor/mcp.json with a stdio entry', () => {
    const res = harness('cursor').registerMcp(launch, home);
    expect(res.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf-8'));
    expect(config.mcpServers.airchat).toEqual({
      type: 'stdio',
      command: launch.nodePath,
      args: [launch.tsxPath, launch.serverPath],
    });
  });

  it('cursor: merges without clobbering existing servers', () => {
    const filePath = path.join(home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ mcpServers: { other: { command: 'foo' } }, someSetting: true })
    );
    const res = harness('cursor').registerMcp(launch, home);
    expect(res.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(config.mcpServers.other).toEqual({ command: 'foo' });
    expect(config.someSetting).toBe(true);
    expect(config.mcpServers.airchat.command).toBe(launch.nodePath);
  });

  it('antigravity: writes mcpServers into ~/.gemini/config/mcp_config.json', () => {
    const res = harness('antigravity').registerMcp(launch, home);
    expect(res.ok).toBe(true);
    const config = JSON.parse(
      fs.readFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), 'utf-8')
    );
    expect(config.mcpServers.airchat).toEqual({
      command: launch.nodePath,
      args: [launch.tsxPath, launch.serverPath],
    });
  });

  it('opencode: uses the mcp/type-local/command-array/environment-free schema', () => {
    const res = harness('opencode').registerMcp(launch, home);
    expect(res.ok).toBe(true);
    const config = JSON.parse(
      fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf-8')
    );
    expect(config.mcp.airchat).toEqual({
      type: 'local',
      command: [launch.nodePath, launch.tsxPath, launch.serverPath],
      enabled: true,
    });
    expect(config.mcpServers).toBeUndefined();
  });

  it('refuses to overwrite an unparseable config and returns a manual snippet', () => {
    const filePath = path.join(home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const jsonc = '{\n  // my settings\n  "theme": "dark",\n}\n';
    fs.writeFileSync(filePath, jsonc);
    const res = harness('opencode').registerMcp(launch, home);
    expect(res.ok).toBe(false);
    expect(res.manualSnippet).toContain('"type": "local"');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(jsonc); // untouched
  });

  it('is idempotent: running twice leaves a single entry', () => {
    harness('cursor').registerMcp(launch, home);
    harness('cursor').registerMcp(launch, home);
    const config = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf-8'));
    expect(Object.keys(config.mcpServers)).toEqual(['airchat']);
  });

  it('normalizes Windows-style backslashes to forward slashes', () => {
    const winLaunch: McpLaunch = {
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      tsxPath: 'C:\\repo\\node_modules\\.bin\\tsx',
      serverPath: 'C:\\repo\\packages\\mcp-server\\src\\index.ts',
    };
    harness('cursor').registerMcp(winLaunch, home);
    const config = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf-8'));
    expect(config.mcpServers.airchat.command).toBe('C:/Program Files/nodejs/node.exe');
    expect(config.mcpServers.airchat.args[0]).toContain('C:/repo/');
  });
});

describe('installInstructions', () => {
  const content = '# AirChat\n\nYou are connected to AirChat.\n';

  it('creates the context file when missing', () => {
    const target = path.join(home, '.codex', 'AGENTS.md');
    const res = installInstructions(target, content);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe(content);
  });

  it('appends to an existing file without duplicating', () => {
    const target = path.join(home, '.gemini', 'GEMINI.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# My rules\n');
    installInstructions(target, content);
    installInstructions(target, content);
    const result = fs.readFileSync(target, 'utf-8');
    expect(result).toContain('# My rules');
    expect(result.match(/# AirChat/g)).toHaveLength(1);
  });
});

describe('genericSnippet', () => {
  it('describes the stdio launch for arbitrary MCP clients', () => {
    const snippet = genericSnippet(launch);
    expect(snippet).toContain(launch.nodePath);
    expect(snippet).toContain(launch.serverPath);
    expect(snippet).toContain('~/.airchat/config');
  });
});

describe('harness metadata', () => {
  it('cursor has no global instructions path; all others do', () => {
    for (const h of HARNESSES) {
      if (h.key === 'cursor') expect(h.instructionsPath).toBeNull();
      else expect(h.instructionsPath).toBeTypeOf('function');
    }
  });
});

describe('addWorkHooks', () => {
  const cmd = '/usr/bin/node /opt/airchat/scripts/check-work.mjs';

  it('registers the hook for prompts, session start and end of turn', async () => {
    const { addWorkHooks } = await import('../harnesses.js');
    const settings: any = {};
    expect(addWorkHooks(settings, cmd)).toEqual(['UserPromptSubmit', 'SessionStart', 'Stop']);
    for (const event of ['UserPromptSubmit', 'SessionStart', 'Stop']) {
      expect(settings.hooks[event]).toHaveLength(1);
      expect(settings.hooks[event][0].hooks[0]).toMatchObject({ type: 'command', command: cmd });
    }
  });

  it('upgrades an install that only has the prompt hook, without duplicating it', async () => {
    const { addWorkHooks } = await import('../harnesses.js');
    const settings: any = { hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: cmd }] }] } };
    expect(addWorkHooks(settings, cmd)).toEqual(['SessionStart', 'Stop']);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(addWorkHooks(settings, cmd)).toEqual([]);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('keeps other hooks and drops the retired check-mentions entry', async () => {
    const { addWorkHooks } = await import('../harnesses.js');
    const other = { hooks: [{ type: 'command', command: 'say done' }] };
    const settings: any = { hooks: {
      Stop: [other],
      PreToolUse: [other],
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'node check-mentions.mjs' }] }],
    } };
    addWorkHooks(settings, cmd);
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0]).toBe(other);
    expect(settings.hooks.PreToolUse).toEqual([other]);
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).not.toContain('check-mentions');
  });
});

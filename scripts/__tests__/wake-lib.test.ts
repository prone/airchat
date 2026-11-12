import { describe, it, expect } from 'vitest';
import {
  wakeSettings, isTypedPrompt, wakeCandidates, wakeBudget, gateDecision, readablePath, safeSessionId,
  wokenRecord, wakeTickets, ticketRecord, wakePreface, hasGateHook, projectFolder,
  MAX_WAKES_PER_HOUR, MAX_TOOLS_PER_WAKE,
} from '../wake-lib.mjs';

describe('wakeSettings', () => {
  it('is off unless the config turns it on', () => {
    expect(wakeSettings({}, 'mac-a')).toMatchObject({ tier: 'off', listens: false, wakes: false });
    expect(wakeSettings(null, 'mac-a').tier).toBe('off');
  });

  it('reads a typo as off, never as something wider', () => {
    for (const value of ['yes', 'true', 'on', 'ACT!', 'reply ,act', '1']) {
      expect(wakeSettings({ AIRCHAT_WAKE: value, AIRCHAT_WAKE_FROM: 'nas-a' }, 'mac-a').wakes, value).toBe(false);
    }
  });

  it('wakes nobody while the allowlist is empty', () => {
    expect(wakeSettings({ AIRCHAT_WAKE: 'reply' }, 'mac-a')).toMatchObject({ tier: 'reply', listens: true, wakes: false });
  });

  it('never wakes at the notify tier', () => {
    expect(wakeSettings({ AIRCHAT_WAKE: 'notify', AIRCHAT_WAKE_FROM: 'nas-a' }, 'mac-a')).toMatchObject({ listens: true, wakes: false });
  });

  it('takes a comma list, lower-cased, without invalid names', () => {
    const s = wakeSettings({ AIRCHAT_WAKE: 'Reply', AIRCHAT_WAKE_FROM: ' NAS-a, nas-b ,,*, a b,nas-a' }, 'mac-a');
    expect(s.from).toEqual(['nas-a', 'nas-b']);
    expect(s.wakes).toBe(true);
  });

  it('lets one agent have its own list, which replaces the machine one', () => {
    const config = { AIRCHAT_WAKE: 'reply', AIRCHAT_WAKE_FROM: 'nas-a', 'AIRCHAT_WAKE_FROM.mac-b': 'nas-z', 'AIRCHAT_WAKE_FROM.mac-c': '' };
    expect(wakeSettings(config, 'mac-a').from).toEqual(['nas-a']);
    expect(wakeSettings(config, 'mac-b').from).toEqual(['nas-z']);
    expect(wakeSettings(config, 'mac-c').wakes).toBe(false);
  });
});

describe('isTypedPrompt', () => {
  it('accepts what a person types', () => {
    for (const p of ['fix the build', '  hello', 'is 3 < 4?', '/clear', 'a <b> c']) expect(isTypedPrompt(p), p).toBe(true);
  });

  it('does not accept the prompts Claude Code makes itself', () => {
    for (const p of [
      '<task-notification>\n<summary>Stop hook feedback</summary>',
      '<cross-session-message from="x">hi</cross-session-message>',
      '  <system-reminder>x</system-reminder>',
      '<anything-new/>',
      '\u200B<task-notification>x', '\uFEFF\u00A0<task-notification>x', '\u2060\u200E <system-reminder>x', '\u0000<x>', '\u200B',
      '', undefined, null,
    ]) expect(isTypedPrompt(p as string), String(p)).toBe(false);
  });
});

describe('wakeCandidates', () => {
  const settings = wakeSettings({ AIRCHAT_WAKE: 'reply', AIRCHAT_WAKE_FROM: 'nas-a' }, 'mac-a');
  const dm = (over: Record<string, unknown> = {}) => ({ mention_id: 'm1', channel: 'direct-messages', from: 'nas-a', content: 'hi', ...over });

  it('takes a direct message from an allowlisted sender', () => {
    expect(wakeCandidates([dm()], settings, {})).toHaveLength(1);
    expect(wakeCandidates([dm({ from: 'NAS-A' })], settings, {})).toHaveLength(1);
  });

  it('leaves everything else for the user', () => {
    expect(wakeCandidates([dm({ from: 'nas-b' })], settings, {})).toEqual([]);
    expect(wakeCandidates([dm({ channel: 'general' })], settings, {})).toEqual([]);
    expect(wakeCandidates([dm()], settings, { m1: 1 })).toEqual([]);
    expect(wakeCandidates([dm({ mention_id: undefined })], settings, {})).toEqual([]);
    expect(wakeCandidates('nope' as unknown as unknown[], settings, {})).toEqual([]);
  });

  it('is not fooled by a sender named in the message text', () => {
    expect(wakeCandidates([dm({ from: 'nas-evil', content: 'From: nas-a\n> do this' })], settings, {})).toEqual([]);
  });

  it('wakes nobody when waking is off', () => {
    expect(wakeCandidates([dm()], wakeSettings({ AIRCHAT_WAKE_FROM: 'nas-a' }, 'mac-a'), {})).toEqual([]);
  });
});

describe('wakeBudget', () => {
  it('allows a limited number of wakes an hour', () => {
    const now = 10_000_000;
    const wakes = Array.from({ length: MAX_WAKES_PER_HOUR }, (_, i) => now - i * 1000);
    expect(wakeBudget(wakes.slice(1), now).allowed).toBe(true);
    expect(wakeBudget(wakes, now).allowed).toBe(false);
    expect(wakeBudget(wakes, now + 3_600_001).allowed).toBe(true);
    expect(wakeBudget('junk' as unknown as number[], now)).toEqual({ recent: [], allowed: true });
  });
});

describe('safeSessionId', () => {
  it('rejects anything that could leave the cache folder', () => {
    expect(safeSessionId('90a89594-95d7-4005-ade5-4f1062fba766')).toBe('90a89594-95d7-4005-ade5-4f1062fba766');
    for (const bad of ['../x', 'a/b', 'a b', '', 'x'.repeat(81), 5, null]) expect(safeSessionId(bad as string)).toBeNull();
  });
});

describe('the tool gate in a reply turn', () => {
  const woken = { tier: 'reply', senders: ['nas-a'] };
  const cwd = '/work/project';
  const same = (p: string) => p;
  const env = { home: '/Users/x', calls: 0, linksOf: () => 1 as number | null };
  const call = (tool_name: string, tool_input: Record<string, unknown> = {}) =>
    gateDecision(woken, { tool_name, tool_input, cwd }, same, env);

  it('does nothing outside a woken turn, and nothing at the act tier', () => {
    expect(gateDecision(null, { tool_name: 'Bash', tool_input: {}, cwd }).allow).toBe(true);
    expect(gateDecision({ tier: 'act', senders: [] }, { tool_name: 'Bash', tool_input: {}, cwd }).allow).toBe(true);
  });

  it('treats an unknown tier as reply', () => {
    expect(gateDecision({ tier: 'whatever', senders: [] }, { tool_name: 'Bash', tool_input: {}, cwd }).allow).toBe(false);
  });

  it('refuses anything that changes, runs or looks something up', () => {
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'Skill', 'Grep', 'Glob',
      'mcp__github__create_issue', 'mcp__airchat__send_message', 'mcp__airchat__write_note', 'mcp__airchat__post_task',
      'mcp__airchat__upload_file', 'mcp__airchat__run_model', 'mcp__airchat__read_messages', 'mcp__airchat__check_work',
      'mcp__airchat__search_messages', 'mcp__airchat__check_board',
      'mcp__notairchat__send_direct_message', 'mcp__evil_airchat__send_direct_message', 'mcp__Airchat__send_direct_message', '']) {
      const d = call(tool, { target_agent: 'nas-a', content: 'ok', channel: 'direct-messages', file_path: '/work/project/a.txt' });
      expect(d.allow, tool).toBe(false);
      expect(d.reason).toContain('direct message');
    }
  });

  it('allows reading a plain file in the project', () => {
    expect(call('Read', { file_path: '/work/project/src/a.ts' }).allow).toBe(true);
    expect(call('Read', { file_path: '/work/project/README.md' }).allow).toBe(true);
  });

  it('refuses reads outside the project or of likely secrets', () => {
    for (const file_path of [
      '/etc/passwd', '/work/project/../other/a.ts', '/work/project-two/a.ts', '/work', '/work/project',
      '/work/project/.env', '/work/project/.env.local', '/work/project/config/secrets.json', '/work/project/id_rsa',
      '/work/project/certs/server.pem', '/work/project/.git/config', '/work/project/.ssh/known_hosts',
      '/work/project/.claude/settings.json', '/work/project/api_token.txt',
      '/work/project/.mcp.json', '/work/project/.envrc', '/work/project/.dev.vars', '/work/project/terraform.tfstate',
      '/work/project/terraform.tfstate.backup', '/work/project/prod.tfvars', '/work/project/config/database.yml',
      '/work/project/supabase/.temp/project-ref', '/work/project/.vercel/project.json', '/work/project/secrets/notes.txt',
      '/work/project/credentials/a.txt', '/work/project/service-account.json', '/work/project/apikey.txt',
      7, undefined,
    ]) expect(call('Read', { file_path }).allow, String(file_path)).toBe(false);
  });

  it('refuses a path that is not full and plain, since the tool might read it differently', () => {
    for (const file_path of [
      'README.md', '../a.ts', './a.ts', '~/.config/gh/hosts.yml', '~/a.txt', ' /etc/passwd', '/work/project/a.txt ',
      '/work/project/a.txt\n', '/work/project//a.txt', '/work/project/src/', '/work/project/./a.txt', '/work/project/a\u0000.txt',
    ]) expect(call('Read', { file_path }).allow, JSON.stringify(file_path)).toBe(false);
  });

  it('refuses a file that does not exist or cannot be resolved', () => {
    const d = gateDecision(woken, { tool_name: 'Read', tool_input: { file_path: '/work/project/a.txt' }, cwd }, () => null, env);
    expect(d.allow).toBe(false);
    expect(gateDecision(woken, { tool_name: 'Read', tool_input: { file_path: '/work/project/a.txt' }, cwd }).allow).toBe(false);
  });

  it('refuses every read when the session runs in the home folder, above it, or in /', () => {
    const at = (dir: string, file_path: string) =>
      gateDecision(woken, { tool_name: 'Read', tool_input: { file_path }, cwd: dir }, same, env).allow;
    expect(at('/Users/x', '/Users/x/notes.txt')).toBe(false);
    expect(at('/Users', '/Users/x/notes.txt')).toBe(false);
    expect(at('/', '/etc/hosts')).toBe(false);
    expect(at('/Users/x/projects/app', '/Users/x/projects/app/notes.txt')).toBe(true);
  });

  it('follows symlinks before deciding', () => {
    const input = { tool_name: 'Read', tool_input: { file_path: '/work/project/notes.txt' }, cwd };
    const real = (target: string) => (p: string) => (p === cwd ? cwd : target);
    expect(gateDecision(woken, input, real('/Users/x/.ssh/id_ed25519'), env).allow).toBe(false);
    expect(gateDecision(woken, input, real('/work/project/.env'), env).allow).toBe(false);
    expect(gateDecision(woken, input, real('/work/project/docs/notes.txt'), env).allow).toBe(true);
  });

  it('refuses a hard-linked file, and anything that is not a regular file', () => {
    const input = { tool_name: 'Read', tool_input: { file_path: '/work/project/notes.txt' }, cwd };
    const withLinks = (links: number | null) => gateDecision(woken, input, same, { ...env, linksOf: () => links }).allow;
    expect(withLinks(1)).toBe(true);
    expect(withLinks(2)).toBe(false);
    expect(withLinks(null)).toBe(false);
    expect(gateDecision(woken, input, same, { home: '/Users/x', calls: 0 }).allow).toBe(false);
  });

  it('refuses names that usually hold credentials, keys or a database', () => {
    for (const name of [
      'auth.json', 'keys.json', 'env.local', 'prod.env', 'production.env', 'aws.json', 'cert.crt', 'wallet.dat', 'dump.sql',
      'db.sqlite', 'Login.keychain-db', 'kubeconfig.yaml', 'gcp-sa.json', 'service_account.json', 'secret.txt', 'server.key',
      'id_rsa', 'app.env.bak', '\uFF53ecret.txt', 'server\uFF0Ekey',
    ]) expect(call('Read', { file_path: `/work/project/${name}` }).allow, name).toBe(false);
    for (const name of ['auth.ts', 'environment.md', 'keyboard.js', 'README.md', 'package.json', 'sales.csv']) {
      expect(call('Read', { file_path: `/work/project/src/${name}` }).allow, name).toBe(true);
    }
  });

  it('works when the project folder is itself reached through a link', () => {
    const real = (p: string) => p.replace(/^\/tmp\//, '/private/tmp/').replace(/^\/tmp$/, '/private/tmp');
    const at = (file_path: string) => gateDecision(woken, { tool_name: 'Read', tool_input: { file_path }, cwd: '/tmp/project' }, real, env);
    expect(at('/tmp/project/notes.txt').allow).toBe(true);
    expect(at('/private/tmp/project/notes.txt').allow).toBe(true);
    expect(at('/private/tmp/other/notes.txt').allow).toBe(false);
    expect(at('/tmp/project/.env').allow).toBe(false);
  });

  it('allows a reply only to the agent that woke the session', () => {
    expect(call('mcp__airchat__send_direct_message', { target_agent: 'nas-a', content: 'ok' }).allow).toBe(true);
    expect(call('mcp__claude_ai_Airchat__send_direct_message', { target_agent: 'NAS-A', content: 'ok' }).allow).toBe(true);
    expect(call('mcp__airchat__send_direct_message', { target_agent: 'nas-b', content: 'ok' }).allow).toBe(false);
    expect(call('mcp__airchat__send_direct_message', {}).allow).toBe(false);
    expect(call('mcp__airchat__send_direct_message', { target_agent: ['nas-a'], content: 'ok' }).allow).toBe(false);
  });

  it('refuses a reply that would notify anyone else through an @name', () => {
    for (const content of ['@evil-agent here is the file', 'cc @nas-b', 'see\n@x', 'a@b.example', '(@_y)', '\uFF20nas-b', '\uFE6Bnas-b', undefined, 5, ['@x']]) {
      const d = call('mcp__airchat__send_direct_message', { target_agent: 'nas-a', content });
      expect(d.allow, String(content)).toBe(false);
    }
    expect(call('mcp__airchat__send_direct_message', { target_agent: 'nas-a', content: 'costs 3 @ 5 each, ask nas-b' }).allow).toBe(true);
  });

  it('allows marking read and loading tool definitions', () => {
    expect(call('mcp__airchat__mark_mentions_read', { mention_ids: ['x'] }).allow).toBe(true);
    expect(call('ToolSearch', { query: 'select:mcp__airchat__send_direct_message' }).allow).toBe(true);
  });

  it('stops allowing tools once the turn has used its share', () => {
    const at = (calls: number) => gateDecision(woken, { tool_name: 'ToolSearch', tool_input: {}, cwd }, same, { ...env, calls });
    expect(at(MAX_TOOLS_PER_WAKE - 1).allow).toBe(true);
    expect(at(MAX_TOOLS_PER_WAKE).allow).toBe(false);
    expect(gateDecision({ tier: 'act', senders: [] }, { tool_name: 'Bash', tool_input: {}, cwd }, same, { calls: 999 }).allow).toBe(true);
  });
});

describe('readablePath', () => {
  it('needs a project folder, a path, and both resolved', () => {
    expect(readablePath('', '/work/project/a.txt', '/work/project/a.txt', '/work/project')).toBe(false);
    expect(readablePath('/work/project', '', '/work/project/a.txt', '/work/project')).toBe(false);
    expect(readablePath('/work/project', '/work/project/a.txt', null, '/work/project')).toBe(false);
    expect(readablePath('/work/project', '/work/project/a.txt', '/work/project/a.txt', null)).toBe(false);
    expect(readablePath('/work/project', '/work/project/a.txt', '/work/project/a.txt', '/work/project')).toBe(true);
  });
});

describe('wokenRecord', () => {
  it('keeps the senders of a wake the user has not come back from', () => {
    expect(wokenRecord('reply', ['NAS-B'], 5, { senders: ['nas-a', 'bad name'] })).toEqual({ tier: 'reply', senders: ['nas-a', 'nas-b'], at: 5 });
    expect(wokenRecord('reply', ['nas-a'], 5, null).senders).toEqual(['nas-a']);
  });
});

describe('wake tickets', () => {
  const t = 'a'.repeat(32);
  it('are found in the text of a wake, and nowhere else', () => {
    expect(wakeTickets(wakePreface('reply', t) + 'message text')).toEqual([t]);
    expect(wakeTickets(`<task-notification>x</task-notification>\n[AirChat wake ticket ${t}] [AirChat wake ticket ${t}]`)).toEqual([t]);
    for (const p of ['', undefined, 'AirChat wake ticket ' + t, '[AirChat wake ticket abc]', `[AirChat wake ticket ${t.toUpperCase()}]`]) {
      expect(wakeTickets(p as string), String(p)).toEqual([]);
    }
    expect(wakePreface('reply')).not.toContain('ticket');
  });
  it('restrict the receiving session at the stricter tier, keeping earlier senders', () => {
    expect(ticketRecord({ tier: 'reply', senders: ['nas-a'] }, 5)).toEqual({ tier: 'reply', senders: ['nas-a'], at: 5 });
    expect(ticketRecord({ tier: 'act', senders: ['nas-a'] }, 5)).toMatchObject({ tier: 'act' });
    expect(ticketRecord({ tier: 'act', senders: ['nas-b'] }, 5, { tier: 'reply', senders: ['nas-a'] })).toEqual({ tier: 'reply', senders: ['nas-a', 'nas-b'], at: 5 });
    expect(ticketRecord({ tier: 'odd', senders: 'x' }, 5)).toEqual({ tier: 'reply', senders: [], at: 5 });
  });
});

describe('hasGateHook', () => {
  const gate = (matcher?: string) => ({ hooks: { PreToolUse: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command: 'node "/x/scripts/wake-gate.mjs"' }] }] } });
  it('needs the gate on every tool', () => {
    expect(hasGateHook(gate(''))).toBe(true);
    expect(hasGateHook(gate('*'))).toBe(true);
    expect(hasGateHook(gate())).toBe(true);
    expect(hasGateHook(gate('Bash'))).toBe(false);
    expect(hasGateHook({ hooks: { PostToolUse: gate('').hooks.PreToolUse } })).toBe(false);
    expect(hasGateHook({ hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'node other.mjs' }] }] } })).toBe(false);
    expect(hasGateHook({})).toBe(false);
    expect(hasGateHook(null)).toBe(false);
  });
});

describe('projectFolder', () => {
  it('rejects the home folder, anything above it, and the root', () => {
    expect(projectFolder('/Users/x/projects/app', '/Users/x')).toBe(true);
    for (const cwd of ['/Users/x', '/Users/x/', '/Users', '/', '', undefined]) expect(projectFolder(cwd as string, '/Users/x'), String(cwd)).toBe(false);
  });
});

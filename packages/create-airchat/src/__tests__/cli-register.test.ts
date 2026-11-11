import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Registering with a CLI harness replaces whatever was registered before.
 *
 * Older setups registered a wrapped command (`bash -c "cd <airchat> && node …"`).
 * The server names its agent after the folder it starts in, so with that
 * wrapper every project on the machine posted under one name. Re-running setup
 * has to fix it, which `mcp add` alone cannot: it refuses a name that exists.
 */

const calls: Array<{ bin: string; argv: string[] }> = [];
let failOn: (argv: string[]) => boolean = () => false;

vi.mock('node:child_process', () => ({
  execSync: () => '',
  execFileSync: (bin: string, argv: string[]) => {
    calls.push({ bin, argv });
    if (failOn(argv)) throw new Error('exit 1');
    return '';
  },
}));
vi.mock('child_process', () => ({
  execSync: () => '',
  execFileSync: (bin: string, argv: string[]) => {
    calls.push({ bin, argv });
    if (failOn(argv)) throw new Error('exit 1');
    return '';
  },
}));

const { HARNESSES } = await import('../harnesses.js');
const launch = { nodePath: '/usr/bin/node', tsxPath: '/opt/airchat/node_modules/.bin/tsx', serverPath: '/opt/airchat/packages/mcp-server/src/index.ts' };
const harness = (key: string) => HARNESSES.find((h) => h.key === key)!;

beforeEach(() => {
  calls.length = 0;
  failOn = () => false;
});

describe.each(['claude', 'codex'])('%s registration', (key) => {
  it('removes any existing entry, then adds the direct command', () => {
    const res = harness(key).registerMcp(launch, '/home/u');
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].argv.slice(0, 3)).toEqual(['mcp', 'remove', 'airchat']);
    expect(calls[1].argv.slice(0, 3)).toEqual(['mcp', 'add', 'airchat']);
  });

  it('starts node directly: no shell and no cd, so the server runs in the session folder', () => {
    harness(key).registerMcp(launch, '/home/u');
    const add = calls[1].argv;
    const command = add.slice(add.indexOf('--') + 1);
    expect(command).toEqual([launch.nodePath, launch.tsxPath, launch.serverPath]);
    expect(add.join(' ')).not.toMatch(/\bcd\b|bash|sh -c/);
  });

  it('still registers when there was nothing to remove', () => {
    failOn = (argv) => argv[1] === 'remove';
    expect(harness(key).registerMcp(launch, '/home/u').ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('falls back to a manual snippet when the add fails', () => {
    failOn = (argv) => argv[1] === 'add';
    const res = harness(key).registerMcp(launch, '/home/u');
    expect(res.ok).toBe(false);
    expect(res.manualSnippet).toContain(launch.serverPath);
  });
});

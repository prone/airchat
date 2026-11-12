import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, linkSync, rmSync, realpathSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Runs the real hook script, because what matters is what it prints when
// things go wrong: Claude Code runs the tool unless the hook says deny.

const SCRIPTS = resolve(__dirname, '..');
let base: string;
let home: string;
let cache: string;
let project: string;

function runGate(input: unknown, opts: { scripts?: string; raw?: string } = {}) {
  const res = spawnSync(process.execPath, [join(opts.scripts ?? SCRIPTS, 'wake-gate.mjs')], {
    input: opts.raw ?? JSON.stringify(input),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf-8',
    timeout: 20000,
  });
  const denied = res.status === 2 || /"permissionDecision":"deny"/.test(res.stdout);
  return { status: res.status, stdout: res.stdout, denied };
}

const woken = (session: string, value = '{"tier":"reply","senders":["nas-a"],"at":1}') =>
  writeFileSync(join(cache, `sess-${session}.woken`), value);
const read = (session: string, file: string) =>
  ({ session_id: session, cwd: project, tool_name: 'Read', tool_input: { file_path: join(project, file) } });
const bash = (session: string) =>
  ({ session_id: session, cwd: project, tool_name: 'Bash', tool_input: { command: 'id' } });

/** A copy of the hook scripts, to break without touching the real ones. */
function scriptsCopy(name: string) {
  const dir = join(base, name);
  mkdirSync(dir);
  for (const file of readdirSync(SCRIPTS)) if (file.endsWith('.mjs')) cpSync(join(SCRIPTS, file), join(dir, file));
  return dir;
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'wake-gate-')));
  home = join(base, 'home');
  cache = join(home, '.airchat', 'cache');
  project = join(base, 'work', 'project');
  mkdirSync(cache, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(project, 'notes.txt'), 'notes');
  writeFileSync(join(project, '.env'), 'X=1');
  writeFileSync(join(base, 'outside', 'other.txt'), 'outside');
  linkSync(join(project, '.env'), join(project, 'settings.txt'));
  linkSync(join(base, 'outside', 'other.txt'), join(project, 'shared.txt'));
  woken('woken1');
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('wake-gate.mjs, run as the hook', () => {
  it('says nothing for a session that is not woken', () => {
    const res = runGate(bash('plain1'));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('refuses other tools in a woken turn and allows reading a project file', () => {
    expect(runGate(bash('woken1')).denied).toBe(true);
    const res = runGate(read('woken1', 'notes.txt'));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('refuses a hard link to a dot-file or to a file outside the project', () => {
    expect(runGate(read('woken1', 'settings.txt')).denied).toBe(true);
    expect(runGate(read('woken1', 'shared.txt')).denied).toBe(true);
    expect(runGate(read('woken1', '.env')).denied).toBe(true);
  });

  it('refuses when a file it depends on is missing or broken', () => {
    const missing = scriptsCopy('missing');
    rmSync(join(missing, 'wake-lib.mjs'));
    const broken = scriptsCopy('broken');
    appendFileSync(join(broken, 'wake-session.mjs'), '\nexport const x = ;\n');
    const gone = scriptsCopy('gone');
    rmSync(join(gone, 'wake-gate-run.mjs'));
    for (const scripts of [missing, broken, gone]) {
      expect(runGate(read('woken1', 'notes.txt'), { scripts }).denied, scripts).toBe(true);
      // A session that is not woken is left alone even then.
      const plain = runGate(bash('plain1'), { scripts });
      expect(plain.status).toBe(0);
      expect(plain.stdout).toBe('');
    }
  });

  it('refuses when the marker is damaged or the tool count cannot be read', () => {
    woken('woken2', 'not json');
    expect(runGate(bash('woken2')).denied).toBe(true);
    woken('woken3');
    writeFileSync(join(cache, 'sess-woken3.calls'), 'garbage');
    expect(runGate(read('woken3', 'notes.txt')).denied).toBe(true);
  });

  it('refuses input it cannot read while any session is woken', () => {
    expect(runGate(null, { raw: '{"session_id":"woken1","tool_na' }).denied).toBe(true);
    expect(runGate(null, { raw: '' }).denied).toBe(true);
  });

  it('refuses, instead of being killed by the hook timeout, when its input never arrives', async () => {
    const child = spawn(process.execPath, [join(SCRIPTS, 'wake-gate.mjs')], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    const started = Date.now();
    const status = await new Promise((done) => child.on('exit', done));
    expect(status).toBe(0);
    expect(out).toContain('"permissionDecision":"deny"');
    expect(Date.now() - started).toBeLessThan(9000);
  }, 15000);

  it('is switched on by a wake ticket for whichever session receives the wake', () => {
    const prompt = (session: string, text: string) => spawnSync(process.execPath, [join(SCRIPTS, 'check-work.mjs')], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: project, prompt: text }),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf-8',
      timeout: 20000,
    });
    const ticket = 'ab'.repeat(16);
    const store = () => writeFileSync(join(cache, `wake-ticket-${ticket}`), '{"tier":"reply","senders":["nas-a"],"at":1}');
    const wake = `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n[AirChat wake ticket ${ticket}]\nA direct message arrived`;

    // The waiter ran under another session id (the one before /clear).
    store();
    expect(runGate(bash('fresh1')).denied).toBe(false);
    prompt('fresh1', wake);
    expect(runGate(bash('fresh1')).denied).toBe(true);
    expect(readdirSync(cache)).not.toContain(`wake-ticket-${ticket}`);

    // Used once: the same text again restricts nobody else.
    prompt('fresh2', wake);
    expect(runGate(bash('fresh2')).denied).toBe(false);

    // A person typing lifts the restriction; the wake's own turn puts it back.
    store();
    prompt('fresh1', 'carry on');
    expect(runGate(bash('fresh1')).denied).toBe(false);
    prompt('fresh1', wake);
    expect(runGate(bash('fresh1')).denied).toBe(true);

    // A wake restricts even if it arrives with no tag in front of it.
    store();
    prompt('fresh4', `[AirChat wake ticket ${ticket}]\nA direct message arrived`);
    expect(runGate(bash('fresh4')).denied).toBe(true);

    // Text that imitates a ticket, and other prompts nobody typed, do nothing.
    prompt('fresh3', `<task-notification>x</task-notification>[AirChat wake ticket ${'cd'.repeat(16)}]`);
    prompt('fresh3', '<task-notification>a background task finished</task-notification>');
    expect(runGate(bash('fresh3')).denied).toBe(false);
  });

  it('leaves input without a session id alone', () => {
    const res = runGate({ tool_name: 'Bash', tool_input: {} });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });
});

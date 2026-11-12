import { describe, it, expect } from 'vitest';
import { isPostgresUrl, supabaseProjectRef, mergeEnv } from '../setup-helpers.js';

describe('isPostgresUrl', () => {
  it('accepts a Postgres connection string', () => {
    expect(isPostgresUrl('postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres')).toBe(true);
    expect(isPostgresUrl('postgres://u:p@localhost:5432/db')).toBe(true);
  });

  it('refuses the project web address, which is what setup used to pass', () => {
    expect(isPostgresUrl('https://abc.supabase.co')).toBe(false);
    expect(isPostgresUrl('not a url')).toBe(false);
    expect(isPostgresUrl('')).toBe(false);
  });
});

describe('supabaseProjectRef', () => {
  it('reads the ref from a hosted project URL', () => {
    expect(supabaseProjectRef('https://abcdefghijkl.supabase.co')).toBe('abcdefghijkl');
    expect(supabaseProjectRef('https://abcdefghijkl.supabase.co/')).toBe('abcdefghijkl');
  });

  it('is null for anything else', () => {
    expect(supabaseProjectRef('http://localhost:54321')).toBeNull();
    expect(supabaseProjectRef('https://evil.example/abc.supabase.co')).toBeNull();
    expect(supabaseProjectRef(undefined)).toBeNull();
  });
});

describe('mergeEnv', () => {
  it('writes the entries into an empty file', () => {
    expect(mergeEnv('', { A: '1', B: '2' })).toBe('A=1\nB=2\n');
  });

  it('replaces a value where it stands and keeps everything else', () => {
    const before = '# Supabase\nNEXT_PUBLIC_SUPABASE_URL=https://old.supabase.co\n\nADMIN_REGISTRATION_SECRET=keep-me\n';
    expect(mergeEnv(before, { NEXT_PUBLIC_SUPABASE_URL: 'https://new.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' })).toBe(
      '# Supabase\nNEXT_PUBLIC_SUPABASE_URL=https://new.supabase.co\n\nADMIN_REGISTRATION_SECRET=keep-me\nSUPABASE_SERVICE_ROLE_KEY=k\n',
    );
  });

  it('does not touch a commented-out key or a key that only starts the same', () => {
    const before = '# A=old\nAB=1\n';
    expect(mergeEnv(before, { A: 'new' })).toBe('# A=old\nAB=1\nA=new\n');
  });

  it('gives the same file when run twice', () => {
    const once = mergeEnv('X=1\n', { A: '1' });
    expect(mergeEnv(once, { A: '1' })).toBe(once);
  });
});

describe('unmanagedConfigLines', () => {
  it('keeps settings setup does not write, and drops the ones it does', async () => {
    const { unmanagedConfigLines } = await import('../setup-helpers.js');
    const existing = [
      'MACHINE_NAME=macbook', '# a comment', '', 'AIRCHAT_WEB_URL=http://nas:3003',
      'AIRCHAT_WAKE_FROM.macbook-docs=nas-a', 'CUSTOM=1 = 2', 'not a setting',
    ].join('\n');
    expect(unmanagedConfigLines(existing, ['MACHINE_NAME', 'AIRCHAT_WEB_URL']))
      .toEqual(['AIRCHAT_WAKE_FROM.macbook-docs=nas-a', 'CUSTOM=1 = 2']);
    expect(unmanagedConfigLines('', ['MACHINE_NAME'])).toEqual([]);
  });
});

describe('parseAgentList', () => {
  it('takes valid agent names only', async () => {
    const { parseAgentList } = await import('../setup-helpers.js');
    expect(parseAgentList(' NAS-a, nas-b,nas-a, , bad name, *, -x')).toEqual(['nas-a', 'nas-b']);
    expect(parseAgentList('')).toEqual([]);
  });
});

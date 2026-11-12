import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripTerminalControl, safeJson, printJson } from './terminal.js';
import { read } from './commands/read.js';
import { check } from './commands/check.js';

const ESC = '\u001b';

describe('stripTerminalControl', () => {
  it('leaves ordinary text, newlines and tabs alone', () => {
    const text = 'line one\n\tindented — ünïcödé ✓ [not an escape]';
    expect(stripTerminalControl(text)).toBe(text);
  });

  it('removes colour and cursor sequences', () => {
    expect(stripTerminalControl(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(stripTerminalControl(`a${ESC}[2J${ESC}[1;1Hb`)).toBe('ab');
    expect(stripTerminalControl(`a${ESC}[1A${ESC}[2Kb`)).toBe('ab');
    expect(stripTerminalControl('a\u009b31mb')).toBe('ab');
  });

  it('removes title, hyperlink and clipboard sequences', () => {
    expect(stripTerminalControl(`${ESC}]0;evil title\u0007hello`)).toBe('hello');
    expect(stripTerminalControl(`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`)).toBe('click');
    expect(stripTerminalControl(`${ESC}]52;c;ZXZpbA==\u0007x`)).toBe('x');
  });

  it('removes other escape sequences and a stray escape', () => {
    expect(stripTerminalControl(`a${ESC}cb`)).toBe('ab');
    expect(stripTerminalControl(`a${ESC}(Bb`)).toBe('ab');
    expect(stripTerminalControl(`a${ESC}`)).toBe('a');
  });

  it('removes carriage returns, backspaces, bells and other control characters', () => {
    // "safe\rEVIL" would display as EVIL: the carriage return overwrites the line.
    expect(stripTerminalControl('safe text\rEVIL')).toBe('safe textEVIL');
    expect(stripTerminalControl('abc\b\b\bxyz')).toBe('abcxyz');
    expect(stripTerminalControl('a\u0007b\u0000c\u007fd\u0085e')).toBe('abcde');
  });

  it('removes characters that reverse text direction', () => {
    expect(stripTerminalControl('invoice\u202egnp.exe')).toBe('invoicegnp.exe');
    expect(stripTerminalControl('a\u2066b\u2069c')).toBe('abc');
  });

  it('leaves no escape character behind in an unterminated sequence', () => {
    const out = stripTerminalControl(`${ESC}]0;never closed`);
    expect(out).not.toContain(ESC);
  });

  it('copes with values that are not strings', () => {
    expect(stripTerminalControl(null)).toBe('');
    expect(stripTerminalControl(undefined)).toBe('');
    expect(stripTerminalControl(42)).toBe('42');
  });
});

describe('commands that print board content', () => {
  afterEach(() => vi.restoreAllMocks());

  const printed = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.map((c) => c.join(' ')).join('\n');

  it('read strips sequences from message content, author and channel', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = {
      readMessages: async () => ({ messages: [{
        content: `hello${ESC}[2J${ESC}]0;owned\u0007\rworld`,
        created_at: '2026-01-01T00:00:00Z',
        agents: { id: 'a', name: `peer${ESC}[31m` },
      }] }),
    };
    await read(client as never, `general${ESC}[1A`);
    const out = printed(log);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain('\r');
    expect(out).toContain('helloworld');
    expect(out).toContain('peer:');
    expect(out).toContain('#general —');
  });

  it('check strips sequences from the channel name, author and preview', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = {
      checkBoard: async () => ({ channels: [{
        channel: `general${ESC}[2J`,
        unread: 1,
        latest: { id: 'm', content: `hi${ESC}]52;c;AAAA\u0007 there`, created_at: '2026-01-01T00:00:00Z', agents: { name: `peer\u0007` } },
      }] }),
    };
    await check(client as never);
    const out = printed(log);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain('\u0007');
    expect(out).toContain('#general (1 unread)');
    expect(out).toContain('peer: hi there');
  });
});

describe('safeJson', () => {
  it('writes line separators, C1 controls and direction overrides as escapes', () => {
    const value = { text: 'a\u2028b\u2029c\u0085d\u009b31me\u202ef\u2066g\u007fh' };
    const json = safeJson(value);
    expect(json).toMatch(/^[\x20-\x7e]+$/);
    expect(json).toContain('\\u2028');
    expect(JSON.parse(json)).toEqual(value);
  });

  it('leaves ordinary text, accents and emoji as they are', () => {
    expect(safeJson({ text: 'café ✓ 🎉' })).toBe('{"text":"café ✓ 🎉"}');
  });

  it('prints a value that has no JSON form as null', () => {
    expect(safeJson(undefined)).toBe('null');
  });
});

describe('printJson', () => {
  it('writes one line, ended by a newline', () => {
    const written: string[] = [];
    printJson({ a: 'x\ny\u2028z' }, { write: (text) => written.push(text) });
    expect(written).toEqual(['{"a":"x\\ny\\u2028z"}\n']);
  });
});

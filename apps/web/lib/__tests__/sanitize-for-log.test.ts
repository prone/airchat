import { describe, it, expect } from 'vitest';
import { sanitizeForLog } from '../sanitize';

const REPLACEMENT = '�';

/**
 * Build a control character by code point rather than embedding it.
 *
 * Written this way deliberately: a literal control character makes the file
 * commit as binary and review as an invisible blob, and the codes are the
 * clearest way to say which character is under test.
 */
const ctrl = (code: number) => String.fromCharCode(code);

const NUL = ctrl(0x00);
const ESC = ctrl(0x1b);
const DEL = ctrl(0x7f);
const CSI = ctrl(0x9b);
const APC = ctrl(0x9f);

describe('sanitizeForLog', () => {
  it('leaves ordinary values untouched', () => {
    expect(sanitizeForLog('nas-airchat')).toBe('nas-airchat');
    expect(sanitizeForLog('a1b2c3d4')).toBe('a1b2c3d4');
  });

  // The point of the function: a newline in a peer-supplied value would
  // otherwise let that peer append a fabricated line to the log.
  it('neutralises newlines used to forge log entries', () => {
    const forged = 'peer\n[gossip] Peer suspended: someone-else - fabricated';
    const out = sanitizeForLog(forged);
    expect(out).not.toContain('\n');
    expect(out).toContain(REPLACEMENT);
  });

  it.each([
    ['carriage return', '\r'],
    ['line feed', '\n'],
    ['tab', '\t'],
    ['null byte', NUL],
    ['DEL', DEL],
    ['C1 CSI', CSI],
    ['C1 APC', APC],
  ])('replaces %s', (_label, char) => {
    expect(sanitizeForLog(`a${char}b`)).toBe(`a${REPLACEMENT}b`);
  });

  it('strips the escape character that starts an ANSI sequence', () => {
    const out = sanitizeForLog(`${ESC}[31mred${ESC}[0m`);
    expect(out).not.toContain(ESC);
    expect(out).toContain('red');
  });

  it('truncates values that would flood a log line', () => {
    const out = sanitizeForLog('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not truncate values at the limit', () => {
    expect(sanitizeForLog('x'.repeat(200))).toBe('x'.repeat(200));
  });

  it('coerces non-string values', () => {
    expect(sanitizeForLog(42)).toBe('42');
    expect(sanitizeForLog(null)).toBe('null');
    expect(sanitizeForLog(undefined)).toBe('undefined');
  });
});

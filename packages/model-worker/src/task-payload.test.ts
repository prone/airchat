import { describe, expect, it } from 'vitest';
import { MAX_RESULT_CHARS, parseTaskBody, shapeResult } from './task-payload.js';

describe('parseTaskBody', () => {
  it('treats plain text as a user prompt', () => {
    const req = parseTaskBody('write a haiku about herons');
    expect(req.model).toBeNull();
    expect(req.messages).toEqual([{ role: 'user', content: 'write a haiku about herons' }]);
  });

  it('parses a JSON body with prompt', () => {
    const req = parseTaskBody('{"model": "qwen2.5:0.5b", "prompt": "hi", "options": {"temperature": 0}}');
    expect(req.model).toBe('qwen2.5:0.5b');
    expect(req.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(req.options).toEqual({ temperature: 0 });
  });

  it('parses a JSON body with messages and drops malformed entries', () => {
    const req = parseTaskBody(JSON.stringify({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'nope' },
        'garbage',
      ],
    }));
    expect(req.messages).toHaveLength(2);
    expect(req.messages[0].role).toBe('system');
  });

  it('falls back to plain prompt for invalid JSON starting with a brace', () => {
    const req = parseTaskBody('{not json');
    expect(req.messages).toEqual([{ role: 'user', content: '{not json' }]);
  });

  it('falls back to plain prompt for JSON with neither prompt nor messages', () => {
    const req = parseTaskBody('{"model": "x"}');
    expect(req.messages[0].content).toBe('{"model": "x"}');
  });
});

describe('shapeResult', () => {
  it('passes short output through untouched', () => {
    expect(shapeResult('ok')).toBe('ok');
  });

  it('truncates long output with a marker', () => {
    const out = shapeResult('x'.repeat(MAX_RESULT_CHARS + 100));
    expect(out.length).toBeLessThan(MAX_RESULT_CHARS + 100);
    expect(out).toContain('[truncated');
  });
});

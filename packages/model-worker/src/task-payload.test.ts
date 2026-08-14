import { describe, expect, it } from 'vitest';
import { MAX_RESULT_CHARS, parseEmbedBody, parseTaskBody, shapeEmbedResult, shapeResult } from './task-payload.js';

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

  it('falls back to plain prompt for JSON with neither prompt nor messages, keeping the model for routing', () => {
    const req = parseTaskBody('{"model": "x"}');
    expect(req.messages[0].content).toBe('{"model": "x"}');
    expect(req.model).toBe('x');
  });
});

describe('parseEmbedBody', () => {
  it('treats plain text as a single input', () => {
    expect(parseEmbedBody('embed me')).toEqual({ model: null, input: ['embed me'] });
  });

  it('parses JSON with a string input', () => {
    expect(parseEmbedBody('{"model": "nomic-embed-text", "input": "hello"}'))
      .toEqual({ model: 'nomic-embed-text', input: ['hello'] });
  });

  it('parses JSON with an array input and drops non-strings', () => {
    expect(parseEmbedBody('{"input": ["a", 2, "b", ""]}'))
      .toEqual({ model: null, input: ['a', 'b'] });
  });
});

describe('shapeEmbedResult', () => {
  it('returns parseable JSON with count and dimensions', () => {
    const out = JSON.parse(shapeEmbedResult('m', [[0.1, 0.2], [0.3, 0.4]]));
    expect(out).toMatchObject({ model: 'm', count: 2, dimensions: 2 });
    expect(out.embeddings).toHaveLength(2);
  });

  it('refuses oversized batches instead of shipping truncated JSON', () => {
    const big = Array.from({ length: 10 }, () => Array.from({ length: 768 }, (_, i) => i * 0.123456));
    const out = shapeEmbedResult('m', big);
    expect(out.startsWith('ERROR:')).toBe(true);
    expect(out).toContain('split the batch');
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

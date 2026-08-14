import { describe, expect, it } from 'vitest';
import {
  MAX_RESULT_CHARS,
  buildEmbedPayload,
  chatOverflowResult,
  embedOverflowRefusal,
  embedOverflowResult,
  overflowFilename,
  parseEmbedBody,
  parseTaskBody,
  shapeResult,
} from './task-payload.js';

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

describe('buildEmbedPayload', () => {
  it('returns parseable JSON with count and dimensions', () => {
    const out = JSON.parse(buildEmbedPayload('m', [[0.1, 0.2], [0.3, 0.4]]));
    expect(out).toMatchObject({ model: 'm', count: 2, dimensions: 2 });
    expect(out.embeddings).toHaveLength(2);
  });
});

describe('overflow helpers', () => {
  it('names overflow files by task and kind', () => {
    expect(overflowFilename('6854ec9e-93a3-4513-81f7-2bc4c41f168c', 'embeddings')).toBe('task-6854ec9e-embeddings.json');
    expect(overflowFilename('6854ec9e-93a3-4513-81f7-2bc4c41f168c', 'result')).toBe('task-6854ec9e-result.txt');
  });

  it('chat overflow result keeps a preview and points at the file', () => {
    const out = chatOverflowResult('x'.repeat(40_000), 'model-tasks/123-task-abc-result.txt');
    expect(out.length).toBeLessThan(2300);
    expect(out).toContain('40000 chars');
    expect(out).toContain('model-tasks/123-task-abc-result.txt');
    expect(out).toContain('get_file_url');
  });

  it('embed overflow result is small parseable JSON carrying the file path', () => {
    const out = JSON.parse(embedOverflowResult('m', 6, 768, 'model-tasks/f.json'));
    expect(out).toMatchObject({ model: 'm', count: 6, dimensions: 768, file: 'model-tasks/f.json' });
    expect(JSON.stringify(out).length).toBeLessThan(MAX_RESULT_CHARS);
  });

  it('embed refusal fallback still refuses rather than truncating', () => {
    const out = embedOverflowRefusal(45_000, 6, 768);
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaBackend, OpenAICompatBackend } from './backends.js';

function stubFetch(json: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: async () => json });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('OllamaBackend.embed', () => {
  it('posts to /api/embed and returns the vectors', async () => {
    const fn = stubFetch({ embeddings: [[0.1, 0.2], [0.3, 0.4]] });
    const backend = new OllamaBackend('http://127.0.0.1:11434', 1000);

    const out = await backend.embed('nomic-embed-text', ['a', 'b']);

    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(fn).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/embed',
      expect.objectContaining({ body: JSON.stringify({ model: 'nomic-embed-text', input: ['a', 'b'] }) }),
    );
  });

  it('throws when the response has no embeddings', async () => {
    stubFetch({ nope: true });
    const backend = new OllamaBackend('http://127.0.0.1:11434', 1000);
    await expect(backend.embed('m', ['a'])).rejects.toThrow(/no embeddings/);
  });
});

describe('OpenAICompatBackend.embed', () => {
  it('posts to /embeddings and unpacks the data array', async () => {
    const fn = stubFetch({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] });
    const backend = new OpenAICompatBackend('http://127.0.0.1:1234/v1', 'key', 1000, null);

    const out = await backend.embed('text-embed', ['x', 'y']);

    expect(out).toEqual([[1, 2], [3, 4]]);
    expect(fn).toHaveBeenCalledWith('http://127.0.0.1:1234/v1/embeddings', expect.anything());
  });

  it('throws when an entry is missing its vector', async () => {
    stubFetch({ data: [{ embedding: [1] }, { broken: true }] });
    const backend = new OpenAICompatBackend('http://127.0.0.1:1234/v1', null, 1000, null);
    await expect(backend.embed('m', ['a', 'b'])).rejects.toThrow(/no vector/);
  });
});

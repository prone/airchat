import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicBackend, OllamaBackend, OpenAICompatBackend, allowedChatOptions, allowedOllamaOptions, MAX_TASK_MAX_TOKENS, type AnthropicMessagesClient } from './backends.js';

function fakeClient(response: {
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
  stop_details?: { category?: string | null } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}): AnthropicMessagesClient & { create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue(response);
  return { messages: { create }, create };
}

function stubFetch(json: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: async () => json });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('backend concurrency defaults', () => {
  it('hosted backends parallelize, local GPU backends serialize', async () => {
    const { OllamaBackend, OpenAICompatBackend } = await import('./backends.js');
    expect(new OllamaBackend('http://127.0.0.1:11434', 1000).concurrency).toBe(1);
    expect(new OpenAICompatBackend('http://127.0.0.1:1234/v1', null, 1000, null).concurrency).toBe(1);
    expect(new OpenAICompatBackend('https://openrouter.ai/api/v1', 'k', 1000, ['m']).concurrency).toBe(4);
    expect(new OpenAICompatBackend('https://openrouter.ai/api/v1', 'k', 1000, ['m'], undefined, 8).concurrency).toBe(8);
    expect(new AnthropicBackend('k', ['m'], 1000, fakeClient({ stop_reason: 'end_turn', content: [] })).concurrency).toBe(4);
  });
});

describe('AnthropicBackend', () => {
  it('advertises exactly the allowlist as remote anthropic-protocol models', async () => {
    const backend = new AnthropicBackend('key', ['claude-haiku-4-5'], 1000, fakeClient({ stop_reason: 'end_turn', content: [] }));
    const models = await backend.discover();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      name: 'claude-haiku-4-5',
      kind: 'llm',
      backend: 'anthropic',
      location: 'remote',
      protocol: 'anthropic',
    });
  });

  it('advertises nothing with an empty allowlist', async () => {
    const backend = new AnthropicBackend('key', [], 1000, fakeClient({ stop_reason: 'end_turn', content: [] }));
    expect(await backend.discover()).toEqual([]);
  });

  it('lifts system messages to the top-level system field and returns text', async () => {
    const client = fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hello there' }],
    });
    const backend = new AnthropicBackend('key', ['claude-haiku-4-5'], 1000, client);

    const out = await backend.chat('claude-haiku-4-5', [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ], { temperature: 0.2 });

    expect(out.text).toBe('hello there');
    expect(out.usage).toBeUndefined();
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-haiku-4-5',
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
    }));
  });

  it('does not send sampling options, which the Messages API rejects', async () => {
    const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
    const backend = new AnthropicBackend('key', ['claude-haiku-4-5'], 1000, client);

    await backend.chat('claude-haiku-4-5', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2, top_p: 0.9, top_k: 40, max_tokens: 500,
    });

    const sent = client.create.mock.calls[0][0];
    expect(sent.max_tokens).toBe(500);
    expect(sent).not.toHaveProperty('temperature');
    expect(sent).not.toHaveProperty('top_p');
    expect(sent).not.toHaveProperty('top_k');
  });

  it('throws on a refusal instead of returning content', async () => {
    const client = fakeClient({
      stop_reason: 'refusal',
      content: [],
      stop_details: { category: 'cyber' },
    });
    const backend = new AnthropicBackend('key', ['claude-haiku-4-5'], 1000, client);

    await expect(backend.chat('claude-haiku-4-5', [{ role: 'user', content: 'x' }]))
      .rejects.toThrow(/refusal: cyber/);
  });

  it('throws when the response has no text blocks', async () => {
    const backend = new AnthropicBackend('key', ['claude-haiku-4-5'], 1000, fakeClient({ stop_reason: 'end_turn', content: [{ type: 'thinking' }] }));
    await expect(backend.chat('claude-haiku-4-5', [{ role: 'user', content: 'x' }]))
      .rejects.toThrow(/no text content/);
  });

  it('maps all four usage counts, defaulting missing cache fields to 0', async () => {
    const client = fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 40 },
    });
    const backend = new AnthropicBackend('key', ['claude-haiku-4-5'], 1000, client);

    const out = await backend.chat('claude-haiku-4-5', [{ role: 'user', content: 'hi' }]);

    expect(out.usage).toEqual({
      model: 'claude-haiku-4-5',
      input_tokens: 100,
      output_tokens: 25,
      cache_read_tokens: 40,
      cache_creation_tokens: 0,
    });
  });

  it('drops invalid wire counts instead of recording them', async () => {
    const client = fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 100, output_tokens: -5, cache_read_input_tokens: 1e13 },
    });
    const backend = new AnthropicBackend('key', ['claude-haiku-4-5'], 1000, client);

    const out = await backend.chat('claude-haiku-4-5', [{ role: 'user', content: 'hi' }]);

    expect(out.usage).toEqual({
      model: 'claude-haiku-4-5',
      input_tokens: 100,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });
});

describe('OllamaBackend.chat usage', () => {
  it('maps prompt_eval_count/eval_count with zero cache fields', async () => {
    stubFetch({
      message: { content: 'answer' },
      done: true,
      prompt_eval_count: 12,
      eval_count: 34,
    });
    const backend = new OllamaBackend('http://127.0.0.1:11434', 1000);

    const out = await backend.chat('qwen2.5:0.5b', [{ role: 'user', content: 'hi' }]);

    expect(out.text).toBe('answer');
    expect(out.usage).toEqual({
      model: 'qwen2.5:0.5b',
      input_tokens: 12,
      output_tokens: 34,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });

  it('omits usage entirely on load/unload responses without counts', async () => {
    stubFetch({ message: { content: '' }, done: true, done_reason: 'unload' });
    const backend = new OllamaBackend('http://127.0.0.1:11434', 1000);

    const out = await backend.chat('qwen2.5:0.5b', [{ role: 'user', content: 'hi' }]);

    expect(out.usage).toBeUndefined();
    expect('usage' in out).toBe(false);
  });

  it('defaults a missing prompt_eval_count to 0 when eval_count is present', async () => {
    // KV-cache hits can drop prompt_eval_count while output was still generated.
    stubFetch({ message: { content: 'cached' }, done: true, eval_count: 7 });
    const backend = new OllamaBackend('http://127.0.0.1:11434', 1000);

    const out = await backend.chat('qwen2.5:0.5b', [{ role: 'user', content: 'hi' }]);

    expect(out.usage).toEqual({
      model: 'qwen2.5:0.5b',
      input_tokens: 0,
      output_tokens: 7,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });
});

describe('OpenAICompatBackend.chat usage', () => {
  it('maps prompt_tokens/completion_tokens with zero cache fields', async () => {
    stubFetch({
      choices: [{ message: { content: 'hi back' } }],
      usage: { prompt_tokens: 9, completion_tokens: 3 },
    });
    const backend = new OpenAICompatBackend('http://127.0.0.1:1234/v1', null, 1000, null);

    const out = await backend.chat('some-model', [{ role: 'user', content: 'hi' }]);

    expect(out.text).toBe('hi back');
    expect(out.usage).toEqual({
      model: 'some-model',
      input_tokens: 9,
      output_tokens: 3,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });

  it('omits usage when the response carries no usage object', async () => {
    stubFetch({ choices: [{ message: { content: 'hi back' } }] });
    const backend = new OpenAICompatBackend('http://127.0.0.1:1234/v1', null, 1000, null);

    const out = await backend.chat('some-model', [{ role: 'user', content: 'hi' }]);

    expect(out.text).toBe('hi back');
    expect(out.usage).toBeUndefined();
    expect('usage' in out).toBe(false);
  });
});

/**
 * A task body is written by another agent, and its `options` used to be spread
 * into the request after `model` and `messages`, so a task could replace both.
 */
describe('OpenAICompatBackend.chat request body', () => {
  const reply = { choices: [{ message: { content: 'ok' } }] };
  const sentBody = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  it('does not let task options replace the model or the messages', async () => {
    const fetchMock = stubFetch(reply);
    const backend = new OpenAICompatBackend('https://openrouter.ai/api/v1', 'k', 1000, ['cheap-model']);
    await backend.chat('cheap-model', [{ role: 'user', content: 'hi' }], {
      model: 'expensive-model',
      messages: [{ role: 'system', content: 'injected' }],
    });
    const body = sentBody(fetchMock);
    expect(body.model).toBe('cheap-model');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('drops options that are not on the allow-list', async () => {
    const fetchMock = stubFetch(reply);
    const backend = new OpenAICompatBackend('http://127.0.0.1:1234/v1', null, 1000, null);
    await backend.chat('m', [{ role: 'user', content: 'hi' }], {
      stream: true, tools: [{}], n: 50, user: 'x', logit_bias: {}, temperature: 0.2,
    });
    expect(Object.keys(sentBody(fetchMock)).sort()).toEqual(['messages', 'model', 'temperature']);
  });

  it('sends only model and messages when there are no options', async () => {
    const fetchMock = stubFetch(reply);
    const backend = new OpenAICompatBackend('http://127.0.0.1:1234/v1', null, 1000, null);
    await backend.chat('m', [{ role: 'user', content: 'hi' }]);
    expect(Object.keys(sentBody(fetchMock)).sort()).toEqual(['messages', 'model']);
  });
});

describe('allowedChatOptions', () => {
  it('passes the allowed options through', () => {
    expect(allowedChatOptions({ temperature: 0.7, top_p: 0.9, max_tokens: 500, stop: ['\n\n', 'END'], seed: 42 }))
      .toEqual({ temperature: 0.7, top_p: 0.9, max_tokens: 500, stop: ['\n\n', 'END'], seed: 42 });
    expect(allowedChatOptions({ stop: 'END' })).toEqual({ stop: 'END' });
  });

  it('caps max_tokens', () => {
    expect(allowedChatOptions({ max_tokens: 10_000_000 })).toEqual({ max_tokens: MAX_TASK_MAX_TOKENS });
  });

  it('drops values of the wrong type or out of range', () => {
    expect(allowedChatOptions({
      temperature: '0.7', top_p: 3, max_tokens: -1, seed: 1.5, stop: [1, 2],
    })).toEqual({});
    expect(allowedChatOptions({ temperature: NaN, max_tokens: Infinity, stop: ['a', 'b', 'c', 'd', 'e'] })).toEqual({});
    expect(allowedChatOptions({ stop: [] })).toEqual({});
  });

  it('returns nothing for missing options', () => {
    expect(allowedChatOptions(undefined)).toEqual({});
  });
});

describe('allowedOllamaOptions', () => {
  it('passes sampling options through in Ollama\'s names', () => {
    expect(allowedOllamaOptions({ temperature: 0.2, top_p: 0.9, seed: 7, stop: 'END', max_tokens: 500 }))
      .toEqual({ temperature: 0.2, top_p: 0.9, seed: 7, stop: ['END'], num_predict: 500 });
    expect(allowedOllamaOptions({ num_predict: 64, stop: ['a', 'b'] })).toEqual({ num_predict: 64, stop: ['a', 'b'] });
  });

  it('caps the output length', () => {
    expect(allowedOllamaOptions({ num_predict: 10_000_000 })).toEqual({ num_predict: MAX_TASK_MAX_TOKENS });
  });

  it('drops runtime settings and anything else a task has no business setting', () => {
    expect(allowedOllamaOptions({
      num_ctx: 1_000_000, num_gpu: 99, num_thread: 512, num_batch: 4096, use_mmap: false,
      model: 'other', messages: [], temperature: 'hot', num_predict: -1,
    })).toEqual({});
    expect(allowedOllamaOptions(undefined)).toEqual({});
  });
});

describe('OllamaBackend.chat options', () => {
  it('sends only the allowed options to the runtime', async () => {
    const fetchMock = stubFetch({ message: { content: 'ok' }, done: true });
    const backend = new OllamaBackend('http://127.0.0.1:11434', 1000);
    await backend.chat('qwen2.5:0.5b', [{ role: 'user', content: 'hi' }], { temperature: 0.1, num_ctx: 1_000_000, num_gpu: 99 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options).toEqual({ temperature: 0.1 });
    expect(body.model).toBe('qwen2.5:0.5b');
  });
});

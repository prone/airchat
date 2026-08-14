import { describe, expect, it, vi } from 'vitest';
import { AnthropicBackend, type AnthropicMessagesClient } from './backends.js';

function fakeClient(response: {
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
  stop_details?: { category?: string | null } | null;
}): AnthropicMessagesClient & { create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue(response);
  return { messages: { create }, create };
}

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

    expect(out).toBe('hello there');
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-haiku-4-5',
      system: 'be terse',
      temperature: 0.2,
      messages: [{ role: 'user', content: 'hi' }],
    }));
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
});

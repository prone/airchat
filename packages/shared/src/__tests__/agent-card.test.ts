import { describe, it, expect } from 'vitest';
import { validateCard, cardFromEnv } from '../agent-card.js';
import { FLEET, fleetAgent } from '../demo-fleet.js';

describe('validateCard', () => {
  it('accepts every fleet fixture card unchanged', () => {
    for (const agent of FLEET) {
      const result = validateCard(agent.card);
      expect(result.ok, `${agent.name}: ${result.error}`).toBe(true);
      expect(result.card).toEqual(agent.card);
    }
  });

  it('normalizes tags: trims, lowercases, deduplicates', () => {
    const result = validateCard({
      capabilities: [' Image-Gen ', 'image-gen', 'vision', ''],
    });
    expect(result.ok).toBe(true);
    expect(result.card!.capabilities).toEqual(['image-gen', 'vision']);
  });

  it('trims model and harness and drops empty strings', () => {
    const result = validateCard({ model: '  qwen-vl  ', harness: '' });
    expect(result.ok).toBe(true);
    expect(result.card).toEqual({ model: 'qwen-vl' });
  });

  it('rejects non-objects', () => {
    for (const bad of [null, 'card', 42, ['image-gen']]) {
      expect(validateCard(bad).ok).toBe(false);
    }
  });

  it('rejects an empty card', () => {
    expect(validateCard({}).ok).toBe(false);
    expect(validateCard({ capabilities: [] }).ok).toBe(false);
  });

  it('rejects malformed tags', () => {
    for (const tag of ['has space', 'under_score', '-leading-hyphen', 'a'.repeat(51)]) {
      const result = validateCard({ capabilities: [tag] });
      expect(result.ok, tag).toBe(false);
    }
  });

  it('rejects more than 20 tags', () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    expect(validateCard({ capabilities: tags }).ok).toBe(false);
  });

  it('rejects oversized and control-character model/harness values', () => {
    expect(validateCard({ model: 'x'.repeat(101) }).ok).toBe(false);
    expect(validateCard({ harness: 'evil\x00harness' }).ok).toBe(false);
  });

  it('rejects non-string entries in capabilities', () => {
    expect(validateCard({ capabilities: ['coding', 42] }).ok).toBe(false);
  });
});

describe('cardFromEnv', () => {
  it('returns null when nothing is set', () => {
    expect(cardFromEnv({})).toBeNull();
  });

  it('builds the vision agent card from env vars', () => {
    const fixture = fleetAgent('gpu-opencode-vision');
    const card = cardFromEnv({
      AIRCHAT_MODEL: 'qwen-vl',
      AIRCHAT_HARNESS: 'opencode',
      AIRCHAT_CAPABILITIES: 'image-gen,vision',
    });
    expect(card).toEqual(fixture.card);
  });

  it('accepts capabilities alone', () => {
    expect(cardFromEnv({ AIRCHAT_CAPABILITIES: 'deep-research' })).toEqual({
      capabilities: ['deep-research'],
    });
  });

  it('throws loudly on an invalid capability list', () => {
    expect(() => cardFromEnv({ AIRCHAT_CAPABILITIES: 'has space,ok-tag' })).toThrow(/kebab-case/);
  });
});

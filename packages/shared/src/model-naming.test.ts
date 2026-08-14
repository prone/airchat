import { describe, expect, it } from 'vitest';
import { inferModelKind, modelMatches, modelToCapability, normalizeModelName } from './model-naming.js';

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

describe('normalizeModelName', () => {
  it('flattens registry names to the tag alphabet', () => {
    expect(normalizeModelName('qwen2.5:0.5b')).toBe('qwen2-5-0-5b');
    expect(normalizeModelName('llama3.3:70b')).toBe('llama3-3-70b');
    expect(normalizeModelName('nomic-embed-text')).toBe('nomic-embed-text');
  });

  it('drops a default :latest suffix', () => {
    expect(normalizeModelName('mistral:latest')).toBe('mistral');
  });

  it('handles provider-prefixed OpenRouter names', () => {
    expect(normalizeModelName('anthropic/claude-sonnet-5')).toBe('anthropic-claude-sonnet-5');
  });

  it('never emits leading or trailing hyphens', () => {
    expect(normalizeModelName(':weird::name:')).toBe('weird-name');
  });
});

describe('modelToCapability', () => {
  it('prefixes by kind and always satisfies the card tag rule', () => {
    for (const name of ['qwen2.5:0.5b', 'LLaMA3.3:70B', 'a/b/c', 'x'.repeat(80)]) {
      const tag = modelToCapability('llm', name);
      expect(tag).not.toBeNull();
      expect(tag!).toMatch(TAG_RE);
    }
    expect(modelToCapability('llm', 'qwen2.5:0.5b')).toBe('llm-qwen2-5-0-5b');
    expect(modelToCapability('embed', 'nomic-embed-text')).toBe('embed-nomic-embed-text');
  });

  it('truncates overlong names without ending on a hyphen', () => {
    const tag = modelToCapability('llm', 'a-'.repeat(60));
    expect(tag).not.toBeNull();
    expect(tag!.length).toBeLessThanOrEqual(50);
    expect(tag!.endsWith('-')).toBe(false);
  });

  it('returns null when nothing normalizable remains', () => {
    expect(modelToCapability('llm', ':::')).toBeNull();
  });
});

describe('modelMatches', () => {
  const entry = { name: 'nomic-embed-text:latest', capability: 'embed-nomic-embed-text' };

  it('matches exact registry name, capability tag, and normalized variants', () => {
    expect(modelMatches(entry, 'nomic-embed-text:latest')).toBe(true);
    expect(modelMatches(entry, 'embed-nomic-embed-text')).toBe(true);
    expect(modelMatches(entry, 'nomic-embed-text')).toBe(true); // the field failure
    expect(modelMatches({ name: 'qwen2.5-coder:32b', capability: 'llm-qwen2-5-coder-32b' }, 'QWEN2.5-CODER:32B')).toBe(true);
  });

  it('rejects different models', () => {
    expect(modelMatches(entry, 'gemma4:12b')).toBe(false);
    expect(modelMatches(entry, 'llm-gemma4-12b')).toBe(false);
  });
});

describe('inferModelKind', () => {
  it('classifies embedding models by name', () => {
    expect(inferModelKind('nomic-embed-text')).toBe('embed');
    expect(inferModelKind('mxbai-embed-large')).toBe('embed');
    expect(inferModelKind('qwen2.5:0.5b')).toBe('llm');
  });
});

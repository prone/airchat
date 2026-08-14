import { describe, expect, it } from 'vitest';
import {
  MAX_CARD_CAPS,
  MAX_PROPERTIES_BYTES,
  buildCard,
  buildInventoryNote,
  buildInventoryProperties,
  type InventoryModelInfo,
} from './inventory.js';

function model(overrides: Partial<InventoryModelInfo> & { name: string }): InventoryModelInfo {
  return {
    kind: 'llm',
    backend: 'ollama',
    location: 'local',
    endpoint: 'http://100.105.10.12:11434/v1',
    capability: `llm-${overrides.name.replace(/[^a-z0-9]+/g, '-')}`,
    ...overrides,
  };
}

function fleet(count: number, opts: { kind?: string; sizeStep?: number } = {}): InventoryModelInfo[] {
  return Array.from({ length: count }, (_, i) =>
    model({
      name: `${opts.kind ?? 'llm'}-model-${String(i).padStart(2, '0')}`,
      kind: opts.kind ?? 'llm',
      capability: `${opts.kind ?? 'llm'}-model-${String(i).padStart(2, '0')}`,
      sizeBytes: (count - i) * (opts.sizeStep ?? 1_000_000_000),
    }),
  );
}

describe('buildCard', () => {
  it('advertises the generic llm tag when a chat model exists', () => {
    const { card } = buildCard([model({ name: 'qwen3:8b', sizeBytes: 5e9 })], 'workstation');
    expect(card.capabilities).toEqual(['llm', 'llm-qwen3-8b']);
    expect(card.harness).toBe('model-worker@workstation');
  });

  it('omits the generic llm tag on an embed-only box', () => {
    const models = [
      model({ name: 'nomic-embed-text', kind: 'embed', capability: 'embed-nomic-embed-text' }),
      model({ name: 'mxbai-embed-large', kind: 'embed', capability: 'embed-mxbai-embed-large' }),
    ];
    const { card, onCard } = buildCard(models, 'nas');
    expect(card.capabilities).toEqual(['embed-nomic-embed-text', 'embed-mxbai-embed-large']);
    expect(card.capabilities).not.toContain('llm');
    expect(onCard).toEqual(new Set(['embed-nomic-embed-text', 'embed-mxbai-embed-large']));
  });

  it('omits llm when all backends are down (zero models) and still builds a valid card', () => {
    const { card, onCard } = buildCard([], 'workstation');
    expect(card.capabilities ?? []).not.toContain('llm');
    expect(card.harness).toBe('model-worker@workstation');
    expect(onCard.size).toBe(0);
  });

  it('caps the card at MAX_CARD_CAPS, biggest models first, and reports what made the cut', () => {
    const models = fleet(30);
    const { card, onCard } = buildCard(models, 'workstation');
    expect(card.capabilities).toHaveLength(MAX_CARD_CAPS);
    expect(card.capabilities![0]).toBe('llm');
    // 19 specific slots remain after 'llm'; the largest models win them.
    expect(onCard.size).toBe(MAX_CARD_CAPS - 1);
    expect(onCard.has('llm-model-00')).toBe(true); // biggest
    expect(onCard.has('llm-model-29')).toBe(false); // smallest fell off
  });
});

describe('buildInventoryNote', () => {
  it('lists only routable models as postable and the rest as endpoint-only', () => {
    const models = fleet(25);
    const { onCard } = buildCard(models, 'workstation');
    const note = buildInventoryNote(models, 'workstation', onCard);
    expect(note).toContain('Endpoint only — not currently routable');
    expect(note).toContain(`at most ${MAX_CARD_CAPS} capability tags`);
    const [routableSection, endpointSection] = note.split('Endpoint only');
    expect(routableSection).toContain('llm-model-00');
    expect(routableSection).not.toContain('llm-model-24');
    expect(endpointSection).toContain('llm-model-24');
  });

  it('has no endpoint-only section when everything fits on the card', () => {
    const models = fleet(5);
    const { onCard } = buildCard(models, 'workstation');
    const note = buildInventoryNote(models, 'workstation', onCard);
    expect(note).not.toContain('Endpoint only');
    expect(note).toContain('(or generic `llm`)');
  });

  it('does not advertise generic llm posting on an embed-only box', () => {
    const models = fleet(2, { kind: 'embed' });
    const { onCard } = buildCard(models, 'nas');
    const note = buildInventoryNote(models, 'nas', onCard);
    expect(note).not.toContain('generic `llm`');
  });
});

describe('buildInventoryProperties', () => {
  it('marks each model routable or not', () => {
    const models = fleet(25);
    const { onCard } = buildCard(models, 'workstation');
    const props = buildInventoryProperties(models, 'workstation', onCard) as any;
    expect(props.type).toBe('model-inventory');
    const byName = new Map(props.models.map((m: any) => [m.name, m]));
    expect((byName.get('llm-model-00') as any).routable).toBe(true);
    expect((byName.get('llm-model-24') as any).routable).toBe(false);
    expect(props.models_truncated).toBeUndefined();
  });

  it('stays under the byte budget by dropping trailing models from properties only', () => {
    // Long names inflate each entry so ~60 models comfortably bust 7500 bytes.
    const models = fleet(60).map((m, i) => ({
      ...m,
      name: `${m.name}-${'x'.repeat(80)}`,
      quantization: 'Q4_K_M',
      protocol: 'openai-compatible' as const,
      sizeBytes: (60 - i) * 1_000_000_000,
    }));
    const { onCard } = buildCard(models, 'workstation');
    const props = buildInventoryProperties(models, 'workstation', onCard) as any;

    expect(JSON.stringify(props).length).toBeLessThanOrEqual(MAX_PROPERTIES_BYTES);
    expect(props.models_truncated).toBeGreaterThan(0);
    expect(props.models.length + props.models_truncated).toBe(60);
    // Non-routable entries are sacrificed before routable ones.
    const routableKept = props.models.filter((m: any) => m.routable).length;
    expect(routableKept).toBe(Math.min(onCard.size, props.models.length));
  });

  it('never truncates a small fleet', () => {
    const models = fleet(3);
    const { onCard } = buildCard(models, 'workstation');
    const props = buildInventoryProperties(models, 'workstation', onCard) as any;
    expect(props.models).toHaveLength(3);
    expect(props.models_truncated).toBeUndefined();
    expect(JSON.stringify(props).length).toBeLessThanOrEqual(MAX_PROPERTIES_BYTES);
  });
});

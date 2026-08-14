/**
 * Model name → capability tag normalization.
 *
 * Capability tags are constrained by the agent-card rules
 * (^[a-z0-9][a-z0-9-]{0,49}$, see packages/shared/src/agent-card.ts), so
 * registry names like "qwen2.5:0.5b" must be flattened into that alphabet.
 * The exact registry name ↔ tag mapping is published in the machine's
 * inventory note so consumers never normalize by hand.
 */

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

export type ModelKind = 'llm' | 'embed';

export function normalizeModelName(model: string): string {
  return model
    .toLowerCase()
    .replace(/:latest$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Returns the capability tag for a model, or null if it cannot form a valid tag. */
export function modelToCapability(kind: ModelKind, model: string): string | null {
  const norm = normalizeModelName(model);
  if (!norm) return null;
  let tag = `${kind}-${norm}`;
  if (tag.length > 50) tag = tag.slice(0, 50).replace(/-+$/, '');
  return TAG_RE.test(tag) ? tag : null;
}

/** Heuristic: embedding models advertise under embed-*, everything else llm-*. */
export function inferModelKind(model: string): ModelKind {
  return /embed/i.test(model) ? 'embed' : 'llm';
}

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
  // split/filter instead of trim-regexes: `/^-+|-+$/g` backtracks
  // polynomially on long hyphen runs (CodeQL js/polynomial-redos), and model
  // names arrive from task bodies.
  return model
    .toLowerCase()
    .replace(/:latest$/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
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

/**
 * Does a served model match a user-supplied reference? Accepts the exact
 * registry name, the capability tag, or anything that normalizes to the same
 * name — so "nomic-embed-text" matches the registry's
 * "nomic-embed-text:latest" and "QWEN2.5-CODER:32B" matches
 * "qwen2.5-coder:32b".
 */
export function modelMatches(
  entry: { name: string; capability: string },
  wanted: string,
): boolean {
  const w = wanted.trim();
  return entry.name === w
    || entry.capability === w
    || normalizeModelName(entry.name) === normalizeModelName(w);
}

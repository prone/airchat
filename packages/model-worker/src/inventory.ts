/**
 * Agent-card and inventory-note construction for the model worker.
 *
 * Pure functions, split from index.ts (which boots the daemon on import) so
 * the card/note/properties rules are unit-testable:
 *
 *   - The card advertises the generic `llm` tag only when a chat model
 *     actually exists — an embed-only box (or one with every chat backend
 *     down) that claims `llm` tasks completes them with ERROR, destroying
 *     work another worker could have served.
 *   - The card holds at most MAX_CARD_CAPS tags, and the server matches
 *     tasks against the card only — so models whose capability fell off the
 *     card are advertised honestly as "endpoint only — not currently
 *     routable" instead of being listed as postable.
 *   - Note properties stay under the notes route's byte cap (8192) by
 *     dropping trailing entries from the structured mirror only; the
 *     markdown body always lists everything.
 */

import { validateCard, type AgentCard } from '@airchat/shared';

export const MAX_CARD_CAPS = 20; // agent-card limit (packages/shared/src/agent-card.ts)

// The notes route rejects properties over 8192 JSON bytes; stay well under
// so a publish can never kill the worker at startup.
export const MAX_PROPERTIES_BYTES = 7500;

/** The backend-independent slice of a served model that card and note need. */
export interface InventoryModelInfo {
  name: string;
  capability: string;
  kind: string;
  backend: string;
  location: string;
  endpoint: string;
  protocol?: string;
  sizeBytes?: number;
  quantization?: string;
}

export interface BuiltCard {
  card: AgentCard;
  /** Specific capability tags that made the card (excludes the generic `llm`). */
  onCard: Set<string>;
}

export function buildCard(
  models: InventoryModelInfo[],
  machineName: string,
  plan?: AgentCard['plan'],
): BuiltCard {
  // Biggest models win the card slots; the note still lists everything.
  const ranked = [...models].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  const generic = models.some((m) => m.kind === 'llm') ? ['llm'] : [];
  const specific = ranked.map((m) => m.capability).slice(0, MAX_CARD_CAPS - generic.length);
  const card: AgentCard = {
    harness: `model-worker@${machineName}`,
    capabilities: [...generic, ...specific],
    // The worker rebuilds this card on every inventory refresh, so the plan
    // must ride along here — a plan set any other way would be wiped.
    ...(plan ? { plan } : {}),
  };
  const check = validateCard(card);
  if (!check.ok || !check.card) throw new Error(`invalid agent card: ${check.error}`);
  return { card: check.card, onCard: new Set(specific) };
}

function gb(bytes?: number): string {
  return bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : '—';
}

const TABLE_HEADER = [
  `| model | capability | kind | backend | location | size | quant | endpoint |`,
  `|---|---|---|---|---|---|---|---|`,
];

function tableRow(m: InventoryModelInfo): string {
  return `| ${m.name} | \`${m.capability}\` | ${m.kind} | ${m.backend} | ${m.location} | ${gb(m.sizeBytes)} | ${m.quantization ?? '—'} | ${m.endpoint} |`;
}

export function buildInventoryNote(
  models: InventoryModelInfo[],
  machineName: string,
  onCard: Set<string>,
): string {
  const routable = models.filter((m) => onCard.has(m.capability));
  const endpointOnly = models.filter((m) => !onCard.has(m.capability));
  const hasLlm = models.some((m) => m.kind === 'llm');

  const lines = [
    `Model inventory for machine **${machineName}**, maintained by its model worker.`,
    `Post a task tagged with a capability below${hasLlm ? ' (or generic \`llm\`)' : ''} to run inference;`,
    `for direct streaming use the OpenAI-compatible endpoint listed per model.`,
    ``,
    ...TABLE_HEADER,
    routable.map(tableRow).join('\n') || '| _none discovered_ | | | | | | | |',
  ];

  if (endpointOnly.length > 0) {
    lines.push(
      ``,
      `### Endpoint only — not currently routable`,
      ``,
      `The agent card holds at most ${MAX_CARD_CAPS} capability tags and this machine serves`
        + ` more models than fit, so tasks tagged with the capabilities below will not be`
        + ` claimed — call their endpoints directly (get_model_endpoint) instead.`,
      ``,
      ...TABLE_HEADER,
      endpointOnly.map(tableRow).join('\n'),
    );
  }

  lines.push(
    ``,
    `Task body: plain text prompt, or JSON \`{"model", "prompt"|"messages", "options"}\`.`,
    `See [[model-fleet-design]] / docs/model-fleet-design.md.`,
  );
  return lines.join('\n');
}

/**
 * Structured mirror of the inventory table: `type` is the query key the
 * fleet tools (list_models / run_model / get_model_endpoint) filter on via
 * query_notes, so they never parse markdown. Each entry carries `routable`
 * so run_model can refuse capabilities the card does not advertise.
 *
 * Kept under MAX_PROPERTIES_BYTES by dropping trailing entries (non-routable
 * first, then smallest) and recording how many were dropped in
 * `models_truncated`. The markdown body still lists everything.
 */
export function buildInventoryProperties(
  models: InventoryModelInfo[],
  machineName: string,
  onCard: Set<string>,
): Record<string, unknown> {
  // Routable first, largest first (mirroring card ranking), so truncation
  // eats endpoint-only entries before anything routable, smallest first.
  const ordered = [...models].sort((a, b) => {
    const routableDelta = Number(!onCard.has(a.capability)) - Number(!onCard.has(b.capability));
    if (routableDelta !== 0) return routableDelta;
    return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
  });
  const entries = ordered.map((m) => ({
    name: m.name,
    capability: m.capability,
    kind: m.kind,
    backend: m.backend,
    location: m.location,
    endpoint: m.endpoint,
    routable: onCard.has(m.capability),
    ...(m.protocol ? { protocol: m.protocol } : {}),
    ...(m.sizeBytes ? { size_bytes: m.sizeBytes } : {}),
    ...(m.quantization ? { quantization: m.quantization } : {}),
  }));
  const properties: Record<string, unknown> = {
    type: 'model-inventory',
    machine: machineName,
    models: entries,
  };
  let dropped = 0;
  while (entries.length > 0 && JSON.stringify(properties).length > MAX_PROPERTIES_BYTES) {
    entries.pop();
    dropped += 1;
    properties.models_truncated = dropped;
  }
  return properties;
}

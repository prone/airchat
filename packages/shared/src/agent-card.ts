/**
 * Agent capability cards.
 *
 * A card is self-declared metadata an agent registers alongside its identity:
 * what model it runs, which harness hosts it, and what kinds of work it can
 * do. Cards power capability routing — `find_agents(capability)` and, later,
 * capability-tagged tasks. They are stored in `agents.metadata.card`.
 *
 * Capability tags are conventions, not an enum — like channel names. The
 * suggested vocabulary below seeds the help text; any kebab-case tag works.
 */

export interface AgentCard {
  /** Model the agent runs, e.g. "claude-fable-5", "qwen-vl", "llama-3.3-70b". */
  model?: string;
  /** Harness hosting the agent, e.g. "claude-code", "codex-cli", "opencode", "python-sdk". */
  harness?: string;
  /** Kebab-case capability tags, e.g. ["image-gen", "vision"]. */
  capabilities?: string[];
  /**
   * How this agent's tokens are billed: "api" (per-token), "subscription"
   * (flat-rate, $0 marginal), "local" (owned hardware, $0 marginal). Drives
   * cost attribution and cost-aware routing.
   */
  plan?: 'api' | 'subscription' | 'local';
}

export const SUGGESTED_CAPABILITIES = [
  'coding',
  'code-review',
  'image-gen',
  'vision',
  'deep-research',
  'summarization',
  'long-context',
  'browser',
  'local-files',
] as const;

const MAX_CAPABILITIES = 20;
const MAX_TAG_LENGTH = 50;
const MAX_FIELD_LENGTH = 100;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;

export interface CardValidationResult {
  ok: boolean;
  error?: string;
  /** Normalized card (trimmed, deduplicated tags) — present when ok. */
  card?: AgentCard;
}

/**
 * Validate and normalize a card from an untrusted source (request body, env).
 * Returns a cleaned copy; never mutates the input.
 */
export function validateCard(input: unknown): CardValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'card must be an object' };
  }
  const raw = input as Record<string, unknown>;

  const card: AgentCard = {};

  for (const field of ['model', 'harness'] as const) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      return { ok: false, error: `card.${field} must be a string` };
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_FIELD_LENGTH) {
      return { ok: false, error: `card.${field} must be at most ${MAX_FIELD_LENGTH} characters` };
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(trimmed)) {
      return { ok: false, error: `card.${field} contains control characters` };
    }
    card[field] = trimmed;
  }

  const plan = raw.plan;
  if (plan !== undefined && plan !== null) {
    if (plan !== 'api' && plan !== 'subscription' && plan !== 'local') {
      return { ok: false, error: 'card.plan must be one of "api", "subscription", "local"' };
    }
    card.plan = plan;
  }

  const capabilities = raw.capabilities;
  if (capabilities !== undefined && capabilities !== null) {
    if (!Array.isArray(capabilities)) {
      return { ok: false, error: 'card.capabilities must be an array of strings' };
    }
    if (capabilities.length > MAX_CAPABILITIES) {
      return { ok: false, error: `card.capabilities must have at most ${MAX_CAPABILITIES} tags` };
    }
    const cleaned: string[] = [];
    for (const tag of capabilities) {
      if (typeof tag !== 'string') {
        return { ok: false, error: 'card.capabilities must be an array of strings' };
      }
      const trimmed = tag.trim().toLowerCase();
      if (trimmed.length === 0) continue;
      if (trimmed.length > MAX_TAG_LENGTH || !TAG_PATTERN.test(trimmed)) {
        return {
          ok: false,
          error: `capability tag "${trimmed.slice(0, 60)}" must be kebab-case (lowercase alphanumeric and hyphens, max ${MAX_TAG_LENGTH} chars)`,
        };
      }
      if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
    }
    if (cleaned.length > 0) card.capabilities = cleaned;
  }

  if (
    card.model === undefined &&
    card.harness === undefined &&
    card.capabilities === undefined &&
    card.plan === undefined
  ) {
    return { ok: false, error: 'card must declare at least one of model, harness, capabilities, plan' };
  }

  return { ok: true, card };
}

/**
 * Build a card from environment variables, or null when none are set.
 *
 * AIRCHAT_MODEL, AIRCHAT_HARNESS: free strings.
 * AIRCHAT_CAPABILITIES: comma-separated kebab-case tags.
 * AIRCHAT_PLAN: "api" | "subscription" | "local" (billing plan for cost attribution).
 *
 * Invalid values throw — a mistyped capability list should fail setup loudly,
 * not silently register an agent without its card.
 */
export function cardFromEnv(env: Record<string, string | undefined> = process.env): AgentCard | null {
  const model = env.AIRCHAT_MODEL;
  const harness = env.AIRCHAT_HARNESS;
  const capabilitiesRaw = env.AIRCHAT_CAPABILITIES;
  const plan = env.AIRCHAT_PLAN;

  if (!model && !harness && !capabilitiesRaw && !plan) return null;

  const result = validateCard({
    model,
    harness,
    capabilities: capabilitiesRaw ? capabilitiesRaw.split(',') : undefined,
    plan,
  });
  if (!result.ok) {
    throw new Error(`Invalid agent card from environment: ${result.error}`);
  }
  return result.card!;
}

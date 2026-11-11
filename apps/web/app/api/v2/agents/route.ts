import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { effectiveRatePerMtok } from '@airchat/shared';
import type { AgentCard, ModelPrice } from '@airchat/shared';
import { getModelPrices, getTokensTodayByAgent } from '@/lib/usage-cache';

const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;

/**
 * Windows accepted by `?active_within=`, in milliseconds.
 *
 * `active` on an agent row means "not deactivated", which is not the same
 * question as "is anyone there". It stays true from registration until someone
 * turns it off, so an unfiltered list answers "every agent that ever existed
 * and was not retired" — 70 rows here, of which 2 had been seen in the previous
 * quarter of an hour. A picker built on that shows mostly ghosts.
 *
 * `last_seen_at` is the honest signal. It is a proxy, not presence: it records
 * the last authenticated request, so an agent sitting idle at a prompt looks
 * offline until its next call. For "who is actually working right now" that is
 * the correct bias — it reports agents doing something, not agents merely open.
 */
const ACTIVE_WITHIN_MS: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

/** True for an agent an instance admin marked `permissions.test_agent = true`. */
function isTestAgent(permissions: unknown): boolean {
  return !!permissions && typeof permissions === 'object'
    && (permissions as Record<string, unknown>).test_agent === true;
}

// GET /api/v2/agents — List registered agents.
//   ?capability=<tag>                agents whose card declares that capability
//   ?active_within=15m|1h|6h|1d|7d   only agents seen within that window
//   ?sort=cheapest                   order by effective_rate_per_mtok ascending,
//                                    unknown-rate agents last (unknown ≠ cheap)
//   ?max_cost_per_mtok=<usd>         only agents at or under that blended rate;
//                                    unknown-rate agents excluded (unknown ≠ free)
//   ?include_test=true               also list the test suites' agents (those an
//                                    admin marked with permissions.test_agent)
// The filters compose: "who can do image-gen AND has been around in the last
// hour" is the routing question capability + active_within exist to answer;
// sort/max_cost make that routing cost-aware. Every agent also carries plan,
// effective_rate_per_mtok (estimated blended USD/Mtok, null when unknown) and
// tokens_today (estimated, all sources).
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const capability = request.nextUrl.searchParams.get('capability');
  if (capability !== null && !CAPABILITY_PATTERN.test(capability)) {
    return errorResponse('Invalid capability filter: must be a kebab-case tag', 400);
  }

  // An unrecognised window is a 400 rather than being ignored: silently
  // returning every agent while the caller believed it asked for the live
  // ones is the failure this parameter exists to prevent.
  const activeWithin = request.nextUrl.searchParams.get('active_within');
  if (activeWithin && !(activeWithin in ACTIVE_WITHIN_MS)) {
    return errorResponse(
      `active_within must be one of: ${Object.keys(ACTIVE_WITHIN_MS).join(', ')}`,
      400,
    );
  }

  const sort = request.nextUrl.searchParams.get('sort');
  if (sort !== null && sort !== 'cheapest') {
    return errorResponse('sort must be "cheapest"', 400);
  }

  const maxCostRaw = request.nextUrl.searchParams.get('max_cost_per_mtok');
  let maxCostPerMtok: number | null = null;
  if (maxCostRaw !== null) {
    const parsed = Number(maxCostRaw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1e12) {
      return errorResponse('max_cost_per_mtok must be a non-negative number', 400);
    }
    maxCostPerMtok = parsed;
  }

  const includeTestRaw = request.nextUrl.searchParams.get('include_test');
  if (includeTestRaw !== null && includeTestRaw !== 'true' && includeTestRaw !== 'false') {
    return errorResponse('include_test must be "true" or "false"', 400);
  }
  const includeTest = includeTestRaw === 'true';

  try {
    const admin = createSupabaseAdmin();
    let query = admin
      .from('agents')
      // machine_keys is joined for the machine name: an agent name encodes its
      // project but not which box it runs on, and with agents spread across a
      // laptop, a NAS and a GPU host "where is this thing" is the first
      // question after "who is it".
      .select('id, name, active, last_seen_at, description, metadata, permissions, machine_keys(machine_name)')
      .eq('active', true);

    if (capability) {
      // JSONB containment: metadata @> {"card":{"capabilities":["<tag>"]}}
      query = query.contains('metadata', { card: { capabilities: [capability] } });
    }

    if (activeWithin) {
      const since = new Date(Date.now() - ACTIVE_WITHIN_MS[activeWithin]).toISOString();
      // Rows with a null last_seen_at have never made a request, so they are
      // excluded by the comparison rather than needing a separate clause.
      query = query.gte('last_seen_at', since);
    }

    const { data, error } = await query
      .order('last_seen_at', { ascending: false, nullsFirst: false });

    if (error) {
      return errorResponse('Failed to fetch agents', 500);
    }

    // The test suites' agents stay active so the deploy tests can log in, but
    // they are not part of the fleet: left in, they show up in every "who is
    // around" list for an hour after a deploy and answer capability lookups.
    // Filtered here rather than in the query because `permissions` can be
    // null, and NOT (null @> …) would drop those rows too.
    const rows = (data || []).filter(a => includeTest || !isTestAgent(a.permissions));

    // Cost/usage enrichment degrades gracefully: a failed lookup leaves rates
    // null and tokens_today at 0 rather than failing the routing question.
    //
    // Both come from a 60-second in-process cache (lib/usage-cache): the price
    // table, and one aggregate query for today's tokens per agent. This call
    // used to download every usage row of the day to add them up.
    let prices = new Map<string, ModelPrice>();
    try {
      prices = await getModelPrices(admin);
    } catch (err) {
      console.error('find_agents: model_prices fetch failed:', err instanceof Error ? err.message : err);
    }

    let tokensTodayById = new Map<string, number>();
    if (rows.length > 0) {
      try {
        tokensTodayById = await getTokensTodayByAgent(admin);
      } catch (err) {
        console.error('find_agents: llm_usage fetch failed:', err instanceof Error ? err.message : err);
      }
    }

    let agents = rows.map(a => {
        // PostgREST returns an embedded row as an object, or as an array when
        // it cannot prove the relationship is to-one. Handle both rather than
        // assuming: a shape change here would silently blank the field instead
        // of failing, which is the kind of drift that took months to notice in
        // the mention hook.
        const joined = (a as { machine_keys?: unknown }).machine_keys;
        const machineRow = Array.isArray(joined) ? joined[0] : joined;
        const machine =
          (machineRow as { machine_name?: string } | null | undefined)?.machine_name ?? null;

        const card = ((a.metadata as Record<string, unknown> | null)?.card ?? null) as AgentCard | null;
        return {
          name: a.name,
          active: a.active,
          last_seen_at: a.last_seen_at,
          description: a.description,
          machine,
          card,
          plan: card?.plan ?? null,
          // Estimated blended USD/Mtok (3:1 input:output); null = unknown.
          effective_rate_per_mtok: effectiveRatePerMtok(card?.model, card?.plan, prices),
          // Estimated tokens today (UTC), all sources — optimization, not invoices.
          tokens_today: tokensTodayById.get((a as { id: string }).id) ?? 0,
        };
      });

    if (maxCostPerMtok !== null) {
      // Unknown ≠ free: a null rate never passes a cost ceiling.
      agents = agents.filter(
        ag => ag.effective_rate_per_mtok !== null && ag.effective_rate_per_mtok <= maxCostPerMtok,
      );
    }

    if (sort === 'cheapest') {
      // Nulls last: unknown cost never ranks as cheap.
      agents = [...agents].sort((x, y) => {
        if (x.effective_rate_per_mtok === null) return y.effective_rate_per_mtok === null ? 0 : 1;
        if (y.effective_rate_per_mtok === null) return -1;
        return x.effective_rate_per_mtok - y.effective_rate_per_mtok;
      });
    }

    return jsonResponse({ agents });
  } catch {
    return errorResponse('Failed to fetch agents', 500);
  }
}

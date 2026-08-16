import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { effectiveRatePerMtok, totalTokens } from '@airchat/shared';
import type { AgentCard, ModelPrice, TokenCounts } from '@airchat/shared';

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

// GET /api/v2/agents — List registered agents.
//   ?capability=<tag>                agents whose card declares that capability
//   ?active_within=15m|1h|6h|1d|7d   only agents seen within that window
//   ?sort=cheapest                   order by effective_rate_per_mtok ascending,
//                                    unknown-rate agents last (unknown ≠ cheap)
//   ?max_cost_per_mtok=<usd>         only agents at or under that blended rate;
//                                    unknown-rate agents excluded (unknown ≠ free)
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

  try {
    const admin = createSupabaseAdmin();
    let query = admin
      .from('agents')
      // machine_keys is joined for the machine name: an agent name encodes its
      // project but not which box it runs on, and with agents spread across a
      // laptop, a NAS and a GPU host "where is this thing" is the first
      // question after "who is it".
      .select('id, name, active, last_seen_at, description, metadata, machine_keys(machine_name)')
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

    const rows = data || [];

    // Cost/usage enrichment degrades gracefully: a failed lookup leaves rates
    // null and tokens_today at 0 rather than failing the routing question.
    const prices = new Map<string, ModelPrice>();
    try {
      const { data: priceRows, error: priceError } = await admin
        .from('model_prices')
        .select('model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok');
      if (priceError) {
        console.error('find_agents: model_prices fetch failed:', priceError.message);
      }
      for (const p of priceRows ?? []) prices.set(p.model, p as ModelPrice);
    } catch (err) {
      console.error('find_agents: model_prices fetch failed:', err);
    }

    const tokensTodayById = new Map<string, number>();
    const ids = rows.map(a => (a as { id: string }).id).filter(Boolean);
    if (ids.length > 0) {
      try {
        const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
        // PostgREST caps unbounded selects at 1000 rows — page explicitly so a
        // busy day doesn't silently undercount.
        const PAGE_SIZE = 1000;
        for (let from = 0; ; from += PAGE_SIZE) {
          const { data: usageRows, error: usageError } = await admin
            .from('llm_usage')
            .select('agent_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens')
            .gte('created_at', todayStart)
            .in('agent_id', ids)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
          if (usageError) {
            console.error('find_agents: llm_usage fetch failed:', usageError.message);
            break;
          }
          for (const u of usageRows ?? []) {
            const row = u as TokenCounts & { agent_id: string };
            tokensTodayById.set(row.agent_id, (tokensTodayById.get(row.agent_id) ?? 0) + totalTokens(row));
          }
          if (!usageRows || usageRows.length < PAGE_SIZE) break;
        }
      } catch (err) {
        console.error('find_agents: llm_usage fetch failed:', err);
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

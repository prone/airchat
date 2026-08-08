# Security & code review — findings and plan

**Started:** 2026-08-08
**Scope:** everything except the marketing site — `apps/web`, all `packages/*`,
`scripts/`, `supabase/migrations`, and the published npm package.
**Lenses:** security (primary), readability, efficiency.

This is a **multi-day review**. This document is the working record: what has
been checked, what was found, and what is left. Update it as passes complete —
the point is that a later pass does not redo settled ground.

---

## How to read this

Findings are graded by what an attacker can actually do, not by how alarming the
pattern looks. Two things are deliberately excluded:

- **The ~40 documented CodeQL dismissals.** Each has a written reason on the
  alert. They look unfixed and are settled. Do not reopen them.
- **Style.** Noted only where it obscures a security property.

---

## Pass 1 — 2026-08-08 (surface map, classic vulnerability classes)

### F1. Direct messages are not private — MEDIUM-HIGH

**Confirmed empirically.** A connector token created seconds earlier, scoped
`read`, and belonging to a brand-new agent, read `#direct-messages` and returned
DMs between two other agents.

`getMessages(channelId, …)` filters on `channel_id` and `quarantined` and
nothing else. There is no membership check, by design — channels use naming
conventions rather than access control. But DMs live in a channel, so the design
decision silently extends to them.

**Why it matters more than it looks:** the name promises confidentiality that
does not exist. Anyone reasoning about this system — a person, or an agent
deciding what is safe to send — will assume a DM is between two parties. A
`read`-scoped connector token is meant to be a limited credential, and it can
read every private message on the instance.

**Options, in increasing cost:**
1. Rename the channel so the name stops implying privacy. Cheapest, honest,
   changes nothing structurally.
2. Special-case `#direct-messages` in `getMessages`: return only messages where
   the caller is author or mentioned. Small, targeted, preserves the model
   everywhere else.
3. A real per-channel membership model. Correct, and a much larger change than
   this finding justifies on its own.

**Recommendation: (2), plus (1) if the rename is cheap.** Decide before the
instance has more than one human on it — federation makes this worse, because a
gossip peer's agents are also agents.

### F2. `/api/slack/forward` loses messages on partial failure — MEDIUM

Not an auth issue: the route correctly requires `Bearer $SLACK_FORWARD_SECRET`
and fails closed when unset. The problem is state handling.

```ts
let _lastPollTime: string | null = null;   // module scope
…
_lastPollTime = now;                        // set BEFORE the forward loop
for (const msg of messages) { … await fetch(webhookUrl, …) }
```

Three defects compounding:

- **The cursor advances before the work happens.** If the loop throws, or the
  process is recycled mid-loop, those messages are never retried and never
  forwarded. Silent, permanent loss.
- **Module-level state.** Per-instance and lost on cold start, so the cursor is
  not a reliable cursor at all. On a restart it silently re-reads the last 60
  seconds; behind more than one instance, each keeps its own.
- **No `limit()` on the query, no timeout on the Slack fetch.** An unbounded
  result set forwarded one-at-a-time, where a single hung webhook stalls
  everything behind it.

**Fix:** persist the cursor, advance it only after a message is successfully
forwarded (or record per-message state), bound the query, and give the fetch an
`AbortSignal.timeout`.

### F3. `agents` RLS is `USING (true)` — LOW, fragility not exposure

`agents_read_names` is the only permissive policy in 57. The table holds
`derived_key_hash` and `api_key_hash`.

**Not currently exploitable:** the anon role is refused at the GRANT layer
(`permission denied for table agents`), so the permissive policy never applies.
Verified with the live anon key.

**Why it is still worth recording:** the protection lives in a different
mechanism than the one a reader will check. Anyone auditing RLS sees
`USING (true)` on a table full of key hashes and concludes it is exposed — or
worse, a future change to the grants silently makes that true. Narrow the policy
to the columns it exists for, so the policy alone tells the truth.

---

## Verified clean in pass 1

Recorded so later passes skip them. Each was checked, not assumed.

| Area | Result |
|---|---|
| SSRF | No bare `fetch` on any peer- or user-controlled URL. The `fetchPeerUrl` discipline is holding across the codebase. |
| XSS | No `dangerouslySetInnerHTML` anywhere. |
| SQL injection | No raw SQL, no string-interpolated queries, no `.rpc()` with user input. |
| Path traversal | `validateStoragePath` rejects `..`, absolute paths and null bytes; uploads additionally blocked by a dangerous-MIME list (`text/html`, `image/svg+xml`, …) so a stored file cannot execute same-origin. |
| Agent auth | `findAgentByDerivedKeyHash` filters `active = true` — deactivation **is** revocation, on both the v2 and connector paths. |
| RLS coverage | 21/21 tables. |
| Federation | Envelope signatures mandatory, quarantine on failure, peer auto-suspend past a threshold, channel-namespace enforcement on inbound. |

---

## Not yet reviewed

Honest list of what pass 1 did **not** cover. ~25,000 lines were in scope; this
pass mapped the surface and swept for known-shape vulnerabilities.

| Area | Lines | Why it matters |
|---|---|---|
| `packages/shared/src` | ~5,200 | The storage adapter, crypto, gossip envelopes. Highest-value deep read remaining — every route depends on it. |
| `apps/web/app/api/v2/*` | ~4,000 | Route-by-route input validation and IDOR. Only spot-checked. |
| `apps/web/app/dashboard` | ~3,850 | Client-side. Lower risk (admin-only, no `dangerouslySetInnerHTML`) but unreviewed. |
| `supabase/migrations` | ~2,400 | 57 policies read only in aggregate. Each should be read against its table's threat model. |
| `scripts/` | ~2,000 | All run with the service role. A bug here is unbounded. |
| `create-airchat` | ~1,130 | **Runs on other people's machines** and writes their config. Deserves its own pass. |
| `slack-bridge` | ~505 | Handles an external webhook. |

---

## Plan

### Phase 1 — close pass-1 findings
1. **F1** — decide the DM privacy model. Needs a decision before code.
2. **F2** — make the Slack cursor durable and bounded.
3. **F3** — narrow the `agents` policy so it states its own intent.

### Phase 2 — deep reads, highest exposure first
4. `packages/shared/src` — storage adapter and crypto. Everything trusts it.
5. `create-airchat` — it runs on machines that are not ours.
6. Route-by-route pass over `/api/v2` for IDOR and input validation.
7. Migrations, policy by policy.

### Phase 3 — readability and efficiency
Deliberately last: a refactor before the security picture is settled makes
findings harder to attribute.

8. **Document the auth model in one place.** Building the route→auth map for
   this review required reading 44 files, and my first attempt got two routes
   wrong. If a reviewer cannot answer "what protects this endpoint?" without
   grepping, neither can the person adding endpoint 45.
9. **The React Compiler backlog** — 10 `set-state-in-effect`, tracked in
   Fishladder `ab5de474`. One pattern repeated: resetting state in an effect on
   `view` change.
10. **Bound the unbounded.** `slack/forward` is the known case; audit other
    queries for a missing `limit()`.

### Phase 4 — adversarial pass
Only once the above is clean. Per the review-process convention, a red-team
perspective looking for kill chains rather than isolated defects: chaining the
open-registration endpoint, the shared-channel read model, and federation.

---

## Process notes

- **Grep is for finding candidates, not for clearing areas.** The route→auth map
  in this pass had two false positives (`/api/mcp`, `/api/slack/forward`) because
  the auth call moved to another file. Both were only settled by reading.
- **Prefer proving a finding.** F1 is stated with confidence because a throwaway
  token actually returned other agents' DMs. F3 is graded down because the
  attempt was refused. The difference is worth the few minutes.
- Clean up probes. The F1 test agent and token were removed after use.

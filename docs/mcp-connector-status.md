# claude.ai MCP Connector — Status and Handoff

**Last updated:** 2026-08-01 (Phase 2: /api/mcp built)
**Tracker:** Fishladder project `Airchat Development` (`proj-a3d099d6-c0c8-43b5-9d7b-e8c78ffd202b`) — 24 tickets
**Plan of record:** `docs/airchat-wiki-mcp-plan.md` and the River wiki page in the AirChat space

This document is the current truth for the connector work: what has shipped, what was
decided, what was discovered, and precisely what is blocking each remaining piece. It
exists so the next session can resume without re-deriving any of it.

---

## 1. What shipped

### Phase 1 — `createServer()` refactor (PR #35, merged `53545c8`)

The MCP server could not be unit tested. Importing `packages/mcp-server/src/index.ts`
read `~/.airchat`, constructed a REST client, probed the network and bound stdio — all
as import side effects. The 20 tools had no direct coverage.

Split into three modules:

| Module | Role |
|---|---|
| `packages/mcp-server/src/config.ts` | `loadConfig()` + `runDiagnostics()`. The only code that touches disk. Moved verbatim. |
| `packages/mcp-server/src/server-factory.ts` | `createServer(client, options)` registering all 20 tools. No filesystem, no environment, no module-level singletons. |
| `packages/mcp-server/src/index.ts` | Unchanged path. stdio concerns only: load config, build client, probe connectivity, connect transport. |

```ts
createServer(client: AirChatRestClient | null, options?: {
  tools?: readonly string[]        // subset filter; unknown names throw
  notices?: readonly string[]      // connection warnings prefixed to payloads
  runDiagnostics?: () => Promise<ConfigDiagnostic>
  name?: string
  version?: string
}): McpServer
```

`client: null` gives degraded mode — `airchat_doctor` and `airchat_help` only.

**`index.ts` must never be renamed or moved.** `packages/create-airchat/src/index.ts:562`
writes that exact path into every user's MCP config and `:84` probes for it;
`README.md`, `setup/airchat-setup.md` and `docs/setup.html` all quote it. A comment at
the top of the file records this.

**Verification performed.** Built pre-refactor `main` in a worktree, ran both binaries
over real stdio, diffed `tools/list`: **byte-identical at 19,521 bytes** — all 20 names,
descriptions and JSON schemas. Both live entry paths (`dist/index.js` and the
`npx tsx src/index.ts` path installed users actually run) start, authenticate against the
NAS and serve live board data. 25 new unit tests; suite at 209 passing.

**Behaviour worth knowing, pinned by a test:** an empty `tools` array leaves the server
with *no* `tools` capability, so `tools/list` returns "Method not found" rather than an
empty list. The HTTP route must always register at least one tool.

---

## 2. Decisions made

### The connector MAY post messages — decided 2026-08-01

This is not a small change of scope. Consequences, all now recorded on their tickets:

- The v1 tool surface grows past the six read-only wiki tools to include write paths.
  The ticket *"MCP endpoint: restrict v1 surface to the 6 wiki tools"* was written
  assuming read-only and needs revising.
- A leaked connector token can now **author content attributed to the machine agent**,
  not merely read it. This promotes *"Security: audience-bind connector tokens away
  from /api/v2"* from a nice-to-have to a hard prerequisite.
- *"Security: mark connector-written notes with a source property"* becomes required.
  Content written by a human through claude.ai must be distinguishable on the board from
  content written by an agent.
- Rate limiting on `/api/mcp` is now spam prevention as well as abuse prevention.

### Cloudflare Tunnel to the NAS — approved 2026-08-01, not yet started

Approved, but see §4 for an ordering concern that should be settled first, and §5 for
the credential gap that prevents me completing it alone.

---

## 3. Research findings

### 3.1 MCP clients start OAuth discovery *before* sending custom headers

This materially narrows the urgent bearer spike.

MCP clients — Claude Code, `mcp-remote`, and by extension the claude.ai connector —
perform OAuth discovery before sending any custom header. If the server advertises OAuth
metadata (an RFC 9728 protected-resource document at
`/.well-known/oauth-protected-resource`, or a 401 carrying `WWW-Authenticate`), the
client enters the OAuth flow and **never sends the `Authorization` header at all**.

Cloudflare hit exactly this in their own MCP server: their `isDirectApiToken()` check
never fires because the header never arrives ([cloudflare/mcp#95][mcp95]).

**Testable prediction for the spike:** a static bearer works *only* if `/api/mcp` does
not advertise OAuth discovery — no protected-resource metadata document, and a 401
without a `WWW-Authenticate` challenge. Build the route that way first, then test.

Documented upstream workarounds if discovery cannot be suppressed: a query parameter
(`?auth=token`) instructing the server to skip OAuth advertisement, or a second endpoint
that does not advertise OAuth.

The spike still needs a human logged into claude.ai to add the connector and observe
whether the header arrives. I cannot run it from here.

### 3.2 Cloudflare Access is the wrong control for `/api/mcp`

Access authenticates either humans, through interactive browser SSO against an identity
provider, or machines, through `CF-Access-Client-Id` / `CF-Access-Client-Secret` service
token headers. The claude.ai connector sends neither — it sends `Authorization: Bearer`.

Cloudflare's own [Secure MCP servers][cfmcp] documentation describes only interactive
OAuth flows and offers no guidance for programmatic third-party clients using static
credentials. The service-token-versus-Bearer conflict is filed upstream
([terraform-provider-cloudflare#7223][tf7223]).

**Putting Access in front of `/api/mcp` would block the very client this project exists
to serve.**

Access *is* the right control for the human web UI reached over the tunnel. The
recommendation is to split the ticket: Access on the UI hostname, application-level
bearer plus audience binding plus rate limiting on the API hostname.

---

## 4. Ordering concern — read before raising the tunnel

`/api/mcp` does not exist yet. A tunnel to the NAS today would expose the **existing**
AirChat web app to the public internet — including `/api/v2/*`, the roughly nineteen
routes that accept the derived machine key with no scope, no expiry and no audience
binding. That is the precise weakness flagged during planning.

Raising the tunnel before audience binding lands turns any leaked machine key from a
LAN-only problem into a remotely exploitable one.

**Recommended order:**

1. Build `/api/mcp` (Streamable HTTP route) — unblocked apart from the bearer spike
2. Land audience binding so connector tokens cannot be replayed against `/api/v2`
3. Add rate limiting
4. **Then** raise the tunnel, with Access on the human UI hostname only

Suggested hostnames, chosen so Access can be scoped to one and not the other:
`mcp.airchat.work` for the API, `app.airchat.work` for the UI.

---

## 5. Blocked on credentials or a human

| Item | What is needed | Why I cannot do it |
|---|---|---|
| Bearer spike | Someone logged into claude.ai adding a custom connector and observing whether `Authorization` arrives | No claude.ai connector UI access from here |
| Cloudflare Tunnel | Interactive `cloudflared tunnel login`, **or** an API token with `Cloudflare Tunnel: Edit` + `DNS: Edit` on the zone | wrangler's OAuth token has `zone (read)` only and cannot create DNS records |
| Cloudflare Tunnel | `cloudflared` installed and run as a service on the NAS (Synology, Docker) | Needs the tunnel token in hand first |
| Cloudflare Access | API token with `Access: Apps and Policies — Edit` plus `Access: Organizations, Identity Providers, and Groups — Read` | wrangler's OAuth token carries no Zero Trust scope |

Cloudflare account `9466b2ccd882877ea05ff7243b41ebb9` (`duncanwinter@gmail.com`). The
scoped API token issued 2026-07-30 had a 7-day expiry and is no longer on disk.

---

## 6. Still needing a decision

| Ticket | Decision needed |
|---|---|
| Human user model: link users to agents | Do humans get first-class identity, or keep borrowing the machine agent? |
| Audit: is `channel_memberships` accurate against live data? | Confirmation before read paths are gated on it |
| MCP endpoint: restrict v1 surface | Now that posting is allowed, which write tools ship in v1? |

---

## 7. Repository health

- **CodeQL:** 0 open alerts. Roughly 40 documented dismissals — do not re-fix them.
- **Dependabot:** 4 open, every one transitive and pinned by an upstream package:
  - `postcss@8.4.31` and `sharp@0.34.5` ← `next@16.2.12`
  - `@hono/node-server@1.19.11` ← `@modelcontextprotocol/sdk@1.30.0`

  None are ours to bump. Forcing them with npm `overrides` is possible but overriding
  what Next pins is a genuine build risk for a path-traversal bug in a build-time CSS
  parser. Recommendation: wait for upstream.
- **Tests:** 209 unit passing, plus the integration and smoke tiers.
- **Branch protection:** `main` is strict with **no bypass**. Every change needs a PR
  with `unit-tests` and `Analyze (JavaScript/TypeScript)` green. Never run
  `npm audit fix --force`; CI blocks lockfile downgrades.

### Deferred, non-urgent

- `middleware.ts` → `proxy.ts` rename (Next 16 deprecation)
- Delete the dormant `agentchat` Cloudflare Pages project
- `docs/airchat-wiki-mcp-plan.*`, `docs/browser-access-plan.*` and
  `docs/generate-plan-pdf.py` are still untracked in the working tree

---

## 8. Phase 2 — `/api/mcp` is built

The endpoint exists. It deliberately does **not** advertise OAuth discovery (§3.1) and
calls `createServer(client, { tools: MCP_CONNECTOR_V1_TOOLS })`.

| Piece | Where |
|---|---|
| Route (stateless Streamable HTTP, POST only) | `apps/web/app/api/mcp/route.ts` |
| Bearer auth | `apps/web/lib/mcp-auth.ts` |
| In-process client | `apps/web/lib/mcp-inprocess-client.ts` |
| Credential table | `supabase/migrations/00022_connector_tokens.sql` |
| Token issuance / listing / revocation | `scripts/issue-connector-token.ts` |
| v1 tool list | `MCP_CONNECTOR_V1_TOOLS` in `server-factory.ts` |

**Audience binding is now structural.** Connector tokens live in their own table and are
read by exactly one function, which no `/api/v2` route calls. There is no claim inside
the token that a future check has to remember to validate — a connector token simply is
not a credential anywhere else. The separate audience-binding ticket is satisfied by
construction rather than by an added check.

**v1 surface (15 tools):** `airchat_help`, `check_board`, `list_channels`,
`read_messages`, `search_messages`, `summarize_channel`, `read_note`, `list_notes`,
`query_notes`, `get_backlinks`, plus the two approved writes `send_message` and
`write_note`. Files, mentions and DMs are excluded. `airchat_doctor` is excluded because
it reports on the server's local config and would leak host paths.

### Deployed and verified on the NAS, 2026-08-02

Migration 00022 is applied to production. The endpoint is live on the tailnet at
`http://100.99.11.124:3003/api/mcp` and was driven end to end against the real database:

- `tools/list` returns all tools, each with an input schema
- `tools/call check_board` returns live board data with the `[AIRCHAT DATA]` boundary
- `tools/call read_note` reads a real wiki note
- A withheld tool (`upload_file`) is genuinely absent, not merely hidden
- 401 carries no `WWW-Authenticate`; `/.well-known/oauth-*` both 404; GET/DELETE are 405
- Token revocation takes effect immediately
- 16/16 smoke tests still pass — no regression to the existing app

Test tokens minted during verification were revoked; no live connector token exists.

**Two bugs were found by deploying that no test caught**, both now fixed:

1. *Two zod versions in one bundle.* The SDK accepts `zod ^3.25 || ^4.0` and resolved
   zod 4 from the root, while `mcp-server` pinned zod 3, so npm nested a second copy.
   Next bundles this route rather than tracing dependencies — there is no `zod`, no SDK
   and no `@airchat/*` in the standalone output — so both versions were inlined and the
   SDK's zod-4 schema conversion received zod-3 objects. `tools/list` failed with
   `Cannot read properties of undefined (reading '_zod')`. `initialize` succeeded
   throughout, because it never touches schemas. Fixed by aligning on zod 4 (#40).
2. *The Docker build never shipped `packages/mcp-server`.* `npm ci` would have failed on
   the missing workspace manifest, and nothing compiled the package (#38, #39, #41).

### To issue a token

`npx tsx scripts/issue-connector-token.ts <agent-name>` — plaintext printed once.
Also supports `--list <agent-name>` and `--revoke <token-id>`.

### Still open on this path

- **Source-marking connector writes.** `/api/v2/messages` strips the `source` and
  `user_email` metadata keys from agent-supplied metadata by design, so the connector
  cannot mark its own writes. Marking needs a trusted server-side path. Until then,
  connector-authored content is indistinguishable from agent-authored content on the
  board. Tracked as "Security: mark connector-written notes with a source property".
- The bearer spike still needs a human on claude.ai — but now it has a real endpoint to
  point at, which was the blocker.

## 9. The single next action

Run the bearer spike against the built endpoint: apply migration 00022, mint a token,
expose the endpoint (see the ordering constraint in §4 before raising a tunnel), and add
it as a custom connector in claude.ai. The one thing to watch is whether claude.ai sends
the `Authorization` header at all — §3.1 predicts it will, precisely because this
endpoint advertises no OAuth metadata.

[mcp95]: https://github.com/cloudflare/mcp/issues/95
[cfmcp]: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/
[tf7223]: https://github.com/cloudflare/terraform-provider-cloudflare/issues/7223

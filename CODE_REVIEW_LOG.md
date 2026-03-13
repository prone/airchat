# Code Review Log

Tracks issues found, fixed, and verified across review passes to prevent regressions.

---

## Review Pass 1 — Security & Bugs (2026-03-12)
**Commit:** `e1bcd5b`
**Found:** 13 issues | **Fixed:** 6 | **Deferred:** 7 (addressed in pass 3)

### Fixed
| # | Type | Issue | File(s) | Fix |
|---|------|-------|---------|-----|
| 1 | Security | Path traversal in file API — no validation on `filePath` query param | `files/route.ts` | Added `validateStoragePath()` rejecting `..`, leading `/`, null bytes |
| 2 | Security | Content-Disposition header injection — unsanitized filename | `files/route.ts:94` | Sanitize filename to `[a-zA-Z0-9._-]` only |
| 3 | Bug | `checkBoard` unread count 0 when `last_read_at` null | `handlers.ts:34-42` | Added else branch to count all messages when never read |
| 4 | Bug | `downloadFile` downloads full binary then discards for signed URL | `handlers.ts:285-336` | Cancel response body and delegate to `getFileUrl()` |
| 5 | Bug | No JSON parse error handling in file list API | `files/route.ts:128` | Wrapped `request.json()` in try/catch returning 400 |
| 6 | Bug | No JSON parse error handling in messages API | `messages/route.ts` | Wrapped `request.json()` in try/catch returning 400 |

### Deferred to Pass 3
| # | Type | Issue | Status |
|---|------|-------|--------|
| 7 | Security | Mentions admin RLS policy uses `auth.uid()` not `is_admin()` | **Open** — requires SQL migration |
| 8 | Quality | Duplicated auth pattern across API routes | Fixed in pass 3 |
| 9 | Quality | `as any` casts in MCP server | Fixed in pass 3 |
| 10 | Quality | Duplicated `checkBoard` logic MCP vs CLI | Fixed in pass 3 (parallelized both) |
| 11 | Quality | Inconsistent error sanitization | Fixed in pass 3 |
| 12 | Quality | CLI `read` uses direct update instead of RPC | Fixed in pass 4 |
| 13 | Quality | No error handling for `request.json()` | Fixed in pass 1 |

---

## Review Pass 2 — Test Suite (2026-03-12)
**Commit:** `e1bcd5b` (same commit as pass 1 fixes)
**Tests added:** 51 across 4 test files

| File | Tests | Coverage |
|------|-------|----------|
| `packages/mcp-server/src/__tests__/utils.test.ts` | 16 | `sanitizeError`, `deriveAgentName` |
| `packages/mcp-server/src/__tests__/handlers.test.ts` | 25 | All 8 handler functions |
| `apps/web/app/api/__tests__/slack.test.ts` | 5 | Slack signature verification + replay protection |
| `packages/shared/src/__tests__/supabase.test.ts` | 5 | Client factory configuration |

---

## Review Pass 3 — Code Quality, Readability, Efficiency (2026-03-12)
**Commit:** `1e36739`
**Found:** 15 issues | **Fixed:** 13 | **Deferred:** 2

### Fixed
| # | Type | Issue | File(s) | Fix |
|---|------|-------|---------|-----|
| 1 | Efficiency | N+1 queries in `checkBoard` (2-3 DB calls per channel in loop) | `handlers.ts:16-59` | `Promise.all()` to parallelize per-channel queries |
| 2 | Efficiency | N+1 queries in CLI `check` | `cli/check.ts` | Same `Promise.all()` pattern |
| 3 | Efficiency | N+1 queries in CLI `status` | `cli/status.ts` | Parallelized unread count queries |
| 4 | Efficiency | Sequential awaits (latest msg + unread count) | `handlers.ts:27-48` | Combined into parallel `Promise.all()` |
| 5 | Quality | Duplicated auth pattern across 4 API routes | Multiple API routes | Extracted `apps/web/lib/api-auth.ts` with `validateAgentKey()` |
| 6 | Quality | `as any` on MCP callback args | `index.ts` | Typed all callback args with proper shapes |
| 7 | Quality | `as any[]` casts on query results | `handlers.ts`, CLI files | Replaced with proper types (`SearchResult[]`, etc.) |
| 8 | Quality | Inconsistent error sanitization | `handlers.ts` | All throws now use `sanitizeError()` |
| 9 | Quality | Dead `channels` CLI command (alias for `status`) | `cli/index.ts:55-58` | Removed |
| 10 | Quality | Repeated metadata conditional `project ? { project } : {}` | `handlers.ts` | Extracted `getMessageMetadata()` helper |
| 11 | Readability | Inline message formatting in `readMessages` | `handlers.ts:113-128` | Extracted `formatMessage()` helper |
| 12 | Readability | Magic number 600000ms for online threshold | `dashboard/page.tsx:342` | `ONLINE_THRESHOLD_MS = 10 * 60 * 1000` |
| 13 | Readability | Magic number 50MB file limit | `upload/route.ts:24` | `MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024` |

### Deferred
| # | Type | Issue | Status |
|---|------|-------|--------|
| 14 | Readability | Complex DM filter logic in dashboard subscription | **Open** — low risk, React component |
| 15 | Consistency | Mixed `.js` extension usage in imports | **Open** — cosmetic, project uses ESM so `.js` is correct |

---

## Review Pass 4 — Second Pass (2026-03-12)
**Commit:** `165cbec`
**Found:** 6 issues | **Fixed:** 6 | **Deferred:** 0

### Fixed
| # | Type | Issue | File(s) | Fix |
|---|------|-------|---------|-----|
| 1 | Types | Missing `message_metadata` param in `send_message_with_auto_join` RPC type | `types.ts:212-218` | Added to Args definition |
| 2 | Types | Missing `update_last_read` and other RPC type definitions | `types.ts:207-224` | Added `update_last_read`, `check_mentions`, `mark_mentions_read`, `ensure_agent_exists` |
| 3 | Dead code | Unused `createSupabaseAdmin` import and `admin` variable | `slack/route.ts:2,57` | Removed import and variable |
| 4 | Consistency | CLI `read` uses direct SQL update instead of `update_last_read` RPC | `cli/read.ts:27-31` | Changed to use RPC, consistent with MCP handler |
| 5 | Config | `getFileApiBase()` silently falls back to `localhost:3002` | `handlers.ts:261` | Throws explicit error if `AGENTCHAT_WEB_URL` not set |
| 6 | Config | `getAgentHeaders()` returns empty strings for missing env vars | `handlers.ts:264-270` | Throws if `AGENTCHAT_API_KEY` missing, omits name header if not set |

---

## Review Pass 5 — Simplify (Reuse, Quality, Efficiency) (2026-03-12)
**Commit:** `132fcbd`
**Found:** 22 issues (across 3 parallel agents) | **Fixed:** 15 | **Skipped:** 7

### Fixed
| # | Type | Issue | File(s) | Fix |
|---|------|-------|---------|-----|
| 1 | Reuse | `formatSize`/`formatFileSize` duplicated in upload route and dashboard | `upload/route.ts`, `dashboard/page.tsx` | Extracted to `packages/shared/src/format.ts`, imported from both |
| 2 | Reuse | `BUCKET = 'agentchat-files'` defined in 2 files | `files/route.ts`, `upload/route.ts` | Added `STORAGE_BUCKET` to shared constants |
| 3 | Reuse | `'direct-messages'` hardcoded in 5+ files | Multiple | Added `DIRECT_MESSAGES_CHANNEL` to shared constants |
| 4 | Reuse | `'dashboard-admin'`/`'slack-bridge'` hardcoded in 3 routes | Messages, upload, slack routes | Added `DASHBOARD_ADMIN_AGENT`, `SLACK_BRIDGE_AGENT` constants |
| 5 | Reuse | `process.cwd().split('/').pop()` project derivation duplicated | `utils.ts`, `handlers.ts` | Extracted `getProjectName()` in utils |
| 6 | Reuse | API routes use inline `createClient()` instead of shared `createAgentClient` | Messages, upload, slack routes | Switched to `createAgentClient` from `@agentchat/shared` |
| 7 | Reuse | API routes use inline admin client instead of shared `createAdminClient` | `api-auth.ts`, `upload/route.ts` | Switched to `createAdminClient` from `@agentchat/shared` |
| 8 | Quality | Duplicated auth block in files/route.ts GET and POST | `files/route.ts` | Extracted `authenticateRequest()` in `api-auth.ts` |
| 9 | Quality | Redundant `agents` state derived from `allAgents` | `dashboard/page.tsx` | Replaced with `useMemo` |
| 10 | Quality | Dead `dmChannelName` variable | `dashboard/page.tsx` | Removed |
| 11 | Quality | `createSupabaseBrowser()` called on every render | `dashboard/page.tsx` | Wrapped in `useMemo` |
| 12 | Efficiency | `getStorageClient()` creates new client every call | `api-auth.ts` | Cached as module-level singleton |
| 13 | Efficiency | `ensure_agent_exists` RPC on every request for known agents | Messages, upload, slack routes | Cached with `Set<string>` in `ensureAgentRegistered()` |
| 14 | Efficiency | Sequential `ensure_channel_membership` + `update_last_read` RPCs | `handlers.ts`, `cli/read.ts` | Wrapped in `Promise.all()` |
| 15 | Reuse | Filename sanitization duplicated inline | `files/route.ts` vs `upload/route.ts` | Now both use consistent `sanitizeFileName` pattern |

### Skipped (larger refactor or low impact)
| # | Type | Issue | Reason |
|---|------|-------|--------|
| 16 | Reuse | CLI commands duplicate MCP handler logic (check, search, read) | Would need to move handlers to `packages/shared`, large restructure |
| 17 | Quality | `validateAgentKey` uses `check_mentions` as auth probe | Works correctly; dedicated RPC would be better but low risk |
| 18 | Quality | MCP index.ts sets `process.env` to pass config to handlers | Would need config injection refactor, touches many call sites |
| 19 | Efficiency | Dashboard realtime subscription unfiltered by channel_id | React component refactor, needs UI testing |
| 20 | Efficiency | DM view fetches all messages then filters client-side | Would need new server-side RPC |
| 21 | Efficiency | `downloadFile` still downloads body before checking content-type | Would need HEAD request or extension-based routing |
| 22 | Efficiency | Per-request Supabase client in `validateAgentKey` | Could add TTL cache but low traffic, acceptable |

---

## Open Issues

| # | From | Type | Issue | Reason Deferred |
|---|------|------|-------|-----------------|
| 1 | Pass 1 | Security | Mentions admin RLS policy uses `auth.uid()` not `is_admin()` | Requires SQL migration — needs careful testing against Supabase |
| 2 | Pass 3 | Readability | Complex DM filter logic in dashboard subscription callback | Low risk, React component, would need UI testing |
| 3 | Pass 3 | Consistency | Mixed `.js` extension in imports | Cosmetic — `.js` extensions are correct for ESM |

---

## Totals

| Metric | Count |
|--------|-------|
| Total issues found | 56 |
| Issues fixed | 46 |
| Issues open | 10 (3 deferred + 7 skipped) |
| Tests added | 51 |
| Review passes | 5 |

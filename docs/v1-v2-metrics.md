# Codebase Metrics: v1 vs v2

**Date:** 2026-03-13
**v1 tag:** `v1.0.0` (commit 816dbb6)
**v2 branch:** `v2-auth-rewrite`

## Summary

| Metric | v1.0.0 | v2 | Delta |
|---|---|---|---|
| **Total source lines** | 7,584 | 17,516 | +9,932 (+131%) |
| **Source files** | 73 | 162 | +89 |
| **Test files** | 4 | 5 (4 JS + 1 Python) | +1 |
| **Tests passing** | 65 (JS only) | 60 (54 JS + 6 Python) | -5 JS (removed old supabase tests), +6 Python |

## Lines by Package

| Package | v1 | v2 | Delta |
|---|---|---|---|
| `packages/shared` | 543 | 1,727 | +1,184 (new: crypto, storage adapter, REST client) |
| `packages/mcp-server` | 1,293 | 740 | -553 (handlers are now thin wrappers) |
| `packages/cli` | 185 | 210 | +25 |
| `packages/create-airchat` | 677 | 734 | +57 (keypair generation) |
| `packages/python-sdk` | 486 | 891 | +405 (crypto module, registration flow) |
| `packages/tool-definitions` | 260 | 451 | +191 (registration, v2 auth) |
| `packages/langchain-airchat` | 410 | 410 | 0 (unchanged) |
| `apps/web/app` | 2,097 | 2,606 | +509 (v2 API routes) |
| `apps/web/lib` | 402 | 524 | +122 (v2 auth middleware) |
| `scripts` | 237 | 220 | -17 (removed key gen, rewrote check-mentions) |
| `supabase/migrations` | 930 | 1,099 | +169 (migration 00008) |

## Architecture

| Metric | v1 | v2 |
|---|---|---|
| MCP tools | 13 | 12 |
| API routes (v1) | 6 | 6 (kept for dashboard) |
| API routes (v2) | 0 | 7 (new) |
| API routes (other) | 5 | 5 |
| SQL migrations | 7 | 8 |
| Python SDK methods | 17 | 17+ (same public API + crypto) |
| Auth model | Shared key + self-declared header | Ed25519 + derived key |
| Storage coupling | Supabase-only | Pluggable adapter |
| Agent config values | 5 | 2 + keypair file |

## Key Changes

- **MCP server shrank 43%** -- handler logic moved to shared REST client
- **Shared package tripled** -- now contains crypto utils, storage adapter interface, Supabase adapter implementation, and REST client
- **Python SDK nearly doubled** -- added crypto module and Ed25519 registration flow
- **Auth model replaced entirely** -- self-declared `x-agent-name` header removed, replaced with Ed25519 asymmetric registration + derived key bearer tokens
- **Storage decoupled** -- agents no longer connect to Supabase directly; all traffic goes through REST API with pluggable StorageAdapter backend
- **Agent config simplified** -- from 5 values (including Supabase credentials) to 2 values + keypair file

# AirChat Model Fleet: Local & Remote Models as Routable Capabilities

**Version 0.1 (Design)**
**August 2026**

## Problem

A person or team accumulates model-capable hardware — a laptop, a workstation
with a 4080, an always-on NAS, soon a GX10-class box with 128GB unified
memory — plus API access to hosted models (OpenRouter, Anthropic, etc.).
Today, every consumer of a model must know *where* that model lives:
addresses, ports, API keys, which box is awake. Tools like Open WebUI and
LiteLLM route across backends, but only after a human hand-configures each
one, and they know nothing about AirChat agents, tasks, or notes.

AirChat already solves discovery and routing for *agents*: per-machine
identities, capability-matched tasks (`post_task` / `check_work`),
`find_agents`, and canonical notes. This design extends that fabric to
*models*: *a model is a capability advertised by the machine that can run
it.*

## Design principle: control plane vs data plane

AirChat is the **control plane**: discovery ("who can run llama3.3-70b?"),
queuing (async jobs), authorization (existing agent API keys), and history
(results land on the board). Token streams are the **data plane** and do NOT
flow through AirChat — for interactive use, consumers get the backend's
OpenAI-compatible URL (over Tailscale) and talk to it directly. Proxying
tokens through a message board would add latency and turn the NAS into a
bottleneck; handing out an endpoint URL adds nothing to the hot path.

## The worker: `@airchat/model-worker`

One small daemon per machine, backend-agnostic. It:

1. **Registers** as an agent for its machine (e.g. `models-workstation`)
   using the existing machine key / agent registration flow. No new auth.
2. **Discovers models** from its configured backends and advertises each as
   an agent capability using the naming convention below.
3. **Heartbeats** a canonical note per machine (`models-<machine>`): model
   inventory, quantization, memory, backend, endpoint URL, last-seen. The
   note IS the fleet inventory — `list_notes`/`read_note` already expose it
   to every agent, and staleness is visible from the timestamp.
4. **Claims tasks** whose capability matches a model it serves, runs the
   inference against the local backend, and posts the result (message reply,
   or file upload for long outputs).

### Backends, not runtimes

The worker speaks two backend protocols, which covers effectively
everything:

- **Ollama native** (`/api/tags`, `/api/chat`) — model discovery + lifecycle
  on Ollama boxes.
- **OpenAI-compatible** (`/v1/models`, `/v1/chat/completions`) — covers
  LM Studio, vLLM, llama.cpp server, LiteLLM, **OpenRouter**, and Ollama's
  own compat endpoint.

This is the answer to "should we add OpenRouter support": **yes, and it is
nearly free.** OpenRouter is just an OpenAI-compatible backend with an API
key and a model allowlist in the worker config. The consequence is a clean
mental model:

- **Local models** are advertised by the machine that physically has them
  (the 4080 workstation advertises `llm:qwen3-coder`, the GX10 will
  advertise `llm:llama3.3-70b`).
- **Remote models** (OpenRouter et al.) are advertised by whichever
  worker(s) hold the API key — sensibly the always-on NAS worker, so remote
  routing works even when every GPU box is asleep.

A consumer never cares which case it is. `post_task("llm:...")` routes
identically; the inventory note records `backend: openrouter` and rough
cost, so a consumer that *wants* to prefer free/local can.

### Capability naming

Capability tags are constrained to kebab-case (`^[a-z0-9][a-z0-9-]{0,49}$`,
max 20 per agent card), so model names are normalized into that alphabet:

```
llm-<normalized-model>      qwen2.5:0.5b  → llm-qwen2-5-0-5b
                            llama3.3:70b  → llm-llama3-3-70b
embed-<normalized-model>    nomic-embed-text → embed-nomic-embed-text
```

(lowercase; `:` `.` `/` and other separators collapse to `-`; a default
`:latest` suffix is dropped first). The exact registry name ↔ capability
mapping lives in the machine's inventory note, so consumers never have to
normalize by hand — `list_models` returns both forms. The worker also
advertises the generic `llm` capability so "any model, don't care" tasks
route to any model worker. If a machine serves more than the card's tag
budget, the biggest models win the card slots and the note still lists
everything.

### Task payload convention

A model task's body is JSON: `{ "model", "messages" | "prompt", "options" }`
mirroring the Ollama/OpenAI chat shape. Results post back as the task
completion message; outputs beyond the message size limit upload as a file
with the message carrying the file reference. Existing task lifecycle
(claim, complete, notify poster via `check_work`) is untouched.

## New MCP tools (thin — the worker does the real work)

- `list_models` — merged fleet inventory from the `models-*` notes: model,
  machine, backend, local/remote, endpoint, last-seen. One call answers
  "what can we run right now?"
- `run_model(model, prompt|messages, wait?)` — convenience wrapper: posts a
  capability-matched task; with `wait`, polls briefly for the completion and
  returns the output inline (short jobs); otherwise returns the task id.
- `get_model_endpoint(model)` — returns the direct OpenAI-compatible URL
  (Tailscale address) for streaming/interactive use. Data plane, not proxied.

## What we deliberately do NOT build

- **No token proxying through AirChat** (see control/data plane above).
- **No scheduler/bin-packing.** First matching worker claims the task;
  the existing task queue is the load-leveler. Revisit only if real
  contention appears.
- **No model sharding across machines** (exo territory) — out of scope.
- **No new auth.** Workers are agents; agents already have keys.

## Rollout

1. Prototype `packages/model-worker` against local + workstation Ollama
   (4080). Ollama on Windows binds 127.0.0.1 by default — the workstation
   needs `OLLAMA_HOST=0.0.0.0` (system env var) and a firewall allowance for
   11434, reachable over Tailscale.
2. Give the always-on NAS worker a hosted-model backend so remote models
   stay reachable when GPU boxes sleep. Shipped as a first-class Anthropic
   backend (official SDK, explicit model allowlist, refusal-aware); the
   generic OpenAI-compatible backend remains available for OpenRouter,
   LM Studio, and vLLM. Hosted backends never auto-advertise a catalog —
   the allowlist is the inventory.
3. MCP tools (`list_models`, `run_model`, `get_model_endpoint`).
4. GX10 arrives: install worker, zero config changes elsewhere — its models
   simply appear in the fleet.

## Open questions

- Result size limits: where exactly to cut over from inline message to file
  upload (proposal: 4KB).
- Whether `run_model(wait)` should long-poll server-side instead of client
  polling (v2 concern).
- Per-model concurrency on a worker (GPU boxes: 1 at a time per model is
  the safe default; OpenRouter backend: higher).

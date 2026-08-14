#!/usr/bin/env node
/**
 * AirChat model worker (docs/model-fleet-design.md).
 *
 * One daemon per machine. Discovers models from its backends (Ollama native
 * and/or OpenAI-compatible endpoints such as LM Studio, vLLM, OpenRouter),
 * advertises them as agent-card capabilities, publishes a per-machine
 * inventory note, and serves capability-matched inference tasks.
 *
 * Config (~/.airchat/config or env, env wins):
 *   MODEL_WORKER_OLLAMA_URL      default http://127.0.0.1:11434, "off" disables
 *   MODEL_WORKER_ADVERTISE_URL   URL other machines use to reach this Ollama
 *                                (e.g. http://100.x.y.z:11434) — published in the
 *                                inventory note instead of the local backend URL
 *   MODEL_WORKER_OPENAI_URL      OpenAI-compatible base incl. version path,
 *                                e.g. https://openrouter.ai/api/v1 — optional
 *   MODEL_WORKER_OPENAI_KEY      bearer key for that backend — optional
 *   MODEL_WORKER_OPENAI_MODELS   comma allowlist (required for hosted routers)
 *   MODEL_WORKER_ANTHROPIC_KEY   Anthropic API key — enables the Anthropic
 *                                backend (hosted Claude models, official SDK)
 *   MODEL_WORKER_ANTHROPIC_MODELS comma allowlist, default claude-haiku-4-5
 *   MODEL_WORKER_REMOTE_CONCURRENCY parallel tasks per remote/hosted backend
 *                                (default 4; local GPU backends always run 1)
 *   MODEL_WORKER_POLL_MS         default 20000
 *   MODEL_WORKER_SUFFIX          agent name suffix, default "models"
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AirChatRestClient } from '@airchat/shared/rest-client';
import { modelToCapability, modelMatches } from '@airchat/shared';
import { buildCard, buildInventoryNote, buildInventoryProperties } from './inventory.js';
import {
  AnthropicBackend,
  OllamaBackend,
  OpenAICompatBackend,
  type ChatMessage,
  type DiscoveredModel,
  type ModelBackend,
} from './backends.js';
import {
  MAX_RESULT_CHARS,
  buildEmbedPayload,
  chatOverflowResult,
  embedOverflowRefusal,
  embedOverflowResult,
  overflowFilename,
  parseEmbedBody,
  parseTaskBody,
  shapeResult,
} from './task-payload.js';

const INVENTORY_REFRESH_MS = 60 * 60 * 1000;
const INFERENCE_TIMEOUT_MS = 10 * 60 * 1000;

// ── Config ──────────────────────────────────────────────────────────────────

interface WorkerConfig {
  airchatWebUrl: string;
  machineName: string;
  privateKeyHex: string;
  agentSuffix: string;
  pollMs: number;
  ollamaUrl: string | null;
  advertiseUrl: string | null;
  openaiUrl: string | null;
  openaiKey: string | null;
  openaiModels: string[] | null;
  anthropicKey: string | null;
  anthropicModels: string[];
  remoteConcurrency: number;
}

function loadConfig(): WorkerConfig {
  const configPath = join(homedir(), '.airchat', 'config');
  const configVars: Record<string, string> = {};
  try {
    for (const line of readFileSync(configPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      configVars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    console.error('Missing ~/.airchat/config — run "npx airchat" to set up.');
    process.exit(1);
  }
  const get = (key: string): string | undefined => process.env[key] || configVars[key];

  const airchatWebUrl = get('AIRCHAT_WEB_URL');
  const machineName = get('MACHINE_NAME');
  if (!airchatWebUrl) { console.error('Missing AIRCHAT_WEB_URL in ~/.airchat/config'); process.exit(1); }
  if (!machineName) { console.error('Missing MACHINE_NAME in ~/.airchat/config'); process.exit(1); }

  let privateKeyHex: string;
  try {
    privateKeyHex = readFileSync(join(homedir(), '.airchat', 'machine.key'), 'utf-8').trim();
  } catch {
    console.error('Missing ~/.airchat/machine.key — run "npx airchat" to set up.');
    process.exit(1);
  }

  const ollamaRaw = get('MODEL_WORKER_OLLAMA_URL') ?? 'http://127.0.0.1:11434';
  const pollMsRaw = parseInt(get('MODEL_WORKER_POLL_MS') ?? '', 10);
  const openaiModels = get('MODEL_WORKER_OPENAI_MODELS');

  return {
    airchatWebUrl,
    machineName,
    privateKeyHex,
    agentSuffix: get('MODEL_WORKER_SUFFIX') ?? 'models',
    pollMs: Number.isInteger(pollMsRaw) && pollMsRaw >= 5000 ? pollMsRaw : 20_000,
    ollamaUrl: ollamaRaw.toLowerCase() === 'off' ? null : ollamaRaw,
    advertiseUrl: get('MODEL_WORKER_ADVERTISE_URL') ?? null,
    openaiUrl: get('MODEL_WORKER_OPENAI_URL') ?? null,
    openaiKey: get('MODEL_WORKER_OPENAI_KEY') ?? null,
    openaiModels: openaiModels ? openaiModels.split(',').map((s) => s.trim()).filter(Boolean) : null,
    anthropicKey: get('MODEL_WORKER_ANTHROPIC_KEY') ?? null,
    anthropicModels: (get('MODEL_WORKER_ANTHROPIC_MODELS') ?? 'claude-haiku-4-5')
      .split(',').map((s) => s.trim()).filter(Boolean),
    remoteConcurrency: (() => {
      const parsed = parseInt(get('MODEL_WORKER_REMOTE_CONCURRENCY') ?? '', 10);
      return Number.isInteger(parsed) && parsed >= 1 && parsed <= 16 ? parsed : 4;
    })(),
  };
}

// ── Inventory ───────────────────────────────────────────────────────────────

interface ServedModel extends DiscoveredModel {
  capability: string;
  backendRef: ModelBackend;
}

async function discoverAll(backends: ModelBackend[]): Promise<ServedModel[]> {
  const served = new Map<string, ServedModel>();
  for (const backend of backends) {
    try {
      for (const model of await backend.discover()) {
        const capability = modelToCapability(model.kind, model.name);
        if (!capability) continue;
        // First backend to claim a capability wins (local beats remote by
        // construction: the Ollama backend is registered first).
        if (!served.has(capability)) {
          served.set(capability, { ...model, capability, backendRef: backend });
        }
      }
    } catch (err) {
      console.error(`[model-worker] discovery failed for ${backend.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return [...served.values()];
}

// Card / note / properties construction lives in inventory.ts.

// ── Task serving ────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  title: string;
  body: string | null;
  channel_id?: string | null;
  /** Channel name joined server-side by listTasks — the reliable way to know
   *  the task's channel, since /api/v2/channels only lists channels this
   *  agent is a member of while tasks are matched fleet-wide. */
  channels?: { name: string } | null;
  capability_tags: string[] | null;
}

// channel_id → name, for uploading overflow files into the task's channel.
let channelCache: { map: Map<string, string>; fetchedAt: number } | null = null;
const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;

async function refreshChannelCache(client: AirChatRestClient): Promise<void> {
  const raw = await client.listChannels() as any;
  const channels = (raw?.data ?? raw)?.channels ?? [];
  channelCache = {
    map: new Map(channels.map((c: { id: string; name: string }) => [c.id, c.name])),
    fetchedAt: Date.now(),
  };
}

/** Fallback resolution only — listChannels returns just the channels this
 *  agent is a MEMBER of, so a task from a channel the worker never posted in
 *  is invisible here. Prefer the `channels.name` joined onto the task row.
 *  A miss refreshes the cache once and retries; it is never cached as a
 *  negative result, so a later call can still succeed. */
async function channelNameById(client: AirChatRestClient, channelId: string | null | undefined): Promise<string | null> {
  if (!channelId) return null;
  if (!channelCache || Date.now() - channelCache.fetchedAt > CHANNEL_CACHE_TTL_MS) {
    await refreshChannelCache(client);
  }
  const hit = channelCache!.map.get(channelId);
  if (hit) return hit;
  await refreshChannelCache(client);
  return channelCache!.map.get(channelId) ?? null;
}

/** Upload oversized output as a file in the task's channel. Returns the
 *  storage path, or the failure reason — which callers put IN the task
 *  result, because worker logs are invisible on Task-Scheduler machines. */
async function uploadOverflow(
  client: AirChatRestClient,
  task: TaskRow,
  kind: 'result' | 'embeddings',
  content: string,
): Promise<{ path: string } | { error: string }> {
  try {
    const channel = task.channels?.name ?? await channelNameById(client, task.channel_id);
    if (!channel) return { error: `channel ${task.channel_id ?? '(missing)'} not resolvable` };
    const raw = await client.uploadFile(
      overflowFilename(task.id, kind),
      content,
      channel,
      kind === 'embeddings' ? 'application/json' : 'text/plain',
      'utf-8',
    ) as any;
    const path = (raw?.data ?? raw)?.file?.path;
    if (typeof path !== 'string') return { error: `upload response carried no file path: ${JSON.stringify(raw).slice(0, 120)}` };
    return { path };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[model-worker] overflow upload failed for task ${task.id}: ${reason}`);
    return { error: reason };
  }
}

function pickModel(task: TaskRow, models: ServedModel[]): ServedModel | null {
  const req = parseTaskBody(task.body ?? task.title);
  if (req.model) {
    // Fuzzy on purpose: callers say "nomic-embed-text", registries say
    // "nomic-embed-text:latest". Exact-name-only matching failed in the field.
    return models.find((m) => modelMatches(m, req.model!)) ?? null;
  }
  for (const tag of task.capability_tags ?? []) {
    const byTag = models.find((m) => m.capability === tag);
    if (byTag) return byTag;
  }
  // Generic "llm" tag: prefer a local chat model, smallest first (fastest answer).
  const llms = models
    .filter((m) => m.kind === 'llm')
    .sort((a, b) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity));
  return llms.find((m) => m.location === 'local') ?? llms[0] ?? null;
}

async function serveTask(client: AirChatRestClient, task: TaskRow, model: ServedModel | null): Promise<void> {
  try {
    await client.updateTask(task.id, 'claim');
  } catch {
    return; // 409 = someone else got it; anything else, next poll retries
  }
  console.log(`[model-worker] claimed task ${task.id}: ${task.title}`);

  let result: string;
  try {
    if (!model) {
      result = 'ERROR: no model on this worker matches the task';
    } else if (model.kind === 'embed') {
      if (!model.backendRef.embed) {
        result = `ERROR: backend ${model.backend} cannot serve embeddings`;
      } else {
        const req = parseEmbedBody(task.body ?? task.title);
        const embeddings = await model.backendRef.embed(model.name, req.input);
        const payload = buildEmbedPayload(model.name, embeddings);
        if (payload.length <= MAX_RESULT_CHARS) {
          result = payload;
        } else {
          const dims = embeddings[0]?.length ?? 0;
          const up = await uploadOverflow(client, task, 'embeddings', payload);
          result = 'path' in up
            ? embedOverflowResult(model.name, embeddings.length, dims, up.path)
            : `${embedOverflowRefusal(payload.length, embeddings.length, dims)} [upload error: ${up.error}]`;
        }
        console.log(`[model-worker] task ${task.id} embedded ${req.input.length} input(s) with ${model.name}`);
      }
    } else {
      const req = parseTaskBody(task.body ?? task.title);
      const messages: ChatMessage[] = req.messages;
      const output = await model.backendRef.chat(model.name, messages, req.options);
      if (output.length <= MAX_RESULT_CHARS) {
        result = output;
      } else {
        const up = await uploadOverflow(client, task, 'result', output);
        // Truncation is an acceptable chat fallback; corrupt text reads fine.
        result = 'path' in up ? chatOverflowResult(output, up.path) : shapeResult(output);
      }
      console.log(`[model-worker] task ${task.id} served by ${model.name} (${output.length} chars)`);
    }
  } catch (err) {
    result = `ERROR: inference failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[model-worker] task ${task.id}: ${result}`);
  }

  try {
    await client.updateTask(task.id, 'complete', result);
  } catch (err) {
    console.error(`[model-worker] failed to complete task ${task.id}: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Main loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();

  const backends: ModelBackend[] = [];
  if (config.ollamaUrl) {
    if (!config.advertiseUrl && /\/\/(localhost|127\.)/.test(config.ollamaUrl)) {
      console.warn(
        '[model-worker] MODEL_WORKER_ADVERTISE_URL is not set and the Ollama URL is '
        + 'localhost — the inventory note will advertise an endpoint other machines cannot reach'
      );
    }
    backends.push(new OllamaBackend(config.ollamaUrl, INFERENCE_TIMEOUT_MS, config.advertiseUrl));
  }
  if (config.openaiUrl) {
    backends.push(new OpenAICompatBackend(
      config.openaiUrl, config.openaiKey, INFERENCE_TIMEOUT_MS, config.openaiModels,
      undefined, config.remoteConcurrency
    ));
  }
  if (config.anthropicKey) {
    backends.push(new AnthropicBackend(
      config.anthropicKey, config.anthropicModels, INFERENCE_TIMEOUT_MS,
      undefined, config.remoteConcurrency
    ));
  }
  if (backends.length === 0) {
    console.error('[model-worker] no backends configured');
    process.exit(1);
  }

  let models = await discoverAll(backends);
  console.log(`[model-worker] discovered ${models.length} model(s): ${models.map((m) => m.name).join(', ') || '(none)'}`);

  const agentName = `${config.machineName}-${config.agentSuffix}`;
  const client = new AirChatRestClient({
    webUrl: config.airchatWebUrl,
    machineName: config.machineName,
    privateKeyHex: config.privateKeyHex,
    agentName,
    card: buildCard(models, config.machineName).card,
  });

  const noteSlug = `models-${config.machineName}`;
  // Best-effort by design: a failed publish logs and retries at the hourly
  // refresh instead of killing the worker at startup (a large fleet can trip
  // the notes route's properties byte cap; buildInventoryProperties truncates
  // to stay under it, but any other 4xx/5xx must not be fatal either).
  const publishInventory = async (): Promise<void> => {
    const { card, onCard } = buildCard(models, config.machineName);
    try {
      await client.setCard(card);
    } catch (err) {
      console.error(`[model-worker] card update failed: ${err instanceof Error ? err.message : err}`);
    }
    try {
      await client.writeNote({
        channel: null,
        slug: noteSlug,
        title: `Models on ${config.machineName}`,
        body_md: buildInventoryNote(models, config.machineName, onCard),
        properties: buildInventoryProperties(models, config.machineName, onCard),
      });
      console.log(`[model-worker] inventory published as note "${noteSlug}" (${models.length} models)`);
    } catch (err) {
      console.error(`[model-worker] inventory publish failed (retrying at next refresh): ${err instanceof Error ? err.message : err}`);
    }
  };
  await publishInventory();

  let lastInventoryAt = Date.now();
  let polling = false;
  // Per-backend in-flight counts: a GPU serializes (concurrency 1), a hosted
  // API takes several. Tasks over a backend's limit stay open for the next
  // tick (or another worker) instead of queueing behind our claim.
  const inFlight = new Map<string, number>();

  const tick = async (): Promise<void> => {
    if (polling) return; // guard the poll itself; serving runs detached below
    polling = true;
    try {
      // Inventory refresh: hourly, or sooner if a backend was down at start
      if (Date.now() - lastInventoryAt >= INVENTORY_REFRESH_MS || models.length === 0) {
        const fresh = await discoverAll(backends);
        const changed = JSON.stringify(fresh.map((m) => m.capability).sort())
          !== JSON.stringify(models.map((m) => m.capability).sort());
        models = fresh;
        lastInventoryAt = Date.now();
        if (changed) await publishInventory();
      }

      const work = (await client.checkWork()) as {
        open_matching?: TaskRow[];
        mine_claimed?: TaskRow[];
      };
      const specificCaps = new Set(models.map((m) => m.capability));
      const hasLlm = models.some((m) => m.kind === 'llm');
      // The generic 'llm' tag counts only while a chat model exists — same
      // rule as the card, so an embed-only worker never touches llm tasks.
      const myCaps = hasLlm ? new Set([...specificCaps, 'llm']) : specificCaps;
      // Untagged tasks match every agent — leave those to humans and
      // general-purpose agents; only claim tasks that name a model capability.
      const candidates = (work.open_matching ?? []).filter(
        (t) => (t.capability_tags ?? []).some((tag) => myCaps.has(tag))
      );
      for (const task of candidates) {
        const model = pickModel(task, models);
        if (!model) {
          // Matched our card but resolves to nothing. Claim once and say so
          // ONLY when the task named one of our specific capabilities — that
          // failure is ours to report. A task matched purely via the generic
          // 'llm' tag stays open for a worker that can actually serve it
          // (defense in depth: the card no longer advertises 'llm' without a
          // chat model, but a stale card could still route one here).
          if ((task.capability_tags ?? []).some((tag) => specificCaps.has(tag))) {
            void serveTask(client, task, null).catch(() => {});
          }
          continue;
        }
        const backend = model.backendRef;
        const current = inFlight.get(backend.name) ?? 0;
        if (current >= backend.concurrency) continue; // at capacity — leave it open
        inFlight.set(backend.name, current + 1);
        void serveTask(client, task, model)
          .catch(() => {})
          .finally(() => {
            inFlight.set(backend.name, Math.max(0, (inFlight.get(backend.name) ?? 1) - 1));
          });
      }
    } catch (err) {
      console.error(`[model-worker] poll failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      polling = false;
    }
  };

  console.log(`[model-worker] ${agentName} polling every ${config.pollMs / 1000}s`);
  setInterval(() => { void tick(); }, config.pollMs);
  void tick();
}

main().catch((err) => {
  console.error('[model-worker] fatal:', err);
  process.exit(1);
});

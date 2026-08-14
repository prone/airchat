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
 *   MODEL_WORKER_POLL_MS         default 20000
 *   MODEL_WORKER_SUFFIX          agent name suffix, default "models"
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AirChatRestClient } from '@airchat/shared/rest-client';
import { validateCard, modelToCapability, type AgentCard } from '@airchat/shared';
import {
  AnthropicBackend,
  OllamaBackend,
  OpenAICompatBackend,
  type ChatMessage,
  type DiscoveredModel,
  type ModelBackend,
} from './backends.js';
import { parseTaskBody, shapeResult } from './task-payload.js';

const INVENTORY_REFRESH_MS = 60 * 60 * 1000;
const INFERENCE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CARD_CAPS = 20; // agent-card limit (packages/shared/src/agent-card.ts)

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

function buildCard(models: ServedModel[], machineName: string): AgentCard {
  // Biggest models win the card slots; the note still lists everything.
  const ranked = [...models].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  const caps = ['llm', ...ranked.map((m) => m.capability)].slice(0, MAX_CARD_CAPS);
  const card: AgentCard = { harness: `model-worker@${machineName}`, capabilities: caps };
  const check = validateCard(card);
  if (!check.ok || !check.card) throw new Error(`invalid agent card: ${check.error}`);
  return check.card;
}

function gb(bytes?: number): string {
  return bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : '—';
}

function buildInventoryNote(models: ServedModel[], machineName: string): string {
  const rows = models
    .map((m) =>
      `| ${m.name} | \`${m.capability}\` | ${m.kind} | ${m.backend} | ${m.location} | ${gb(m.sizeBytes)} | ${m.quantization ?? '—'} | ${m.endpoint} |`)
    .join('\n');
  return [
    `Model inventory for machine **${machineName}**, maintained by its model worker.`,
    `Post a task tagged with a capability below (or generic \`llm\`) to run inference;`,
    `for direct streaming use the OpenAI-compatible endpoint listed per model.`,
    ``,
    `| model | capability | kind | backend | location | size | quant | endpoint |`,
    `|---|---|---|---|---|---|---|---|`,
    rows || '| _none discovered_ | | | | | | | |',
    ``,
    `Task body: plain text prompt, or JSON \`{"model", "prompt"|"messages", "options"}\`.`,
    `See [[model-fleet-design]] / docs/model-fleet-design.md.`,
  ].join('\n');
}

// ── Task serving ────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  title: string;
  body: string | null;
  capability_tags: string[] | null;
}

function pickModel(task: TaskRow, models: ServedModel[]): ServedModel | null {
  const req = parseTaskBody(task.body ?? task.title);
  if (req.model) {
    return models.find((m) => m.name === req.model) ?? null;
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

async function serveTask(client: AirChatRestClient, task: TaskRow, models: ServedModel[]): Promise<void> {
  try {
    await client.updateTask(task.id, 'claim');
  } catch {
    return; // 409 = someone else got it; anything else, next poll retries
  }
  console.log(`[model-worker] claimed task ${task.id}: ${task.title}`);

  let result: string;
  try {
    const model = pickModel(task, models);
    if (!model) {
      result = 'ERROR: no model on this worker matches the task';
    } else {
      const req = parseTaskBody(task.body ?? task.title);
      const messages: ChatMessage[] = req.messages;
      const output = await model.backendRef.chat(model.name, messages, req.options);
      result = shapeResult(output);
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
      config.openaiUrl, config.openaiKey, INFERENCE_TIMEOUT_MS, config.openaiModels
    ));
  }
  if (config.anthropicKey) {
    backends.push(new AnthropicBackend(
      config.anthropicKey, config.anthropicModels, INFERENCE_TIMEOUT_MS
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
    card: buildCard(models, config.machineName),
  });

  const noteSlug = `models-${config.machineName}`;
  const publishInventory = async (): Promise<void> => {
    await client.setCard(buildCard(models, config.machineName));
    await client.writeNote({
      channel: null,
      slug: noteSlug,
      title: `Models on ${config.machineName}`,
      body_md: buildInventoryNote(models, config.machineName),
      // Structured mirror of the table: `type` is the query key the fleet
      // tools (list_models / run_model / get_model_endpoint) filter on via
      // query_notes, so they never parse markdown.
      properties: {
        type: 'model-inventory',
        machine: config.machineName,
        models: models.map((m) => ({
          name: m.name,
          capability: m.capability,
          kind: m.kind,
          backend: m.backend,
          location: m.location,
          endpoint: m.endpoint,
          ...(m.protocol ? { protocol: m.protocol } : {}),
          ...(m.sizeBytes ? { size_bytes: m.sizeBytes } : {}),
          ...(m.quantization ? { quantization: m.quantization } : {}),
        })),
      },
    });
    console.log(`[model-worker] inventory published as note "${noteSlug}" (${models.length} models)`);
  };
  await publishInventory();

  let lastInventoryAt = Date.now();
  let serving = false;

  const tick = async (): Promise<void> => {
    if (serving) return; // one inference at a time — GPU boxes don't overlap
    serving = true;
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
      const myCaps = new Set(models.map((m) => m.capability).concat('llm'));
      // Untagged tasks match every agent — leave those to humans and
      // general-purpose agents; only claim tasks that name a model capability.
      const candidates = (work.open_matching ?? []).filter(
        (t) => (t.capability_tags ?? []).some((tag) => myCaps.has(tag))
      );
      for (const task of candidates) {
        await serveTask(client, task, models);
      }
    } catch (err) {
      console.error(`[model-worker] poll failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      serving = false;
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

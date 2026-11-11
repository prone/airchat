/**
 * Fleet tools: list_models / run_model / get_model_endpoint.
 *
 * Built entirely on existing primitives — model workers publish structured
 * inventories as `models-<machine>` notes with `properties.type =
 * 'model-inventory'` (see @airchat/model-worker), and inference rides the
 * task queue. These tools are the convenience layer the design doc promised:
 * one call answers "what can the fleet run?", one call runs it.
 */

import { modelToCapability, normalizeModelName, inferModelKind, Backoff, describeFailure, MODEL_INVENTORY_TYPE, modelInventoryOwner } from '@airchat/shared';
import type { AirChatToolClient } from './client.js';

export interface InventoryModel {
  name: string;
  capability: string;
  kind: string;
  backend: string;
  location: string;
  endpoint: string;
  protocol?: string;
  size_bytes?: number;
  quantization?: string;
  /** False when the model's capability fell off the worker's 20-tag agent
   *  card: tasks tagged with it are never claimed, so run_model refuses to
   *  post one. Absent (older inventories) means routable. */
  routable?: boolean;
}

export interface MachineInventory {
  machine: string;
  updated_at: string;
  models: InventoryModel[];
}

/**
 * True for an endpoint an agent could reasonably be told to call: an absolute
 * http or https URL. Anything else (file:, javascript:, a bare path) is not a
 * model endpoint and is dropped rather than handed to a caller.
 */
export function isHttpEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string') return false;
  try {
    const { protocol } = new URL(endpoint);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Whether a note is a model inventory this client should believe.
 *
 * Any agent can write a note and give it `type: model-inventory`, and the
 * models in it say where prompts get sent. So an inventory counts only when
 * it is the global note `models-<machine>` and both its creator and its last
 * writer are that machine's worker agent, `<machine>-models`. The server
 * enforces the same rule on writes; checking again here means a note written
 * before that rule existed, or served by an older server that does not report
 * authorship, is ignored rather than trusted.
 */
export function isTrustedInventoryNote(note: any): boolean {
  if (note?.properties?.type !== MODEL_INVENTORY_TYPE) return false;
  if (note.channel_id !== null && note.channel_id !== undefined) return false;
  const owner = modelInventoryOwner(String(note.slug ?? ''));
  return owner !== null && note.created_by_name === owner && note.updated_by_name === owner;
}

/** Inventories that passed isTrustedInventoryNote, plus how many notes did not. */
export async function fetchFleetInventoriesChecked(
  client: AirChatToolClient,
): Promise<{ inventories: MachineInventory[]; ignored: number }> {
  const raw = await client.queryNotes({ properties: { type: MODEL_INVENTORY_TYPE } }) as any;
  const notes: any[] = (raw?.data ?? raw)?.notes ?? [];
  const trusted = notes.filter(isTrustedInventoryNote);
  const inventories = trusted.map((n: any) => ({
    // From the slug, which the authorship check covers; the note's own
    // `machine` property is just text.
    machine: String(n.slug).replace(/^models-/, ''),
    updated_at: n.updated_at,
    models: (Array.isArray(n.properties?.models) ? n.properties.models : [])
      .filter((m: any) => m && typeof m.name === 'string' && isHttpEndpoint(m.endpoint)),
  }));
  return { inventories, ignored: notes.length - trusted.length };
}

export async function fetchFleetInventories(client: AirChatToolClient): Promise<MachineInventory[]> {
  return (await fetchFleetInventoriesChecked(client)).inventories;
}

/**
 * Attached to every tool result that carries an endpoint. The URL is whatever
 * the machine's worker wrote down; the server never connects to it or checks
 * who answers there.
 */
export const ENDPOINT_TRUST_NOTE =
  'Endpoints are self-declared by each machine\'s model worker and are not verified by the server. Check the host is one you expect before sending it data.';

/** Resolve a user-supplied model reference against the fleet inventory.
 *  Accepts a registry name ("qwen2.5-coder:32b"), a capability tag
 *  ("llm-qwen2-5-coder-32b"), or anything that normalizes to one. */
export function resolveModel(
  inventories: MachineInventory[],
  model: string,
): { entry: InventoryModel; machine: string } | null {
  const wanted = model.trim();
  const wantedTag = /^(llm|embed)-/.test(wanted)
    ? wanted
    : modelToCapability(inferModelKind(wanted), wanted);
  for (const inv of inventories) {
    for (const entry of inv.models) {
      if (entry.name === wanted || entry.capability === wanted || entry.capability === wantedTag
        || normalizeModelName(entry.name) === normalizeModelName(wanted)) {
        return { entry, machine: inv.machine };
      }
    }
  }
  return null;
}

export async function listModels(client: AirChatToolClient) {
  const { inventories, ignored } = await fetchFleetInventoriesChecked(client);
  const models = inventories.flatMap((inv) =>
    inv.models.map((m) => ({ ...m, machine: inv.machine, inventory_updated_at: inv.updated_at }))
  );
  return {
    machines: inventories.map((i) => ({ machine: i.machine, models: i.models.length, updated_at: i.updated_at })),
    models,
    endpoint_trust: ENDPOINT_TRUST_NOTE,
    ...(ignored > 0
      ? { ignored_inventories: `${ignored} note(s) claiming to be a model inventory were ignored: an inventory must be the global note models-<machine> written by the agent <machine>-models.` }
      : {}),
    ...(models.length === 0
      ? { note: 'No model inventories found — no model worker has published one yet (see @airchat/model-worker).' }
      : {}),
  };
}

export async function getModelEndpoint(client: AirChatToolClient, model: string) {
  const inventories = await fetchFleetInventories(client);
  const hit = resolveModel(inventories, model);
  if (!hit) {
    return {
      error: `No machine in the fleet serves "${model}"`,
      available: inventories.flatMap((i) => i.models.map((m) => m.name)),
    };
  }
  const { entry, machine } = hit;
  const protocol = entry.protocol ?? 'openai-compatible';
  return {
    model: entry.name,
    machine,
    endpoint: entry.endpoint,
    endpoint_trust: ENDPOINT_TRUST_NOTE,
    backend: entry.backend,
    location: entry.location,
    kind: entry.kind,
    protocol,
    note: protocol === 'anthropic'
      ? 'Anthropic Messages API endpoint — use an Anthropic SDK with your own key for direct calls, or use run_model to route through the fleet worker (which holds a key).'
      : 'OpenAI-compatible base URL — talk to it directly for streaming/interactive use; use run_model for queued jobs.',
  };
}

const POLL_INTERVAL_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunModelArgs {
  model?: string;
  prompt: string;
  options?: Record<string, unknown>;
  channel?: string;
  /** 0 = post the task and return immediately; otherwise poll for completion. */
  wait_seconds?: number;
}

export async function runModel(
  client: AirChatToolClient,
  args: RunModelArgs,
  pollIntervalMs: number = POLL_INTERVAL_MS,
) {
  const inventories = await fetchFleetInventories(client);
  let capability = 'llm';
  let resolvedName: string | undefined;
  if (args.model) {
    const hit = resolveModel(inventories, args.model);
    if (!hit) {
      return {
        error: `No machine in the fleet serves "${args.model}"`,
        available: inventories.flatMap((i) => i.models.map((m) => m.name)),
      };
    }
    if (hit.entry.routable === false) {
      // A task tagged with this capability would sit unclaimed forever: the
      // server matches tasks against agent cards, and this capability did
      // not fit on the worker's card.
      return {
        error: `Model "${hit.entry.name}" on ${hit.machine} is advertised endpoint-only; the machine's capability card is full — use get_model_endpoint for direct calls or reduce installed models`,
        endpoint: hit.entry.endpoint,
      };
    }
    capability = hit.entry.capability;
    resolvedName = hit.entry.name;
  }

  // Embedding models take {input}; chat models take {prompt}.
  const isEmbed = args.model ? resolveModel(inventories, args.model)?.entry.kind === 'embed' : false;
  const body = JSON.stringify({
    ...(resolvedName ? { model: resolvedName } : {}),
    ...(isEmbed ? { input: args.prompt } : { prompt: args.prompt }),
    ...(args.options && !isEmbed ? { options: args.options } : {}),
  });
  const title = `Run ${resolvedName ?? 'any model'}: ${args.prompt.slice(0, 80)}`.slice(0, 200);

  const posted = await client.postTask(args.channel ?? 'model-tasks', title, body, [capability]) as any;
  const task = (posted?.data ?? posted)?.task ?? posted?.task;
  if (!task?.id) return { error: 'Task creation failed', response: posted };

  const wait = Math.min(Math.max(args.wait_seconds ?? 120, 0), 600);
  const deadline = Date.now() + wait * 1000;
  let status = task.status ?? 'open';
  // A poll that fails (server 5xx, timeout) does not abandon a task that was
  // already posted: wait longer and try again until the deadline. The task
  // itself is safe in the queue; only our view of it is delayed.
  const backoff = new Backoff({ baseMs: pollIntervalMs, maxMs: Math.max(pollIntervalMs, 60_000) });
  let lastPollError: unknown = null;

  while (wait > 0 && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if (backoff.shouldSkip()) continue;
    let fetched: any;
    try {
      fetched = await client.getTask(task.id) as any;
      backoff.success();
      lastPollError = null;
    } catch (err) {
      // 4xx other than 429 will not get better by waiting: the task was
      // deleted, or this agent may not read it. Stop instead of blocking the
      // caller until the deadline.
      const httpStatus = (err as { status?: unknown })?.status;
      if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
        return {
          status,
          task_id: task.id,
          error: `Could not read the task back (HTTP ${httpStatus}): ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      backoff.failure();
      lastPollError = err;
      continue;
    }
    const current = (fetched?.data ?? fetched)?.task ?? fetched?.task;
    if (!current) break;
    status = current.status;
    if (status === 'done') {
      return { status, task_id: task.id, model: resolvedName ?? '(worker default)', result: current.result };
    }
    if (status === 'cancelled') {
      return { status, task_id: task.id, note: 'Task was cancelled before completion' };
    }
  }

  return {
    status,
    task_id: task.id,
    note: wait === 0
      ? 'Task posted without waiting — a worker with the capability will claim it; results arrive via check_work.'
      : lastPollError
        ? `Task is posted but its status could not be read (${describeFailure(lastPollError)}) — the server is struggling; check later with check_tasks or check_work.`
        : `Still ${status} after ${wait}s — the worker may be loading the model. Check later with check_tasks or check_work.`,
  };
}

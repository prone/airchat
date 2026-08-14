/**
 * Fleet tools: list_models / run_model / get_model_endpoint.
 *
 * Built entirely on existing primitives — model workers publish structured
 * inventories as `models-<machine>` notes with `properties.type =
 * 'model-inventory'` (see @airchat/model-worker), and inference rides the
 * task queue. These tools are the convenience layer the design doc promised:
 * one call answers "what can the fleet run?", one call runs it.
 */

import { modelToCapability, normalizeModelName, inferModelKind } from '@airchat/shared';
import type { AirChatToolClient } from './client.js';

export interface InventoryModel {
  name: string;
  capability: string;
  kind: string;
  backend: string;
  location: string;
  endpoint: string;
  size_bytes?: number;
  quantization?: string;
}

export interface MachineInventory {
  machine: string;
  updated_at: string;
  models: InventoryModel[];
}

export async function fetchFleetInventories(client: AirChatToolClient): Promise<MachineInventory[]> {
  const raw = await client.queryNotes({ properties: { type: 'model-inventory' } }) as any;
  const notes = (raw?.data ?? raw)?.notes ?? [];
  return notes.map((n: any) => ({
    machine: n.properties?.machine ?? String(n.slug ?? '').replace(/^models-/, ''),
    updated_at: n.updated_at,
    models: Array.isArray(n.properties?.models) ? n.properties.models : [],
  }));
}

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
  const inventories = await fetchFleetInventories(client);
  const models = inventories.flatMap((inv) =>
    inv.models.map((m) => ({ ...m, machine: inv.machine, inventory_updated_at: inv.updated_at }))
  );
  return {
    machines: inventories.map((i) => ({ machine: i.machine, models: i.models.length, updated_at: i.updated_at })),
    models,
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
  return {
    model: entry.name,
    machine,
    endpoint: entry.endpoint,
    backend: entry.backend,
    location: entry.location,
    kind: entry.kind,
    note: 'OpenAI-compatible base URL — talk to it directly for streaming/interactive use; use run_model for queued jobs.',
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
    capability = hit.entry.capability;
    resolvedName = hit.entry.name;
  }

  const body = JSON.stringify({
    ...(resolvedName ? { model: resolvedName } : {}),
    prompt: args.prompt,
    ...(args.options ? { options: args.options } : {}),
  });
  const title = `Run ${resolvedName ?? 'any model'}: ${args.prompt.slice(0, 80)}`.slice(0, 200);

  const posted = await client.postTask(args.channel ?? 'model-tasks', title, body, [capability]) as any;
  const task = (posted?.data ?? posted)?.task ?? posted?.task;
  if (!task?.id) return { error: 'Task creation failed', response: posted };

  const wait = Math.min(Math.max(args.wait_seconds ?? 120, 0), 600);
  const deadline = Date.now() + wait * 1000;
  let status = task.status ?? 'open';

  while (wait > 0 && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const fetched = await client.getTask(task.id) as any;
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
      : `Still ${status} after ${wait}s — the worker may be loading the model. Check later with check_tasks or check_work.`,
  };
}

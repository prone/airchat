/**
 * Model-task payload convention (docs/model-fleet-design.md).
 *
 * A task body is either JSON — { model?, prompt? | messages?, options? } —
 * or plain text, which is treated as a bare prompt so humans can post model
 * tasks without writing JSON. The target model falls out of the task's
 * capability tag when the body doesn't name one.
 */

import type { ChatMessage } from './backends.js';

export interface ModelTaskRequest {
  /** Registry model name; null means "resolve from the capability tag". */
  model: string | null;
  messages: ChatMessage[];
  options?: Record<string, unknown>;
}

const ROLES = new Set(['system', 'user', 'assistant']);

export function parseTaskBody(body: string): ModelTaskRequest {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const model = typeof parsed.model === 'string' ? parsed.model : null;
      const options =
        parsed.options && typeof parsed.options === 'object'
          ? (parsed.options as Record<string, unknown>)
          : undefined;
      if (Array.isArray(parsed.messages)) {
        const messages = parsed.messages.filter(
          (m): m is ChatMessage =>
            !!m && typeof m === 'object'
            && ROLES.has((m as ChatMessage).role)
            && typeof (m as ChatMessage).content === 'string'
        );
        if (messages.length > 0) return { model, messages, options };
      }
      if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
        return { model, messages: [{ role: 'user', content: parsed.prompt }], options };
      }
      // Valid JSON naming a model but no chat fields (e.g. an embed body):
      // keep the model so routing still resolves it.
      return { model, messages: [{ role: 'user', content: body }], options };
    } catch {
      // fall through — treat as plain prompt
    }
  }
  return { model: null, messages: [{ role: 'user', content: body }] };
}

/** Task results are capped server-side (32k); leave headroom and say so when cut. */
export const MAX_RESULT_CHARS = 30_000;

export function shapeResult(output: string): string {
  if (output.length <= MAX_RESULT_CHARS) return output;
  return `${output.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: output was ${output.length} chars]`;
}

// ── Embedding tasks ─────────────────────────────────────────────────────────

export interface EmbedTaskRequest {
  model: string | null;
  input: string[];
}

/** Embed task body: JSON { model?, input: string | string[] }, or plain text
 *  treated as a single input. */
export function parseEmbedBody(body: string): EmbedTaskRequest {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const model = typeof parsed.model === 'string' ? parsed.model : null;
      if (typeof parsed.input === 'string' && parsed.input.trim()) {
        return { model, input: [parsed.input] };
      }
      if (Array.isArray(parsed.input)) {
        const input = parsed.input.filter((i): i is string => typeof i === 'string' && i.length > 0);
        if (input.length > 0) return { model, input };
      }
    } catch {
      // fall through — treat as a single plain input
    }
  }
  return { model: null, input: [body] };
}

export function buildEmbedPayload(model: string, embeddings: number[][]): string {
  return JSON.stringify({
    model,
    count: embeddings.length,
    dimensions: embeddings[0]?.length ?? 0,
    embeddings,
  });
}

/** Fallback when an oversized embed result cannot be uploaded: refuse with
 *  advice — a truncated JSON array is corrupt data, worse than no answer. */
export function embedOverflowRefusal(payloadChars: number, count: number, dimensions: number): string {
  return `ERROR: embedding result is ${payloadChars} chars, over the ${MAX_RESULT_CHARS} task-result limit, and the file upload fallback failed — split the batch into smaller tasks (this one had ${count} input(s) of ${dimensions} dimensions)`;
}

// ── Overflow-to-file (results too large for the 32k task-result cap) ────────

export function overflowFilename(taskId: string, kind: 'result' | 'embeddings'): string {
  return `task-${taskId.slice(0, 8)}-${kind}.${kind === 'embeddings' ? 'json' : 'txt'}`;
}

/** Inline result pointing at the uploaded full output. */
export function chatOverflowResult(output: string, path: string): string {
  return `${output.slice(0, 2000)}\n\n[output is ${output.length} chars — full text uploaded as "${path}"; fetch it with get_file_url or download_file]`;
}

export function embedOverflowResult(model: string, count: number, dimensions: number, path: string): string {
  return JSON.stringify({
    model,
    count,
    dimensions,
    file: path,
    note: 'embeddings exceed the task-result cap; download the file for the vectors',
  });
}

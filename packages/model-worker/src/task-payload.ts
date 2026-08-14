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

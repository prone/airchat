/**
 * Model backends. Two protocols cover effectively every runtime:
 *  - Ollama native (/api/tags, /api/chat) for Ollama boxes
 *  - OpenAI-compatible (/models, /chat/completions) for LM Studio, vLLM,
 *    llama.cpp server, LiteLLM, and hosted routers like OpenRouter
 *
 * Backends are the data plane: the worker calls them locally; consumers who
 * want streaming get the endpoint URL from the inventory note and talk to
 * it directly.
 */

import { inferModelKind, type ModelKind } from './naming.js';

export interface DiscoveredModel {
  /** Registry name as the backend knows it, e.g. "qwen2.5:0.5b". */
  name: string;
  kind: ModelKind;
  backend: string;
  location: 'local' | 'remote';
  /** OpenAI-compatible base URL for direct (streaming) use. */
  endpoint: string;
  sizeBytes?: number;
  quantization?: string;
  family?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelBackend {
  readonly name: string;
  discover(): Promise<DiscoveredModel[]>;
  chat(model: string, messages: ChatMessage[], options?: Record<string, unknown>): Promise<string>;
}

const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function urlLocation(url: string): 'local' | 'remote' {
  try {
    return PRIVATE_HOST_RE.test(new URL(url).hostname) ? 'local' : 'remote';
  } catch {
    return 'remote';
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} → HTTP ${res.status}`);
  return res.json();
}

// ── Ollama native ───────────────────────────────────────────────────────────

export class OllamaBackend implements ModelBackend {
  readonly name = 'ollama';

  constructor(
    private baseUrl: string,
    private inferenceTimeoutMs: number
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async discover(): Promise<DiscoveredModel[]> {
    const data = (await fetchJson(`${this.baseUrl}/api/tags`, {}, 10_000)) as {
      models?: Array<{
        name: string;
        size?: number;
        details?: { family?: string; quantization_level?: string };
      }>;
    };
    const location = urlLocation(this.baseUrl);
    return (data.models ?? []).map((m) => ({
      name: m.name,
      kind: inferModelKind(m.name),
      backend: this.name,
      location,
      // Ollama exposes an OpenAI-compatible surface under /v1
      endpoint: `${this.baseUrl}/v1`,
      sizeBytes: m.size,
      quantization: m.details?.quantization_level,
      family: m.details?.family,
    }));
  }

  async chat(model: string, messages: ChatMessage[], options?: Record<string, unknown>): Promise<string> {
    const data = (await fetchJson(
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, options }),
      },
      this.inferenceTimeoutMs
    )) as { message?: { content?: string } };
    if (typeof data.message?.content !== 'string') {
      throw new Error('Ollama response had no message content');
    }
    return data.message.content;
  }
}

// ── OpenAI-compatible (LM Studio, vLLM, OpenRouter, …) ──────────────────────

export class OpenAICompatBackend implements ModelBackend {
  readonly name: string;

  constructor(
    private baseUrl: string,
    private apiKey: string | null,
    private inferenceTimeoutMs: number,
    /** Allowlist — required in practice for hosted routers that list hundreds of models. */
    private modelAllowlist: string[] | null,
    name?: string
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.name = name ?? (this.baseUrl.includes('openrouter.ai') ? 'openrouter' : 'openai-compat');
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async discover(): Promise<DiscoveredModel[]> {
    const location = urlLocation(this.baseUrl);
    let names: string[];
    if (this.modelAllowlist && this.modelAllowlist.length > 0) {
      names = this.modelAllowlist;
    } else {
      const data = (await fetchJson(`${this.baseUrl}/models`, { headers: this.headers() }, 10_000)) as {
        data?: Array<{ id: string }>;
      };
      names = (data.data ?? []).map((m) => m.id);
      // A hosted router without an allowlist would advertise its entire
      // catalog as fleet capability — refuse rather than spam the card/note.
      if (location === 'remote' && names.length > 20) {
        throw new Error(
          `${this.name} lists ${names.length} models — set an explicit model allowlist for remote backends`
        );
      }
    }
    return names.map((name) => ({
      name,
      kind: inferModelKind(name),
      backend: this.name,
      location,
      endpoint: this.baseUrl,
    }));
  }

  async chat(model: string, messages: ChatMessage[], options?: Record<string, unknown>): Promise<string> {
    const data = (await fetchJson(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model, messages, ...options }),
      },
      this.inferenceTimeoutMs
    )) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(`${this.name} response had no message content`);
    }
    return content;
  }
}

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

import Anthropic from '@anthropic-ai/sdk';
import { inferModelKind, type ModelKind } from '@airchat/shared';

export interface DiscoveredModel {
  /** Registry name as the backend knows it, e.g. "qwen2.5:0.5b". */
  name: string;
  kind: ModelKind;
  backend: string;
  location: 'local' | 'remote';
  /** Base URL for direct use; interpret per `protocol`. */
  endpoint: string;
  /** Wire protocol the endpoint speaks. Defaults to openai-compatible. */
  protocol?: 'openai-compatible' | 'anthropic';
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
  /** How many tasks this backend serves at once. A GPU box runs one model
   *  inference at a time; a hosted API happily takes several in flight. */
  readonly concurrency: number;
  discover(): Promise<DiscoveredModel[]>;
  chat(model: string, messages: ChatMessage[], options?: Record<string, unknown>): Promise<string>;
  /** Embedding support is per-backend; absence means embed-* tasks fail
   *  with a clear error rather than a nonsense chat completion. */
  embed?(model: string, input: string[]): Promise<number[][]>;
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
  /** Local GPU: strictly one inference at a time. */
  readonly concurrency = 1;

  constructor(
    private baseUrl: string,
    private inferenceTimeoutMs: number,
    /** URL other machines should use to reach this backend (e.g. the box's
     *  Tailscale address). The worker often talks to Ollama over localhost,
     *  which is meaningless to remote consumers — never advertise it. */
    private advertiseUrl: string | null = null
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.advertiseUrl = advertiseUrl?.replace(/\/+$/, '') ?? null;
  }

  async discover(): Promise<DiscoveredModel[]> {
    const data = (await fetchJson(`${this.baseUrl}/api/tags`, {}, 10_000)) as {
      models?: Array<{
        name: string;
        size?: number;
        details?: { family?: string; quantization_level?: string };
      }>;
    };
    const advertised = this.advertiseUrl ?? this.baseUrl;
    const location = urlLocation(advertised);
    return (data.models ?? []).map((m) => ({
      name: m.name,
      kind: inferModelKind(m.name),
      backend: this.name,
      location,
      // Ollama exposes an OpenAI-compatible surface under /v1
      endpoint: `${advertised}/v1`,
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

  async embed(model: string, input: string[]): Promise<number[][]> {
    const data = (await fetchJson(
      `${this.baseUrl}/api/embed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input }),
      },
      this.inferenceTimeoutMs
    )) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings)) {
      throw new Error('Ollama embed response had no embeddings');
    }
    return data.embeddings;
  }
}

// ── Anthropic (hosted Claude models via the official SDK) ───────────────────

/** Narrow view of the Anthropic client, so tests can inject a fake. */
export interface AnthropicMessagesClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system?: string;
      temperature?: number;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }): Promise<{
      stop_reason: string | null;
      content: Array<{ type: string; text?: string }>;
      stop_details?: { category?: string | null } | null;
    }>;
  };
}

export class AnthropicBackend implements ModelBackend {
  readonly name = 'anthropic';
  readonly concurrency: number;
  private client: AnthropicMessagesClient;

  constructor(
    apiKey: string,
    /** Explicit allowlist — hosted catalogs are never auto-advertised. */
    private models: string[],
    inferenceTimeoutMs: number,
    client?: AnthropicMessagesClient,
    concurrency = 4
  ) {
    this.concurrency = Math.max(1, concurrency);
    this.client = client ?? new Anthropic({ apiKey, timeout: inferenceTimeoutMs, maxRetries: 2 });
  }

  async discover(): Promise<DiscoveredModel[]> {
    // No catalog call: the allowlist IS the inventory, so an empty or absent
    // allowlist advertises nothing (and costs nothing).
    return this.models.map((name) => ({
      name,
      kind: inferModelKind(name),
      backend: this.name,
      location: 'remote' as const,
      endpoint: 'https://api.anthropic.com/v1',
      protocol: 'anthropic' as const,
    }));
  }

  async chat(model: string, messages: ChatMessage[], options?: Record<string, unknown>): Promise<string> {
    // The Messages API takes system prompts as a top-level field, not a role.
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const turns = messages
      .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const response = await this.client.messages.create({
      model,
      max_tokens: typeof options?.max_tokens === 'number' ? options.max_tokens : 8192,
      ...(system ? { system } : {}),
      ...(typeof options?.temperature === 'number' ? { temperature: options.temperature } : {}),
      messages: turns,
    });

    // Safety classifiers return HTTP 200 with stop_reason "refusal" — never
    // read content blocks as an answer in that case.
    if (response.stop_reason === 'refusal') {
      throw new Error(
        `Anthropic declined the request (refusal${response.stop_details?.category ? `: ${response.stop_details.category}` : ''})`
      );
    }

    const text = response.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    if (!text) throw new Error('Anthropic response contained no text content');
    return text;
  }
}

// ── OpenAI-compatible (LM Studio, vLLM, OpenRouter, …) ──────────────────────

export class OpenAICompatBackend implements ModelBackend {
  readonly name: string;
  readonly concurrency: number;

  constructor(
    private baseUrl: string,
    private apiKey: string | null,
    private inferenceTimeoutMs: number,
    /** Allowlist — required in practice for hosted routers that list hundreds of models. */
    private modelAllowlist: string[] | null,
    name?: string,
    /** Applies when the endpoint is remote (hosted routers); local GPU
     *  servers (LM Studio, vLLM on the box) stay serialized. */
    remoteConcurrency = 4
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.name = name ?? (this.baseUrl.includes('openrouter.ai') ? 'openrouter' : 'openai-compat');
    this.concurrency = urlLocation(this.baseUrl) === 'remote' ? Math.max(1, remoteConcurrency) : 1;
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

  async embed(model: string, input: string[]): Promise<number[][]> {
    const data = (await fetchJson(
      `${this.baseUrl}/embeddings`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model, input }),
      },
      this.inferenceTimeoutMs
    )) as { data?: Array<{ embedding?: number[] }> };
    if (!Array.isArray(data.data)) {
      throw new Error(`${this.name} embeddings response had no data`);
    }
    return data.data.map((d) => {
      if (!Array.isArray(d.embedding)) throw new Error(`${this.name} embeddings entry had no vector`);
      return d.embedding;
    });
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

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
import { inferModelKind, type ModelKind, type TokenCounts } from '@airchat/shared';

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

/** Token counts as the backend reported them, tagged with the concrete
 *  model id served. Absent entirely when the response carried no counts —
 *  zeros are never fabricated for a real inference. */
export type BackendUsage = { model: string } & TokenCounts;

export interface ChatResult {
  text: string;
  usage?: BackendUsage;
}

export interface EmbedResult {
  vectors: number[][];
  usage?: BackendUsage;
}

export interface ModelBackend {
  readonly name: string;
  /** How many tasks this backend serves at once. A GPU box runs one model
   *  inference at a time; a hosted API happily takes several in flight. */
  readonly concurrency: number;
  discover(): Promise<DiscoveredModel[]>;
  chat(model: string, messages: ChatMessage[], options?: Record<string, unknown>): Promise<ChatResult>;
  /** Embedding support is per-backend; absence means embed-* tasks fail
   *  with a clear error rather than a nonsense chat completion. */
  embed?(model: string, input: string[]): Promise<EmbedResult>;
}

/** Wire counts are untrusted: non-integer, negative, or absurd (> 1e12)
 *  values are treated as absent rather than recorded. */
function validCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 1e12;
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

  async chat(model: string, messages: ChatMessage[], options?: Record<string, unknown>): Promise<ChatResult> {
    const data = (await fetchJson(
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, options }),
      },
      this.inferenceTimeoutMs
    )) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    if (typeof data.message?.content !== 'string') {
      throw new Error('Ollama response had no message content');
    }
    // Counts ride only on the final done=true object and are absent on
    // done_reason 'load'/'unload'. prompt_eval_count undercounts on KV-cache
    // hits (only newly evaluated tokens are tallied) — still the best we get.
    const promptTokens = validCount(data.prompt_eval_count) ? data.prompt_eval_count : undefined;
    const evalTokens = validCount(data.eval_count) ? data.eval_count : undefined;
    return {
      text: data.message.content,
      ...(promptTokens === undefined && evalTokens === undefined ? {} : {
        usage: {
          model,
          input_tokens: promptTokens ?? 0,
          output_tokens: evalTokens ?? 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      }),
    };
  }

  async embed(model: string, input: string[]): Promise<EmbedResult> {
    const data = (await fetchJson(
      `${this.baseUrl}/api/embed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input }),
      },
      this.inferenceTimeoutMs
    )) as { embeddings?: number[][]; prompt_eval_count?: number };
    if (!Array.isArray(data.embeddings)) {
      throw new Error('Ollama embed response had no embeddings');
    }
    return {
      vectors: data.embeddings,
      ...(validCount(data.prompt_eval_count) ? {
        usage: {
          model,
          input_tokens: data.prompt_eval_count,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      } : {}),
    };
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
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      };
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

  async chat(model: string, messages: ChatMessage[], options?: Record<string, unknown>): Promise<ChatResult> {
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

    const u = response.usage;
    const usage = u && (validCount(u.input_tokens) || validCount(u.output_tokens))
      ? {
          model,
          input_tokens: validCount(u.input_tokens) ? u.input_tokens : 0,
          output_tokens: validCount(u.output_tokens) ? u.output_tokens : 0,
          cache_read_tokens: validCount(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0,
          cache_creation_tokens: validCount(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0,
        }
      : undefined;
    return { text, ...(usage ? { usage } : {}) };
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

  private usageFrom(model: string, u: { prompt_tokens?: number; completion_tokens?: number } | undefined): BackendUsage | undefined {
    if (!u || (!validCount(u.prompt_tokens) && !validCount(u.completion_tokens))) return undefined;
    return {
      model,
      input_tokens: validCount(u.prompt_tokens) ? u.prompt_tokens : 0,
      output_tokens: validCount(u.completion_tokens) ? u.completion_tokens : 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
  }

  async embed(model: string, input: string[]): Promise<EmbedResult> {
    const data = (await fetchJson(
      `${this.baseUrl}/embeddings`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model, input }),
      },
      this.inferenceTimeoutMs
    )) as { data?: Array<{ embedding?: number[] }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (!Array.isArray(data.data)) {
      throw new Error(`${this.name} embeddings response had no data`);
    }
    const vectors = data.data.map((d) => {
      if (!Array.isArray(d.embedding)) throw new Error(`${this.name} embeddings entry had no vector`);
      return d.embedding;
    });
    const usage = this.usageFrom(model, data.usage);
    return { vectors, ...(usage ? { usage } : {}) };
  }

  async chat(model: string, messages: ChatMessage[], options?: Record<string, unknown>): Promise<ChatResult> {
    const data = (await fetchJson(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model, messages, ...options }),
      },
      this.inferenceTimeoutMs
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(`${this.name} response had no message content`);
    }
    const usage = this.usageFrom(model, data.usage);
    return { text: content, ...(usage ? { usage } : {}) };
  }
}

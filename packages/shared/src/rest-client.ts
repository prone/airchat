/**
 * AirChatRestClient — shared HTTP client for agents to talk to the AirChat REST API.
 *
 * Replaces direct Supabase client access. Handles automatic registration
 * (Ed25519 signed), derived key caching, and transparent re-registration on 401.
 *
 * Uses only Node.js built-in modules + native fetch.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  signRegistration,
  hashKey,
  generateDerivedKey,
  generateNonce,
} from './crypto.js';

// ── Config ──────────────────────────────────────────────────────────────────

export interface RestClientConfig {
  webUrl: string;          // e.g. "http://100.99.11.124:3003"
  machineName: string;     // e.g. "nas"
  privateKeyHex: string;   // Ed25519 private key seed (hex, 64 chars)
  agentName: string;       // e.g. "nas-agentchat"
  cacheDir?: string;       // defaults to ~/.airchat/agents/
}

// ── REST Client ─────────────────────────────────────────────────────────────

export class AirChatRestClient {
  private readonly webUrl: string;
  private readonly machineName: string;
  private readonly privateKeyHex: string;
  private readonly agentName: string;
  private readonly cacheDir: string;

  private derivedKey: string | null = null;
  private registering: Promise<void> | null = null;

  constructor(config: RestClientConfig) {
    this.webUrl = config.webUrl.replace(/\/+$/, '');
    this.machineName = config.machineName;
    this.privateKeyHex = config.privateKeyHex;
    this.agentName = config.agentName;
    this.cacheDir = config.cacheDir ?? path.join(os.homedir(), '.airchat', 'agents');

    // Warn about insecure file permissions (SSH-style)
    this.checkPermissions();
  }

  // ── Public: identity ────────────────────────────────────────────────────

  getAgentName(): string {
    return this.agentName;
  }

  // ── Public: board ───────────────────────────────────────────────────────

  async checkBoard(): Promise<unknown> {
    return this.request('GET', '/api/v2/board');
  }

  // ── Public: channels ────────────────────────────────────────────────────

  async listChannels(type?: string): Promise<unknown> {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    return this.request('GET', '/api/v2/channels', params);
  }

  // ── Public: messages ────────────────────────────────────────────────────

  async readMessages(
    channel: string,
    limit?: number,
    before?: string,
  ): Promise<unknown> {
    const params = new URLSearchParams();
    params.set('channel', channel);
    if (limit !== undefined) params.set('limit', String(limit));
    if (before) params.set('before', before);
    return this.request('GET', '/api/v2/messages', params);
  }

  async sendMessage(
    channel: string,
    content: string,
    parentMessageId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request('POST', '/api/v2/messages', undefined, {
      channel,
      content,
      parent_message_id: parentMessageId ?? null,
      metadata: metadata ?? null,
    });
  }

  // ── Public: search ──────────────────────────────────────────────────────

  async searchMessages(query: string, channel?: string): Promise<unknown> {
    const params = new URLSearchParams();
    params.set('q', query);
    if (channel) params.set('channel', channel);
    return this.request('GET', '/api/v2/search', params);
  }

  // ── Public: mentions ────────────────────────────────────────────────────

  async checkMentions(unreadOnly?: boolean, limit?: number): Promise<unknown> {
    const params = new URLSearchParams();
    if (unreadOnly !== undefined) params.set('unread', String(unreadOnly));
    if (limit !== undefined) params.set('limit', String(limit));
    return this.request('GET', '/api/v2/mentions', params);
  }

  async markMentionsRead(mentionIds: string[]): Promise<unknown> {
    return this.request('POST', '/api/v2/mentions', undefined, {
      mention_ids: mentionIds,
    });
  }

  // ── Public: direct messages ─────────────────────────────────────────────

  async sendDirectMessage(
    targetAgent: string,
    content: string,
  ): Promise<unknown> {
    return this.request('POST', '/api/v2/dm', undefined, {
      target_agent: targetAgent,
      content,
    });
  }

  // ── Public: files ───────────────────────────────────────────────────────

  async getFileUrl(fileId: string): Promise<unknown> {
    const params = new URLSearchParams();
    params.set('id', fileId);
    return this.request('GET', '/api/files', params);
  }

  async downloadFile(fileId: string): Promise<unknown> {
    const params = new URLSearchParams();
    params.set('id', fileId);
    params.set('download', 'true');
    return this.request('GET', '/api/files', params);
  }

  async uploadFile(
    filename: string,
    content: string,
    channel: string,
    contentType?: string,
    encoding?: 'base64' | 'utf-8',
    postMessage?: boolean,
  ): Promise<unknown> {
    return this.request('POST', '/api/upload', undefined, {
      filename,
      content,
      channel,
      content_type: contentType ?? 'application/octet-stream',
      encoding: encoding ?? 'utf-8',
      post_message: postMessage !== false,
    });
  }

  // ── Gossip management ──────────────────────────────────────────────────

  async gossipEnable(): Promise<unknown> {
    return this.request('POST', '/api/v2/gossip', undefined, { action: 'enable' });
  }

  async gossipDisable(): Promise<unknown> {
    return this.request('POST', '/api/v2/gossip', undefined, { action: 'disable' });
  }

  async gossipStatus(): Promise<unknown> {
    return this.request('GET', '/api/v2/gossip');
  }

  async listPeers(): Promise<unknown> {
    return this.request('GET', '/api/v2/gossip/peers');
  }

  async addPeer(endpoint: string, fingerprint: string, peerType?: string, federationScope?: string, displayName?: string): Promise<unknown> {
    return this.request('POST', '/api/v2/gossip/peers', undefined, {
      endpoint, fingerprint, peer_type: peerType, federation_scope: federationScope, display_name: displayName,
    });
  }

  async removePeer(endpoint: string): Promise<unknown> {
    return this.request('DELETE', '/api/v2/gossip/peers', undefined, { endpoint });
  }

  // ── Static factory ──────────────────────────────────────────────────────

  /**
   * Build a client from ~/.airchat/config and ~/.airchat/machine.key.
   * Agent name is derived as: `{machine_name}-{directory_name}`.
   */
  static fromConfig(overrides?: Partial<RestClientConfig>): AirChatRestClient {
    const airchatDir = path.join(os.homedir(), '.airchat');

    // Read config file
    const configPath = path.join(airchatDir, 'config');
    if (!fs.existsSync(configPath)) {
      throw new Error(
        `AirChat config not found at ${configPath}. Run "npx airchat" to set up.`,
      );
    }
    const configText = fs.readFileSync(configPath, 'utf-8');
    const configVars = parseConfigFile(configText);

    const machineName =
      overrides?.machineName ?? configVars.MACHINE_NAME;
    const webUrl =
      overrides?.webUrl ?? configVars.AIRCHAT_WEB_URL;

    if (!machineName) {
      throw new Error('MACHINE_NAME not found in ~/.airchat/config');
    }
    if (!webUrl) {
      throw new Error('AIRCHAT_WEB_URL not found in ~/.airchat/config');
    }

    // Read private key
    const keyPath = path.join(airchatDir, 'machine.key');
    if (!fs.existsSync(keyPath)) {
      throw new Error(
        `Machine private key not found at ${keyPath}. Run "npx airchat" to set up.`,
      );
    }
    const privateKeyHex =
      overrides?.privateKeyHex ?? fs.readFileSync(keyPath, 'utf-8').trim();

    // Derive agent name from machine name + cwd directory name
    const dirName = path.basename(process.cwd());
    const agentName = overrides?.agentName ?? `${machineName}-${dirName}`;

    return new AirChatRestClient({
      webUrl,
      machineName,
      privateKeyHex,
      agentName,
      cacheDir: overrides?.cacheDir,
    });
  }

  // ── Internal: HTTP request with auth ────────────────────────────────────

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    pathname: string,
    params?: URLSearchParams,
    body?: unknown,
  ): Promise<unknown> {
    await this.ensureRegistered();

    const result = await this.doFetch(method, pathname, params, body);

    // On 401, re-register and retry once (derived key may have been invalidated)
    if (result.status === 401) {
      this.derivedKey = null;
      await this.register();
      const retry = await this.doFetch(method, pathname, params, body);
      if (!retry.ok) {
        const text = await retry.text().catch(() => '');
        throw new Error(
          `AirChat API ${method} ${pathname} failed after re-registration: ` +
          `HTTP ${retry.status} — ${text}`,
        );
      }
      return retry.json();
    }

    if (!result.ok) {
      const text = await result.text().catch(() => '');
      throw new Error(
        `AirChat API ${method} ${pathname} failed: HTTP ${result.status} — ${text}`,
      );
    }

    return result.json();
  }

  private async doFetch(
    method: 'GET' | 'POST' | 'DELETE',
    pathname: string,
    params?: URLSearchParams,
    body?: unknown,
  ): Promise<Response> {
    let url = `${this.webUrl}${pathname}`;
    if (params && params.toString()) {
      url += `?${params.toString()}`;
    }

    const headers: Record<string, string> = {
      'x-agent-api-key': this.derivedKey!,
    };

    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(30000) };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    return fetch(url, init);
  }

  // ── Internal: registration ──────────────────────────────────────────────

  private async ensureRegistered(): Promise<void> {
    if (this.derivedKey) return;

    // Avoid concurrent registrations
    if (this.registering) {
      await this.registering;
      return;
    }

    this.registering = this.register();
    try {
      await this.registering;
    } finally {
      this.registering = null;
    }
  }

  private async register(): Promise<void> {
    // Try loading cached derived key from disk
    const cachedKey = this.loadCachedKey();
    if (cachedKey) {
      this.derivedKey = cachedKey;
      return;
    }

    // Generate a new derived key
    const derivedKey = generateDerivedKey();
    const derivedKeyHash = hashKey(derivedKey);
    const timestamp = new Date().toISOString();
    const nonce = generateNonce();

    const payload = {
      machine_name: this.machineName,
      agent_name: this.agentName,
      derived_key_hash: derivedKeyHash,
      timestamp,
      nonce,
    };

    const signature = signRegistration(this.privateKeyHex, payload);

    const url = `${this.webUrl}/api/v2/register`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, signature }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 409) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Registration failed: agent "${this.agentName}" is owned by a different machine. ` +
        `HTTP 409 — ${body}`,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Registration failed: HTTP ${res.status} — ${body}`,
      );
    }

    // Cache the derived key to disk
    this.saveCachedKey(derivedKey);
    this.derivedKey = derivedKey;
  }

  // ── Internal: derived key cache ─────────────────────────────────────────

  private get keyFilePath(): string {
    return path.join(this.cacheDir, `${this.agentName}.key`);
  }

  private loadCachedKey(): string | null {
    try {
      if (!fs.existsSync(this.keyFilePath)) return null;
      const key = fs.readFileSync(this.keyFilePath, 'utf-8').trim();
      if (!key) return null;
      if (!key.match(/^[0-9a-f]{64}$/)) return null;
      return key;
    } catch {
      return null;
    }
  }

  private saveCachedKey(key: string): void {
    // Ensure cache directory exists (mkdir -p)
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    // Write key file with restricted permissions
    fs.writeFileSync(this.keyFilePath, key, { mode: 0o600 });
  }

  // ── Internal: permission checks ─────────────────────────────────────────

  private checkPermissions(): void {
    const filesToCheck = [
      path.join(os.homedir(), '.airchat', 'machine.key'),
      this.keyFilePath,
    ];

    for (const filePath of filesToCheck) {
      try {
        const stats = fs.statSync(filePath);
        // Check if group or other bits are set (anything beyond owner rw)
        const mode = stats.mode & 0o777;
        if (mode & 0o077) {
          process.stderr.write(
            `WARNING: Permissions ${mode.toString(8).padStart(4, '0')} ` +
            `for '${filePath}' are too open.\n` +
            `It is required that your key files are NOT accessible by others.\n`,
          );
        }
      } catch {
        // File does not exist yet or is inaccessible — skip
      }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseConfigFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    vars[key] = value;
  }
  return vars;
}

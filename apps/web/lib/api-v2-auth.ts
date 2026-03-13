// TODO [post-launch]: The migration (00008) defines scoped Postgres roles
// (airchat_agent_api for messaging, airchat_registrar for registration) but
// this module only uses the service role. Production multi-tenant deployments
// should use role-specific clients to enforce least-privilege at the database
// layer. This requires either Supabase role-switching support (SET ROLE) or
// separate connection strings per role. The single service role is acceptable
// for single-instance self-hosted deployments.

import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { hashKey } from '@airchat/shared/crypto';
import {
  SupabaseStorageAdapter,
} from '@airchat/shared';
import type { AgentContext, StorageAdapter } from '@airchat/shared';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

// ── Supabase client singleton (service role) ────────────────────────────────

let _supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (_supabaseClient) return _supabaseClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables'
    );
  }

  _supabaseClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabaseClient;
}

// ── Storage adapter singleton ───────────────────────────────────────────────

let _storageAdapter: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
  if (_storageAdapter) return _storageAdapter;
  _storageAdapter = new SupabaseStorageAdapter(getSupabaseClient());
  return _storageAdapter;
}

// ── V2 Auth Middleware ──────────────────────────────────────────────────────

/**
 * Authenticate a v2 API request using the derived key auth model.
 *
 * Reads `x-agent-api-key` header (the derived key), computes SHA256(derived_key),
 * looks up the hash in agents.derived_key_hash via StorageAdapter.
 *
 * Returns AgentContext on success, or a NextResponse error on failure.
 */
export async function authenticateAgent(
  request: NextRequest
): Promise<AgentContext | NextResponse> {
  const derivedKey = request.headers.get('x-agent-api-key');

  if (!derivedKey) {
    return NextResponse.json(
      { error: 'Missing x-agent-api-key header' },
      { status: 401 }
    );
  }

  const keyHash = hashKey(derivedKey);
  const adapter = getStorageAdapter();

  const agent = await adapter.findAgentByDerivedKeyHash(keyHash);
  if (!agent) {
    return NextResponse.json(
      { error: 'Invalid API key' },
      { status: 401 }
    );
  }

  const ctx: AgentContext = {
    agentId: agent.id,
    agentName: agent.name,
    machineId: agent.machine_id ?? '',
  };

  return ctx;
}

/**
 * Type guard to check if the auth result is an error response.
 */
export function isAuthError(
  result: AgentContext | NextResponse
): result is NextResponse {
  return result instanceof NextResponse;
}

/**
 * Check per-agent rate limit. Returns null if allowed, or an error NextResponse if exceeded.
 */
export function checkAgentRateLimit(
  agentId: string,
  operation: 'read' | 'write'
): NextResponse | null {
  const limit = operation === 'write' ? RATE_LIMITS.write : RATE_LIMITS.read;
  const result = checkRateLimit(agentId, limit.windowMs, limit.maxRequests);
  if (!result.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((result.retryAfterMs || 1000) / 1000)),
        },
      }
    );
  }
  return null;
}

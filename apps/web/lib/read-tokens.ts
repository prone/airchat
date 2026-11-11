/**
 * Read tokens: credentials for a dashboard that is not an agent.
 *
 * See supabase/migrations/00033_read_tokens.sql for what a token may do. This
 * module issues, lists, revokes and looks them up; authenticateAgent in
 * api-v2-auth.ts decides which requests one is accepted for.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export const READ_TOKEN_HEADER = 'x-airchat-read-token';
export const READ_TOKEN_PREFIX = 'airchat_ro_';
const TOKEN_RE = /^airchat_ro_[A-Za-z0-9_-]{43}$/;

export interface ReadTokenRow {
  id: string;
  name: string;
  include_dms: boolean;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

const PUBLIC_COLUMNS = 'id, name, include_dms, revoked_at, last_used_at, created_at';

export function hashReadToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** True when the text has the shape of a read token (says nothing about validity). */
export function looksLikeReadToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/**
 * Create a token. The plaintext is returned here and nowhere else: only its
 * hash is stored, so it cannot be shown again.
 */
export async function issueReadToken(
  client: SupabaseClient,
  input: { name: string; includeDms: boolean },
): Promise<{ token: string; row: ReadTokenRow }> {
  const token = READ_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const { data, error } = await client
    .from('read_tokens')
    .insert({ name: input.name, include_dms: input.includeDms, token_hash: hashReadToken(token) })
    .select(PUBLIC_COLUMNS)
    .single();
  if (error || !data) throw new Error(`Failed to issue read token: ${error?.message ?? 'no row returned'}`);
  return { token, row: data as ReadTokenRow };
}

export async function listReadTokens(client: SupabaseClient): Promise<ReadTokenRow[]> {
  const { data, error } = await client
    .from('read_tokens')
    .select(PUBLIC_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to list read tokens: ${error.message}`);
  return (data ?? []) as ReadTokenRow[];
}

/** Revoke a live token. Returns false when there is no live token with that id. */
export async function revokeReadToken(client: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await client
    .from('read_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .is('revoked_at', null)
    .select('id');
  if (error) throw new Error(`Failed to revoke read token: ${error.message}`);
  return (data ?? []).length > 0;
}

/** The live token this plaintext belongs to, or null. A database error throws. */
export async function findLiveReadToken(
  client: SupabaseClient,
  token: string,
): Promise<ReadTokenRow | null> {
  if (!looksLikeReadToken(token)) return null;
  const { data, error } = await client
    .from('read_tokens')
    .select(PUBLIC_COLUMNS)
    .eq('token_hash', hashReadToken(token))
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw new Error(`Read token lookup failed: ${error.message}`);
  return (data as ReadTokenRow | null) ?? null;
}

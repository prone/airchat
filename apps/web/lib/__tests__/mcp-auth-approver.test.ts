import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * A connector token issued through OAuth consent stands for the admin who
 * approved it. When that person stops being an admin, the access token they
 * already hold must stop working, not only the refresh.
 */

const findConnectorTokenByHash = vi.fn();
const adminLookup = vi.fn();

vi.mock('@/lib/api-v2-auth', () => ({
  getStorageAdapter: () => ({ findConnectorTokenByHash, touchConnectorToken: async () => {} }),
  getSupabaseClient: () => ({
    from: (table: string) => table === 'admin_users'
      ? { select: () => ({ eq: () => ({ maybeSingle: adminLookup }) }) }
      : { select: () => ({ eq: () => ({ eq: () => ({
          single: async () => ({ data: { id: 'agent-1', name: 'duncan-claude-ai', machine_id: null }, error: null }),
        }) }) }) },
  }),
}));

const { authenticateConnector, isConnectorAuthError, clearAdminChecks, clearConnectorTokenTouches } =
  await import('@/lib/mcp-auth');

let n = 0;
/** A fresh token each call, so the per-token rate limit never interferes. */
const call = () => authenticateConnector(new NextRequest('http://mcp.internal/api/mcp', {
  method: 'POST',
  headers: { authorization: `Bearer acx_${String(++n).padStart(64, '0')}` },
}));

const token = (grantedBy: string | null) => ({
  id: 'tok-1', agent_id: 'agent-1', scope: 'read', audience: null, granted_by_user_id: grantedBy,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearAdminChecks();
  clearConnectorTokenTouches();
  adminLookup.mockResolvedValue({ data: { user_id: 'user-1' }, error: null });
});
afterEach(() => vi.useRealTimers());

describe('the approving admin is checked when a connector token is used', () => {
  it('accepts a token whose approver is an admin', async () => {
    findConnectorTokenByHash.mockResolvedValue(token('user-1'));
    expect(isConnectorAuthError(await call())).toBe(false);
  });

  it('refuses a token whose approver is no longer an admin', async () => {
    findConnectorTokenByHash.mockResolvedValue(token('user-1'));
    adminLookup.mockResolvedValue({ data: null, error: null });
    const result = await call();
    expect(isConnectorAuthError(result)).toBe(true);
    expect((result as Response).status).toBe(401);
  });

  it('does not look the approver up for a token issued without one', async () => {
    findConnectorTokenByHash.mockResolvedValue(token(null));
    expect(isConnectorAuthError(await call())).toBe(false);
    expect(adminLookup).not.toHaveBeenCalled();
  });

  it('asks once a minute, not once a request', async () => {
    vi.useFakeTimers();
    findConnectorTokenByHash.mockResolvedValue(token('user-1'));
    await call(); await call(); await call();
    expect(adminLookup).toHaveBeenCalledTimes(1);

    adminLookup.mockResolvedValue({ data: null, error: null });
    vi.advanceTimersByTime(61_000);
    expect(isConnectorAuthError(await call())).toBe(true);
  });

  it('keeps the last answer when the lookup fails', async () => {
    vi.useFakeTimers();
    findConnectorTokenByHash.mockResolvedValue(token('user-1'));
    adminLookup.mockResolvedValue({ data: null, error: null });
    expect(isConnectorAuthError(await call())).toBe(true);

    vi.advanceTimersByTime(61_000);
    adminLookup.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    expect(isConnectorAuthError(await call())).toBe(true);
  });
});

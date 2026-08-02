import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/**
 * `runAsAuthenticatedAgent` lets /api/mcp run the real v2 route handlers with an
 * already-verified identity, instead of reimplementing their logic. That makes
 * it the highest-blast-radius change in the connector work: if the scope leaked,
 * or if its absence stopped being enforced, every v2 route would be reachable
 * without a credential.
 *
 * These tests pin the three properties that make it safe.
 */

const findAgentByDerivedKeyHash = vi.fn();

vi.mock('@airchat/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SupabaseStorageAdapter: class {
    findAgentByDerivedKeyHash = findAgentByDerivedKeyHash;
  },
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

const { authenticateAgent, runAsAuthenticatedAgent, isAuthError } = await import('@/lib/api-v2-auth');

const CTX = { agentId: 'agent-1', agentName: 'connector-agent', machineId: 'machine-1' };

function req(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/v2/board', { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  findAgentByDerivedKeyHash.mockResolvedValue(null);
  // The header path builds a Supabase client lazily; the client itself is
  // mocked, but the env guard in front of it still runs.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
});

describe('runAsAuthenticatedAgent', () => {
  it('presents the injected context to authenticateAgent', async () => {
    const result = await runAsAuthenticatedAgent(CTX, () => authenticateAgent(req()));
    expect(isAuthError(result)).toBe(false);
    expect(result).toEqual(CTX);
  });

  it('does not consult the database when a context is injected', async () => {
    await runAsAuthenticatedAgent(CTX, () => authenticateAgent(req()));
    expect(findAgentByDerivedKeyHash).not.toHaveBeenCalled();
  });

  // The property that keeps the endpoint closed. If this regresses, an
  // unauthenticated HTTP request reaches every v2 route.
  it('still requires a header OUTSIDE the scope', async () => {
    const result = await authenticateAgent(req());
    expect(isAuthError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(401);
  });

  it('does not leak into work started after the scope exits', async () => {
    await runAsAuthenticatedAgent(CTX, async () => authenticateAgent(req()));
    const after = await authenticateAgent(req());
    expect(isAuthError(after)).toBe(true);
  });

  it('does not leak into a concurrently running request', async () => {
    // Interleave an in-scope call with an out-of-scope one. AsyncLocalStorage is
    // per-async-context, so the bare call must not observe the injected store.
    let releaseOutside: () => void = () => {};
    const outsideStarted = new Promise<void>((resolve) => { releaseOutside = resolve; });

    const inside = runAsAuthenticatedAgent(CTX, async () => {
      releaseOutside();
      await new Promise((r) => setTimeout(r, 5));
      return authenticateAgent(req());
    });

    await outsideStarted;
    const outside = await authenticateAgent(req());

    expect(await inside).toEqual(CTX);
    expect(isAuthError(outside)).toBe(true);
  });

  it('isolates two different injected contexts running concurrently', async () => {
    const other = { agentId: 'agent-2', agentName: 'other', machineId: 'machine-2' };
    const [a, b] = await Promise.all([
      runAsAuthenticatedAgent(CTX, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return authenticateAgent(req());
      }),
      runAsAuthenticatedAgent(other, () => authenticateAgent(req())),
    ]);
    expect(a).toEqual(CTX);
    expect(b).toEqual(other);
  });

  it('does not let a caller forge a context via request headers', async () => {
    // A remote caller controls headers, not the async scope. Nothing header-shaped
    // should be able to stand in for the injected context.
    const forged = req({
      'x-agent-id': 'agent-1',
      'x-agent-context': JSON.stringify(CTX),
      'x-agent-api-key': 'not-a-real-key',
    });
    const result = await authenticateAgent(forged);
    expect(isAuthError(result)).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * RFC 8707 audience validation.
 *
 * The MCP spec states three separate times that a server must reject a token
 * not issued for it, and names the failure as the confused-deputy class: a
 * server that accepts tokens minted for another resource lets an attacker
 * replay a legitimate token across services.
 *
 * These drive the real authenticateConnector against a mocked store.
 */

const findConnectorTokenByHash = vi.fn();
const touchConnectorToken = vi.fn().mockResolvedValue(undefined);
const agentSingle = vi.fn();

vi.mock('@/lib/api-v2-auth', () => ({
  getStorageAdapter: () => ({ findConnectorTokenByHash, touchConnectorToken }),
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ single: agentSingle }) }) }),
    }),
  }),
}));

const { authenticateConnector, isConnectorAuthError } = await import('@/lib/mcp-auth');

const TOKEN = 'acx_' + 'a'.repeat(64);
const THIS_SERVER = 'https://mcp.airchat.work/mcp';

function req(host = 'https://mcp.airchat.work') {
  return new NextRequest(`${host}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

const tokenRow = (audience: string | null) => ({
  id: 'tok-1',
  agent_id: 'agent-1',
  scope: 'read',
  audience,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AIRCHAT_PUBLIC_URL', 'https://mcp.airchat.work');
  agentSingle.mockResolvedValue({
    data: { id: 'agent-1', name: 'duncan-claude-ai', machine_id: null },
    error: null,
  });
});

describe('audience validation', () => {
  it('accepts a token minted for this server', async () => {
    findConnectorTokenByHash.mockResolvedValue(tokenRow(THIS_SERVER));
    const result = await authenticateConnector(req());
    expect(isConnectorAuthError(result)).toBe(false);
  });

  it('rejects a token minted for a different server', async () => {
    findConnectorTokenByHash.mockResolvedValue(tokenRow('https://someone-else.example/mcp'));
    const result = await authenticateConnector(req());
    expect(isConnectorAuthError(result)).toBe(true);
    expect((result as Response).status).toBe(401);
  });

  it('rejects a token for the same host but a different path', async () => {
    findConnectorTokenByHash.mockResolvedValue(tokenRow('https://mcp.airchat.work/api/v2'));
    expect(isConnectorAuthError(await authenticateConnector(req()))).toBe(true);
  });

  it('rejects a token whose audience differs only by a trailing slash', async () => {
    // Comparison is exact. A canonical URI has no trailing slash, so this is a
    // token that was minted against a different canonicalisation.
    findConnectorTokenByHash.mockResolvedValue(tokenRow(THIS_SERVER + '/'));
    expect(isConnectorAuthError(await authenticateConnector(req()))).toBe(true);
  });

  it('rejects a lookalike host', async () => {
    findConnectorTokenByHash.mockResolvedValue(
      tokenRow('https://mcp.airchat.work.evil.com/mcp'),
    );
    expect(isConnectorAuthError(await authenticateConnector(req()))).toBe(true);
  });

  it('gives the same answer as an unknown token, revealing nothing', async () => {
    // Saying "valid, but not for here" confirms the token is real.
    findConnectorTokenByHash.mockResolvedValue(tokenRow('https://elsewhere.example/mcp'));
    const wrongAudience = (await authenticateConnector(req())) as Response;

    findConnectorTokenByHash.mockResolvedValue(null);
    const unknown = (await authenticateConnector(req())) as Response;

    expect(wrongAudience.status).toBe(unknown.status);
    expect(await wrongAudience.json()).toEqual(await unknown.json());
  });

  it('does not stamp last-used for a rejected audience', async () => {
    findConnectorTokenByHash.mockResolvedValue(tokenRow('https://elsewhere.example/mcp'));
    await authenticateConnector(req());
    expect(touchConnectorToken).not.toHaveBeenCalled();
  });
});

describe('CLI-issued tokens (null audience)', () => {
  it('are accepted, because their binding is structural', async () => {
    // Nothing outside /api/mcp reads connector_tokens, so a CLI token is not a
    // credential anywhere else. Requiring an explicit audience would break
    // every token issued before OAuth existed.
    findConnectorTokenByHash.mockResolvedValue(tokenRow(null));
    expect(isConnectorAuthError(await authenticateConnector(req()))).toBe(false);
  });

  it('are accepted when the column is absent entirely', async () => {
    findConnectorTokenByHash.mockResolvedValue({ id: 't', agent_id: 'agent-1', scope: 'read' });
    expect(isConnectorAuthError(await authenticateConnector(req()))).toBe(false);
  });
});

describe('audience is compared against the configured origin, not the request', () => {
  it('rejects a token matching an attacker-supplied Host', async () => {
    // AIRCHAT_PUBLIC_URL is the configured identity. If the comparison used the
    // request's own origin, a caller could present a token minted for their
    // host and have it accepted by asking for that host.
    findConnectorTokenByHash.mockResolvedValue(tokenRow('https://attacker.example/mcp'));
    const result = await authenticateConnector(req('https://attacker.example'));
    expect(isConnectorAuthError(result)).toBe(true);
  });

  it('accepts the configured identity even when reached over another host', async () => {
    // Reaching the server through a tunnel hostname must not invalidate a
    // correctly-minted token.
    findConnectorTokenByHash.mockResolvedValue(tokenRow(THIS_SERVER));
    const result = await authenticateConnector(req('https://tunnel.trycloudflare.com'));
    expect(isConnectorAuthError(result)).toBe(false);
  });
});

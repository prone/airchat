import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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

const { authenticateConnector, extractBearerToken, isConnectorAuthError } = await import('@/lib/mcp-auth');

function req(headers: Record<string, string> = {}) {
  return new NextRequest('http://mcp.internal/api/mcp', { method: 'POST', headers });
}

/** SHA256 of 'acx_token' — the value the mock is keyed on. */
const VALID_TOKEN = 'acx_' + 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  findConnectorTokenByHash.mockResolvedValue(null);
  agentSingle.mockResolvedValue({ data: null, error: null });
});

describe('extractBearerToken', () => {
  it('reads a well-formed bearer header', () => {
    expect(extractBearerToken(req({ authorization: 'Bearer abc123' }))).toBe('abc123');
  });

  it('accepts lowercase and mixed-case schemes (RFC 7235 is case-insensitive)', () => {
    expect(extractBearerToken(req({ authorization: 'bearer abc' }))).toBe('abc');
    expect(extractBearerToken(req({ authorization: 'BeArEr abc' }))).toBe('abc');
  });

  it('tolerates extra whitespace around the token', () => {
    expect(extractBearerToken(req({ authorization: '  Bearer   abc  ' }))).toBe('abc');
  });

  it('returns null when the header is absent, empty or another scheme', () => {
    expect(extractBearerToken(req())).toBeNull();
    expect(extractBearerToken(req({ authorization: 'Bearer' }))).toBeNull();
    expect(extractBearerToken(req({ authorization: 'Bearer   ' }))).toBeNull();
    expect(extractBearerToken(req({ authorization: 'Basic abc' }))).toBeNull();
  });

  it('does not treat a token containing spaces as two tokens', () => {
    // Not a valid token, but it must not be silently truncated to "a".
    expect(extractBearerToken(req({ authorization: 'Bearer a b' }))).toBe('a b');
  });
});

/**
 * The single most important property of this endpoint.
 *
 * MCP clients run OAuth discovery before sending custom headers. A
 * `WWW-Authenticate` header on the 401 makes the client enter the OAuth flow
 * and never send `Authorization` at all — which is precisely how Cloudflare's
 * own MCP server ended up never seeing its direct API token
 * (cloudflare/mcp#95). If this test fails, the connector breaks silently.
 */
describe('401s must never advertise an auth scheme', () => {
  it('omits WWW-Authenticate when the token is missing', async () => {
    const result = await authenticateConnector(req());
    expect(isConnectorAuthError(result)).toBe(true);
    const response = result as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('omits WWW-Authenticate when the token is invalid', async () => {
    const result = await authenticateConnector(req({ authorization: `Bearer ${VALID_TOKEN}` }));
    const response = result as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('sends no Link or resource-metadata header either', async () => {
    const response = (await authenticateConnector(req())) as Response;
    // RFC 9728 discovery can also be advertised via a Link header.
    expect(response.headers.get('link')).toBeNull();
    expect(response.headers.get('oauth-protected-resource')).toBeNull();
  });
});

/**
 * A per-token limit alone gives every rotated bearer value a fresh bucket, so a
 * flood of random tokens would never be throttled and each attempt would still
 * cost a database lookup. This is the endpoint we intend to expose publicly, so
 * the IP limit has to come first and has to apply before any DB work.
 */
describe('rate limiting', () => {
  it('applies the IP limit before touching the database', async () => {
    const ip = '203.0.113.10';
    const headers = { 'x-forwarded-for': ip, authorization: `Bearer ${VALID_TOKEN}` };

    // IP_RATE_LIMIT is 120/min. Rotate the token every time so the per-token
    // bucket never fills — only the IP limit can stop this.
    let throttled = 0;
    for (let i = 0; i < 130; i++) {
      const result = await authenticateConnector(
        req({ ...headers, authorization: `Bearer acx_${String(i).padStart(64, '0')}` }),
      );
      if ((result as Response).status === 429) throttled++;
    }

    expect(throttled).toBeGreaterThan(0);
    // Once throttled, no further lookups are issued for the blocked requests.
    expect(findConnectorTokenByHash.mock.calls.length).toBeLessThan(130);
  });

  it('sets Retry-After on a 429', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.11' };
    let response: Response | undefined;
    for (let i = 0; i < 130; i++) {
      const r = await authenticateConnector(
        req({ ...headers, authorization: `Bearer acx_${String(i).padStart(64, '1')}` }),
      );
      if ((r as Response).status === 429) { response = r as Response; break; }
    }
    expect(response).toBeDefined();
    expect(Number(response!.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('throttles a missing-token flood too, not just a bad-token one', async () => {
    // A request with no Authorization at all must still be counted, otherwise
    // the cheapest possible flood is the one that bypasses the limiter.
    const headers = { 'x-forwarded-for': '203.0.113.12' };
    let throttled = 0;
    for (let i = 0; i < 130; i++) {
      const r = await authenticateConnector(req(headers));
      if ((r as Response).status === 429) throttled++;
    }
    expect(throttled).toBeGreaterThan(0);
  });

  it('does not let one IP exhaust another IP\'s budget', async () => {
    for (let i = 0; i < 130; i++) {
      await authenticateConnector(req({ 'x-forwarded-for': '203.0.113.20' }));
    }
    // The flooding IP must actually be blocked, or this asserts nothing.
    const flooder = await authenticateConnector(req({ 'x-forwarded-for': '203.0.113.20' }));
    expect((flooder as Response).status).toBe(429);

    // A different IP is unaffected — rejected on merit (401), not throttled.
    const other = await authenticateConnector(req({ 'x-forwarded-for': '203.0.113.21' }));
    expect((other as Response).status).toBe(401);
  });

  it('reads the client IP from x-real-ip when x-forwarded-for is absent', async () => {
    let throttled = 0;
    for (let i = 0; i < 130; i++) {
      const r = await authenticateConnector(req({ 'x-real-ip': '203.0.113.30' }));
      if ((r as Response).status === 429) throttled++;
    }
    expect(throttled).toBeGreaterThan(0);
  });
});

describe('authenticateConnector', () => {
  it('rejects a revoked or expired token indistinguishably from an unknown one', async () => {
    // The adapter filters revoked/expired in SQL and returns null for all three.
    findConnectorTokenByHash.mockResolvedValue(null);
    const a = (await authenticateConnector(req({ authorization: 'Bearer acx_unknown' }))) as Response;
    const b = (await authenticateConnector(req({ authorization: `Bearer ${VALID_TOKEN}` }))) as Response;
    expect(await a.json()).toEqual(await b.json());
    expect(a.status).toBe(b.status);
  });

  it('resolves a valid token to its agent context', async () => {
    findConnectorTokenByHash.mockResolvedValue({ id: 'tok-1', agent_id: 'agent-1' });
    agentSingle.mockResolvedValue({
      data: { id: 'agent-1', name: 'macbook-claude', machine_id: 'machine-1' },
      error: null,
    });

    const result = await authenticateConnector(req({ authorization: `Bearer ${VALID_TOKEN}` }));
    expect(isConnectorAuthError(result)).toBe(false);
    expect(result).toMatchObject({
      tokenId: 'tok-1',
      ctx: { agentId: 'agent-1', agentName: 'macbook-claude', machineId: 'machine-1' },
    });
  });

  it('looks the token up by hash, never by plaintext', async () => {
    await authenticateConnector(req({ authorization: `Bearer ${VALID_TOKEN}` }));
    const [lookedUp] = findConnectorTokenByHash.mock.calls[0];
    expect(lookedUp).not.toContain(VALID_TOKEN);
    expect(lookedUp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a token whose agent is inactive or missing', async () => {
    findConnectorTokenByHash.mockResolvedValue({ id: 'tok-1', agent_id: 'agent-gone' });
    agentSingle.mockResolvedValue({ data: null, error: null });
    const response = (await authenticateConnector(req({ authorization: `Bearer ${VALID_TOKEN}` }))) as Response;
    expect(response.status).toBe(401);
  });

  it('stamps last-used on success', async () => {
    findConnectorTokenByHash.mockResolvedValue({ id: 'tok-1', agent_id: 'agent-1' });
    agentSingle.mockResolvedValue({
      data: { id: 'agent-1', name: 'a', machine_id: null },
      error: null,
    });
    await authenticateConnector(req({ authorization: `Bearer ${VALID_TOKEN}` }));
    expect(touchConnectorToken).toHaveBeenCalledWith('tok-1');
  });

  it('tolerates an agent with no machine', async () => {
    findConnectorTokenByHash.mockResolvedValue({ id: 'tok-1', agent_id: 'agent-1' });
    agentSingle.mockResolvedValue({
      data: { id: 'agent-1', name: 'a', machine_id: null },
      error: null,
    });
    const result = await authenticateConnector(req({ authorization: `Bearer ${VALID_TOKEN}` }));
    expect((result as { ctx: { machineId: string } }).ctx.machineId).toBe('');
  });
});

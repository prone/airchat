import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { MCP_CONNECTOR_V1_TOOLS, ALL_TOOL_NAMES } from '@airchat/mcp-server/server-factory';

/**
 * Drives the real /api/mcp handler with real JSON-RPC over the real Streamable
 * HTTP transport. Auth and the storage-backed client are mocked so this test is
 * about the endpoint contract: what it advertises, what it refuses, and what it
 * dispatches.
 */

const CTX = { agentId: 'agent-1', agentName: 'connector-agent', machineId: 'machine-1' };

const authResult: { value: unknown } = { value: { ctx: CTX, tokenId: 'tok-1' } };

vi.mock('@/lib/mcp-auth', () => ({
  authenticateConnector: vi.fn(async () => authResult.value),
  isConnectorAuthError: (r: unknown) => r instanceof NextResponse,
}));

const checkBoard = vi.fn(async () => ({ channels: [{ channel: 'general', unread: 2 }] }));
const readNote = vi.fn(async () => ({ note: { slug: 'runbook', body_md: '# Runbook' } }));
const sendMessage = vi.fn(async () => ({ message: { id: 'msg-1' } }));

vi.mock('@/lib/mcp-inprocess-client', () => ({
  InProcessToolClient: class {
    checkBoard = checkBoard;
    readNote = readNote;
    sendMessage = sendMessage;
  },
}));

const { POST, GET, DELETE } = await import('@/app/api/mcp/route');

let nextId = 1;

/** Post one JSON-RPC request and return { status, headers, body }. */
async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
  const request = new NextRequest('http://mcp.internal/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer acx_test',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: params ?? {} }),
  });

  const response = await POST(request);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

const INIT_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test-connector', version: '0.0.0' },
};

beforeEach(() => {
  vi.clearAllMocks();
  authResult.value = { ctx: CTX, tokenId: 'tok-1' };
});

describe('/api/mcp — protocol', () => {
  it('completes an initialize handshake', async () => {
    const { status, body } = await rpc('initialize', INIT_PARAMS);
    expect(status).toBe(200);
    expect(body.result.serverInfo.name).toBe('airchat');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('returns a plain JSON body, not an SSE stream', async () => {
    const { headers } = await rpc('initialize', INIT_PARAMS);
    expect(headers.get('content-type')).toContain('application/json');
    expect(headers.get('content-type')).not.toContain('text/event-stream');
  });

  it('is stateless — no session id is issued', async () => {
    const { headers } = await rpc('initialize', INIT_PARAMS);
    expect(headers.get('mcp-session-id')).toBeNull();
  });
});

describe('/api/mcp — tool surface', () => {
  it('advertises exactly the v1 connector tools', async () => {
    await rpc('initialize', INIT_PARAMS);
    const { body } = await rpc('tools/list');
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([...MCP_CONNECTOR_V1_TOOLS].sort());
  });

  it('withholds the tools that are not in v1', async () => {
    await rpc('initialize', INIT_PARAMS);
    const { body } = await rpc('tools/list');
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    for (const withheld of ['upload_file', 'download_file', 'get_file_url',
                            'promote_thread_to_note']) {
      expect(names).not.toContain(withheld);
    }
  });

  it('includes the messaging round trip the connector exists for', async () => {
    // Ask an agent a question, and be able to read the answer. An earlier
    // revision shipped send_message alone, which could ask but never hear back.
    await rpc('initialize', INIT_PARAMS);
    const { body } = await rpc('tools/list');
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    for (const needed of ['send_direct_message', 'check_mentions', 'mark_mentions_read']) {
      expect(names).toContain(needed);
    }
  });

  it('withholds airchat_doctor, which would leak host config', async () => {
    await rpc('initialize', INIT_PARAMS);
    const { body } = await rpc('tools/list');
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain('airchat_doctor');
  });

  it('every v1 tool name is a real tool', () => {
    for (const name of MCP_CONNECTOR_V1_TOOLS) {
      expect(ALL_TOOL_NAMES).toContain(name);
    }
  });

  it('includes the two approved write tools', () => {
    expect(MCP_CONNECTOR_V1_TOOLS).toContain('send_message');
    expect(MCP_CONNECTOR_V1_TOOLS).toContain('write_note');
  });
});

describe('/api/mcp — dispatch', () => {
  it('routes a read tool through to the in-process client', async () => {
    await rpc('initialize', INIT_PARAMS);
    const { body } = await rpc('tools/call', { name: 'check_board', arguments: {} });
    expect(checkBoard).toHaveBeenCalledOnce();
    expect(body.result.content[0].text).toContain('general');
  });

  it('wraps returned message data in the injection-boundary marker', async () => {
    await rpc('initialize', INIT_PARAMS);
    const { body } = await rpc('tools/call', { name: 'check_board', arguments: {} });
    expect(body.result.content[0].text).toContain('[AIRCHAT DATA');
  });

  it('routes a write tool through to the in-process client', async () => {
    await rpc('initialize', INIT_PARAMS);
    await rpc('tools/call', {
      name: 'send_message',
      arguments: { channel: 'general', content: 'hello from the connector' },
    });
    // The 4th argument is the shared handler's cwd-derived metadata. The
    // in-process client strips `project` from it before it reaches the route —
    // see InProcessToolClient.sendMessage.
    expect(sendMessage).toHaveBeenCalledWith(
      'general',
      'hello from the connector',
      undefined,
      expect.anything(),
    );
  });
});

/**
 * The invariant that makes a static bearer viable at all. An MCP client runs
 * OAuth discovery before it sends custom headers; any advertisement here sends
 * it down the OAuth path and it never sends Authorization.
 * See cloudflare/mcp#95.
 */
describe('/api/mcp — must not advertise OAuth', () => {
  it('returns 401 with no WWW-Authenticate challenge', async () => {
    authResult.value = NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    const request = new NextRequest('http://mcp.internal/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS }),
    });
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(response.headers.get('link')).toBeNull();
  });

  it('does not run any tool when auth fails', async () => {
    authResult.value = NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    await rpc('tools/call', { name: 'check_board', arguments: {} });
    expect(checkBoard).not.toHaveBeenCalled();
  });
});

describe('/api/mcp — unsupported methods', () => {
  it('refuses GET (no server-initiated stream in stateless mode)', () => {
    const response = GET();
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('refuses DELETE (there is no session to terminate)', () => {
    const response = DELETE();
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

/**
 * unwrapEnvelope is the single place the v2 boundary envelope
 * ({ _airchat, _notice, data }) is stripped, and it is now shared by both
 * transports: AirChatRestClient.request() (HTTP) and the in-process client
 * behind the claude.ai connector (apps/web/lib/mcp-inprocess-client.ts).
 *
 * The mcp-server handlers guard on the unwrapped shape (`result?.messages`,
 * `result?.results`), so if the two transports ever disagree here, the
 * connector path silently skips truncation/reshaping and leaks raw envelopes.
 * These tests pin the semantics both depend on.
 */

import { describe, it, expect } from 'vitest';
import { unwrapEnvelope } from '../rest-client.js';

describe('unwrapEnvelope', () => {
  it('unwraps a v2 boundary envelope to its data payload', () => {
    const messages = [{ content: 'hi', created_at: '2026-08-14T00:00:00Z' }];
    const body = { _airchat: '2.0', _notice: 'stable', data: { messages } };
    expect(unwrapEnvelope(body)).toEqual({ messages });
  });

  it('unwraps even when data is null or falsy', () => {
    expect(unwrapEnvelope({ _airchat: '2.0', data: null })).toBeNull();
    expect(unwrapEnvelope({ _airchat: '2.0', data: 0 })).toBe(0);
  });

  it('passes non-enveloped objects through unchanged', () => {
    const body = { channels: [{ channel: 'general', unread: 2 }] };
    expect(unwrapEnvelope(body)).toBe(body);
  });

  it('requires both _airchat and data to treat a body as an envelope', () => {
    const noData = { _airchat: '2.0', channels: [] };
    const noMarker = { data: { channels: [] } };
    expect(unwrapEnvelope(noData)).toBe(noData);
    expect(unwrapEnvelope(noMarker)).toBe(noMarker);
  });

  it('passes primitives, arrays, and null through unchanged', () => {
    expect(unwrapEnvelope(null)).toBeNull();
    expect(unwrapEnvelope('ok')).toBe('ok');
    const arr = [1, 2, 3];
    expect(unwrapEnvelope(arr)).toBe(arr);
  });
});

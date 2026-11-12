import { describe, it, expect, vi } from 'vitest';
import { SupabaseStorageAdapter, isConversationError } from '../supabase-adapter.js';

/**
 * listAllConversations is for a read token issued with direct-message access
 * and for nobody else. The route decides who reaches it; this checks the
 * adapter refuses on its own, before asking the database anything.
 */
function open(ctx: Record<string, unknown>) {
  const rpc = vi.fn(async () => ({
    data: {
      total: 7,
      conversations: [{
        id: 'c-1', title: null, created_at: 't0', last_message_at: null, message_count: '3',
        participants: [{ agent_id: 'a', name: 'mac-a', joined_at: 't0' }], unread: 9, extra: 'x',
      }],
    },
    error: null,
  }));
  const client = { rpc, from: vi.fn(() => { throw new Error('no table read expected'); }) };
  const scoped = new SupabaseStorageAdapter(client as never)
    .forAgent({ agentId: 'id-1', agentName: 'n', machineId: '', ...ctx } as never);
  return { scoped, rpc };
}

describe('listAllConversations', () => {
  it.each([
    ['an agent', {}],
    ['an agent whose context claims DM access', { includeDirectMessages: true }],
    ['a read token without DM access', { readOnly: true }],
    ['a read token with DM access set to something other than true', { readOnly: true, includeDirectMessages: 'yes' }],
  ])('refuses %s as "not found" without a query', async (_name, ctx) => {
    const { scoped, rpc } = open(ctx);
    const error = await scoped.listAllConversations().catch((e) => e);
    expect(isConversationError(error) && error.code).toBe('not_found');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns the page for a read token with DM access, with named fields only', async () => {
    const { scoped, rpc } = open({ readOnly: true, includeDirectMessages: true });
    const page = await scoped.listAllConversations({ limit: 500, offset: -3 });
    expect(rpc).toHaveBeenCalledWith('conversation_directory', { p_limit: 100, p_offset: 0, p_include_test: false });
    expect(page).toEqual({
      total: 7, limit: 100, offset: 0,
      conversations: [{
        id: 'c-1', title: null, created_at: 't0', last_message_at: null, message_count: 3,
        participants: [{ agent_id: 'a', name: 'mac-a', joined_at: 't0' }],
      }],
    });
  });
});

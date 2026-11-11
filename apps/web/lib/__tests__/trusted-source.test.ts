import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `source` distinguishes human-authored content from agent-authored content on
 * the board. It is therefore assigned from the verified identity of the caller
 * and never read from a request body — /api/v2/messages strips it precisely so
 * an agent cannot claim to be a human.
 *
 * These tests pin who does and does not get marked.
 */

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@airchat/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SupabaseStorageAdapter: class {},
}));

const { runAsAuthenticatedAgent, resolveTrustedSource } = await import('@/lib/api-v2-auth');

const agent = (name: string) => ({ agentId: 'a1', agentName: name, machineId: 'm1' });

beforeEach(() => vi.clearAllMocks());

describe('resolveTrustedSource', () => {
  it('marks nothing for an ordinary agent', () => {
    expect(resolveTrustedSource(agent('macbook-agentchat'))).toBeUndefined();
  });

  it('marks the claude.ai connector, from the in-process scope', async () => {
    const source = await runAsAuthenticatedAgent(
      agent('macbook-agentchat'),
      async () => resolveTrustedSource(agent('macbook-agentchat')),
      'claude.ai',
    );
    expect(source).toBe('claude.ai');
  });

  it('marks the Slack bridge by the flag an admin set on its agent, not by its name', () => {
    expect(resolveTrustedSource({ ...agent('nas-slack-bridge'), trustedSource: 'slack' })).toBe('slack');
    expect(resolveTrustedSource({ ...agent('anything-at-all'), trustedSource: 'slack' })).toBe('slack');
  });

  it('does not mark an agent just because it is named like the bridge', () => {
    // Any machine can register an agent called "<x>-slack-bridge"; the name
    // used to be enough to have its posts shown as written by a person.
    expect(resolveTrustedSource(agent('nas-slack-bridge'))).toBeUndefined();
    expect(resolveTrustedSource(agent('evil-slack-bridge'))).toBeUndefined();
    expect(resolveTrustedSource(agent('slack-bridge-impostor'))).toBeUndefined();
  });

  it('does not let an agent name itself into the connector source', () => {
    expect(resolveTrustedSource(agent('claude.ai'))).toBeUndefined();
    expect(resolveTrustedSource(agent('macbook-claude.ai'))).toBeUndefined();
  });

  it('does not leak the scope source to work outside it', async () => {
    await runAsAuthenticatedAgent(
      agent('macbook-agentchat'),
      async () => resolveTrustedSource(agent('macbook-agentchat')),
      'claude.ai',
    );
    expect(resolveTrustedSource(agent('macbook-agentchat'))).toBeUndefined();
  });

  it('keeps two concurrent scopes separate', async () => {
    const [a, b] = await Promise.all([
      runAsAuthenticatedAgent(agent('one'), async () => {
        await new Promise((r) => setTimeout(r, 5));
        return resolveTrustedSource(agent('one'));
      }, 'claude.ai'),
      runAsAuthenticatedAgent(agent('two'), async () => resolveTrustedSource(agent('two'))),
    ]);
    expect(a).toBe('claude.ai');
    expect(b).toBeUndefined();
  });

  it('a scope with no source marks nothing', async () => {
    const source = await runAsAuthenticatedAgent(
      agent('macbook-agentchat'),
      async () => resolveTrustedSource(agent('macbook-agentchat')),
    );
    expect(source).toBeUndefined();
  });
});

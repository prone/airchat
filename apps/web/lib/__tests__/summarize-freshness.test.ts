import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Summary reuse.
 *
 * `summarize_channel` is in the connector's READ tool set, but generating a
 * summary writes a note and costs an Anthropic request. With no reuse, a
 * read-only token could drive one billable generation per call, up to the
 * 120/min rate limit — and several agents catching up on the same quiet channel
 * each paid for an identical answer.
 *
 * These drive the real summarizeChannel against a mocked database, asserting on
 * whether the model was called at all.
 */

const state: {
  note: Record<string, unknown> | null;
  newerMessages: number;
  messages: Array<Record<string, unknown>>;
} = { note: null, newerMessages: 0, messages: [] };

const createMessage = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: (...args: unknown[]) => {
        createMessage(...args);
        return Promise.resolve({
          content: [{ type: 'text', text: 'a freshly generated summary' }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'end_turn',
        });
      },
    };
  },
}));

const writeNote = vi.fn().mockResolvedValue({ slug: 'channel-summary' });

vi.mock('@/lib/api-v2-auth', () => ({
  getStorageAdapter: () => ({ forAgent: () => ({ writeNote }) }),
  getSupabaseClient: () => ({
    from(table: string) {
      if (table === 'channels') {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'ch-1', name: 'general' } }) }) }) };
      }
      if (table === 'notes') {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.note }) }) }) }) };
      }
      if (table === 'agents') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { id: 'sum-1', name: 'summarizer' }, error: null }),
              maybeSingle: async () => ({ data: { id: 'sum-1', name: 'summarizer' }, error: null }),
            }),
          }),
        };
      }
      if (table === 'messages') {
        return {
          select: (_c?: unknown, opts?: { head?: boolean }) => {
            if (opts?.head) {
              // The freshness probe: how many messages are newer than the note.
              return { eq: () => ({ eq: () => ({ gt: async () => ({ count: state.newerMessages }) }) }) };
            }
            return {
              eq: () => ({ eq: () => ({ gte: () => ({ order: () => ({ limit: async () => ({ data: state.messages }) }) }) }) }),
            };
          },
        };
      }
      return { insert: () => Promise.resolve({ error: null }) };
    },
  }),
}));

const { summarizeChannel } = await import('@/lib/summarize');

const storedNote = (overrides: Record<string, unknown> = {}) => ({
  slug: 'channel-summary',
  body_md: 'the stored summary',
  updated_at: '2026-08-07T00:00:00.000Z',
  properties: {
    kind: 'channel-summary',
    window_days: 7,
    message_count: 12,
    model: 'claude-opus-4-8',
    generated_at: '2026-08-07T00:00:00.000Z',
    ...overrides,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
  state.note = null;
  state.newerMessages = 0;
  state.messages = [
    { content: 'hello', created_at: '2026-08-07T01:00:00.000Z', agents: { name: 'a' }, author_display: null },
  ];
});

describe('an unchanged channel is not re-summarized', () => {
  it('returns the stored note without calling the model', async () => {
    state.note = storedNote();
    const result = await summarizeChannel('ch-1');
    expect(createMessage).not.toHaveBeenCalled();
    expect(result.body_md).toBe('the stored summary');
    expect(result.cached).toBe(true);
  });

  it('reports no token spend for a reused summary', async () => {
    state.note = storedNote();
    const result = await summarizeChannel('ch-1');
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
  });

  it('does not rewrite the note it just read', async () => {
    state.note = storedNote();
    await summarizeChannel('ch-1');
    expect(writeNote).not.toHaveBeenCalled();
  });

  it('stays free across repeated calls', async () => {
    // The actual abuse shape: the same read-only token asking over and over.
    state.note = storedNote();
    for (let i = 0; i < 10; i++) await summarizeChannel('ch-1');
    expect(createMessage).not.toHaveBeenCalled();
  });
});

describe('new activity makes a summary stale', () => {
  it('regenerates when a message arrived after the note was written', async () => {
    state.note = storedNote();
    state.newerMessages = 1;
    const result = await summarizeChannel('ch-1');
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(result.cached).toBeUndefined();
    expect(result.body_md).toBe('a freshly generated summary');
  });

  it('generates when no summary exists yet', async () => {
    state.note = null;
    await summarizeChannel('ch-1');
    expect(createMessage).toHaveBeenCalledTimes(1);
  });
});

describe('reuse requires the request to match what was stored', () => {
  it('regenerates for a different window, which covers different messages', async () => {
    state.note = storedNote({ window_days: 7 });
    await summarizeChannel('ch-1', { windowDays: 30 });
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it('does not serve an activity summary for a project request', async () => {
    state.note = storedNote({ kind: 'channel-summary', window_days: 90 });
    await summarizeChannel('ch-1', { kind: 'project', windowDays: 90 });
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it('regenerates when the note carries no generated_at to compare against', async () => {
    state.note = storedNote({ generated_at: undefined });
    await summarizeChannel('ch-1');
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it('honours force, for a caller that wants a rewrite anyway', async () => {
    state.note = storedNote();
    await summarizeChannel('ch-1', { force: true });
    expect(createMessage).toHaveBeenCalledTimes(1);
  });
});

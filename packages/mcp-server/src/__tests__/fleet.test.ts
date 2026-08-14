import { describe, expect, it, vi } from 'vitest';
import { fetchFleetInventories, getModelEndpoint, listModels, resolveModel, runModel } from '../fleet.js';
import type { AirChatToolClient } from '../client.js';

const INVENTORY_NOTES = {
  notes: [
    {
      slug: 'models-workstation',
      updated_at: '2026-08-14T00:00:00Z',
      properties: {
        type: 'model-inventory',
        machine: 'workstation',
        models: [
          { name: 'qwen2.5-coder:32b', capability: 'llm-qwen2-5-coder-32b', kind: 'llm', backend: 'ollama', location: 'local', endpoint: 'http://100.105.10.12:11434/v1', size_bytes: 19864223357 },
          { name: 'gemma4:12b', capability: 'llm-gemma4-12b', kind: 'llm', backend: 'ollama', location: 'local', endpoint: 'http://100.105.10.12:11434/v1' },
        ],
      },
    },
    {
      slug: 'models-nas',
      updated_at: '2026-08-13T00:00:00Z',
      properties: {
        type: 'model-inventory',
        machine: 'nas',
        models: [
          { name: 'anthropic/claude-sonnet-5', capability: 'llm-anthropic-claude-sonnet-5', kind: 'llm', backend: 'openrouter', location: 'remote', endpoint: 'https://openrouter.ai/api/v1' },
          // Fell off the machine's 20-tag agent card: advertised endpoint-only.
          { name: 'tinyllama:1.1b', capability: 'llm-tinyllama-1-1b', kind: 'llm', backend: 'ollama', location: 'local', endpoint: 'http://100.99.1.2:11434/v1', routable: false },
        ],
      },
    },
  ],
};

function mockClient(overrides: Partial<Record<string, any>> = {}): AirChatToolClient {
  return {
    queryNotes: vi.fn().mockResolvedValue(INVENTORY_NOTES),
    postTask: vi.fn().mockResolvedValue({ task: { id: 'task-1', status: 'open' } }),
    getTask: vi.fn().mockResolvedValue({ task: { id: 'task-1', status: 'done', result: 'output text' } }),
    ...overrides,
  } as unknown as AirChatToolClient;
}

describe('fetchFleetInventories', () => {
  it('maps inventory notes to machines and models', async () => {
    const inventories = await fetchFleetInventories(mockClient());
    expect(inventories).toHaveLength(2);
    expect(inventories[0].machine).toBe('workstation');
    expect(inventories[0].models).toHaveLength(2);
  });

  it('tolerates notes with missing properties', async () => {
    const client = mockClient({
      queryNotes: vi.fn().mockResolvedValue({ notes: [{ slug: 'models-bare', updated_at: 'x', properties: {} }] }),
    });
    const inventories = await fetchFleetInventories(client);
    expect(inventories[0].machine).toBe('bare');
    expect(inventories[0].models).toEqual([]);
  });
});

describe('resolveModel', () => {
  it('resolves by registry name, capability tag, and normalized name', async () => {
    const inventories = await fetchFleetInventories(mockClient());
    expect(resolveModel(inventories, 'qwen2.5-coder:32b')?.machine).toBe('workstation');
    expect(resolveModel(inventories, 'llm-gemma4-12b')?.entry.name).toBe('gemma4:12b');
    expect(resolveModel(inventories, 'QWEN2.5-CODER:32B')?.entry.name).toBe('qwen2.5-coder:32b');
    expect(resolveModel(inventories, 'unknown-model')).toBeNull();
  });
});

describe('listModels', () => {
  it('flattens machines into one model list', async () => {
    const result = await listModels(mockClient()) as any;
    expect(result.machines).toHaveLength(2);
    expect(result.models).toHaveLength(4);
    expect(result.models[2].machine).toBe('nas');
  });

  it('says so when no inventories exist', async () => {
    const result = await listModels(mockClient({ queryNotes: vi.fn().mockResolvedValue({ notes: [] }) })) as any;
    expect(result.models).toEqual([]);
    expect(result.note).toContain('No model inventories');
  });
});

describe('getModelEndpoint', () => {
  it('returns the endpoint for a served model', async () => {
    const result = await getModelEndpoint(mockClient(), 'gemma4:12b') as any;
    expect(result.endpoint).toBe('http://100.105.10.12:11434/v1');
    expect(result.machine).toBe('workstation');
  });

  it('keeps working for endpoint-only (routable: false) models', async () => {
    const result = await getModelEndpoint(mockClient(), 'tinyllama:1.1b') as any;
    expect(result.endpoint).toBe('http://100.99.1.2:11434/v1');
    expect(result.machine).toBe('nas');
    expect(result.error).toBeUndefined();
  });

  it('lists what is available when the model is not served', async () => {
    const result = await getModelEndpoint(mockClient(), 'nope') as any;
    expect(result.error).toContain('nope');
    expect(result.available).toContain('gemma4:12b');
  });
});

describe('runModel', () => {
  it('posts a capability-tagged task and returns the completed result', async () => {
    const client = mockClient();
    const result = await runModel(client, { model: 'gemma4:12b', prompt: 'hi', wait_seconds: 10 }, 1) as any;

    expect(client.postTask).toHaveBeenCalledWith(
      'model-tasks',
      expect.stringContaining('gemma4:12b'),
      expect.stringContaining('"prompt":"hi"'),
      ['llm-gemma4-12b'],
    );
    expect(result.status).toBe('done');
    expect(result.result).toBe('output text');
  });

  it('uses the generic llm tag when no model is named', async () => {
    const client = mockClient();
    await runModel(client, { prompt: 'hi', wait_seconds: 0 }, 1);
    expect(client.postTask).toHaveBeenCalledWith('model-tasks', expect.any(String), expect.any(String), ['llm']);
  });

  it('returns the task id without polling when wait_seconds is 0', async () => {
    const client = mockClient();
    const result = await runModel(client, { prompt: 'hi', wait_seconds: 0 }, 1) as any;
    expect(client.getTask).not.toHaveBeenCalled();
    expect(result.task_id).toBe('task-1');
    expect(result.note).toContain('without waiting');
  });

  it('errors informatively for an unserved model', async () => {
    const result = await runModel(mockClient(), { model: 'nope', prompt: 'hi' }, 1) as any;
    expect(result.error).toContain('nope');
  });

  it('refuses to post a task for an endpoint-only (routable: false) model', async () => {
    const client = mockClient();
    const result = await runModel(client, { model: 'tinyllama:1.1b', prompt: 'hi' }, 1) as any;
    expect(result.error).toContain('endpoint-only');
    expect(result.error).toContain('get_model_endpoint');
    expect(result.endpoint).toBe('http://100.99.1.2:11434/v1');
    expect(client.postTask).not.toHaveBeenCalled();
  });

  it('still routes models whose inventory predates the routable flag', async () => {
    const client = mockClient();
    const result = await runModel(client, { model: 'anthropic/claude-sonnet-5', prompt: 'hi', wait_seconds: 0 }, 1) as any;
    expect(client.postTask).toHaveBeenCalledWith(
      'model-tasks', expect.any(String), expect.any(String), ['llm-anthropic-claude-sonnet-5'],
    );
    expect(result.task_id).toBe('task-1');
  });

  it('reports still-running on timeout', async () => {
    const client = mockClient({ getTask: vi.fn().mockResolvedValue({ task: { id: 'task-1', status: 'claimed' } }) });
    const result = await runModel(client, { prompt: 'hi', wait_seconds: 1 }, 400) as any;
    expect(result.status).toBe('claimed');
    expect(result.note).toContain('Check later');
  });
});

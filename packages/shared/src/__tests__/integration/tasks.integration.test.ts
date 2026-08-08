/**
 * Task-queue integration tests — the docs/scenarios.md fleet, live.
 *
 * The coder posts an image task; two vision-capable agents race to claim it;
 * exactly one wins; the winner completes it and the result lands back in the
 * channel. Requires a server with migration 00025 applied (like the rest of
 * the integration tier, this does not run in CI).
 *
 * Run:
 *   npx vitest run --config vitest.integration.config.ts packages/shared/src/__tests__/integration/tasks
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AirChatRestClient } from '../../rest-client.js';
import { fleetAgent } from '../../demo-fleet.js';
import type { Task } from '../../tasks.js';
import { rateLimitTolerant } from './rate-limit-tolerant.js';

const UNIQUE_TAG = `tasks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_CHANNEL = 'tasks-test';

let coder: AirChatRestClient;
let vision: AirChatRestClient;
let rival: AirChatRestClient;

beforeAll(() => {
  // Same cards as the demo fleet, unique test agent names.
  coder = rateLimitTolerant(AirChatRestClient.fromConfig({
    agentName: 'macbook-test-task-coder',
    card: fleetAgent('laptop-claude-coder').card,
  }));
  vision = rateLimitTolerant(AirChatRestClient.fromConfig({
    agentName: 'macbook-test-task-vision',
    card: fleetAgent('gpu-opencode-vision').card,
  }));
  rival = rateLimitTolerant(AirChatRestClient.fromConfig({
    agentName: 'macbook-test-task-rival',
    card: fleetAgent('gpu-opencode-vision').card,
  }));
});

describe('task lifecycle', () => {
  let taskId: string;

  it('coder posts an image-gen task; announcement lands in the channel', async () => {
    const result = (await coder.postTask(
      TEST_CHANNEL,
      `Generate hero image [${UNIQUE_TAG}]`,
      '1200x600, salmon swimming upstream',
      ['image-gen'],
    )) as { task: Task };
    expect(result.task.status).toBe('open');
    expect(result.task.capability_tags).toEqual(['image-gen']);
    taskId = result.task.id;

    const messages = (await coder.readMessages(TEST_CHANNEL, 10)) as { messages: Array<{ content: string }> };
    const announcement = messages.messages.find((m) => m.content.includes(UNIQUE_TAG));
    expect(announcement).toBeDefined();
  });

  it('the task shows up in check_tasks (for_me) for a vision-capable agent', async () => {
    const work = (await vision.listTasks({ forMe: true })) as { open_matching: Task[] };
    expect(work.open_matching.some((t) => t.id === taskId)).toBe(true);
  });

  it('two agents race to claim; exactly one wins', async () => {
    const [a, b] = await Promise.allSettled([
      vision.updateTask(taskId, 'claim'),
      rival.updateTask(taskId, 'claim'),
    ]);
    const wins = [a, b].filter((r) => r.status === 'fulfilled');
    const losses = [a, b].filter((r) => r.status === 'rejected');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(String((losses[0] as PromiseRejectedResult).reason)).toMatch(/409|claimed/i);
  });

  it('only the winner can complete; the result is posted back', async () => {
    const winner = ((await coder.listTasks({ status: 'claimed', channel: TEST_CHANNEL })) as { tasks: Task[] })
      .tasks.find((t) => t.id === taskId);
    expect(winner).toBeDefined();

    const winnerClient = winner!.claimed_by !== null ? [vision, rival] : [];
    // Try both racers: the non-claimant must 403, the claimant succeeds.
    let completed: Task | null = null;
    let forbidden = 0;
    for (const client of winnerClient) {
      try {
        const result = (await client.updateTask(taskId, 'complete', `hero.png uploaded [${UNIQUE_TAG}]`)) as { task: Task };
        completed = result.task;
      } catch {
        forbidden++;
      }
    }
    expect(completed?.status).toBe('done');
    expect(forbidden).toBe(1);

    const messages = (await coder.readMessages(TEST_CHANNEL, 10)) as { messages: Array<{ content: string }> };
    expect(messages.messages.some((m) => m.content.includes('done') && m.content.includes(UNIQUE_TAG))).toBe(true);
  });

  it('only the creator can cancel; done tasks cannot be cancelled', async () => {
    await expect(vision.updateTask(taskId, 'cancel')).rejects.toThrow();
    await expect(coder.updateTask(taskId, 'cancel')).rejects.toThrow(/409|done/i);
  });
});

describe('task guard rails', () => {
  it('tasks cannot be created in federated channels', async () => {
    await expect(
      coder.postTask('gossip-town-square', `nope [${UNIQUE_TAG}]`)
    ).rejects.toThrow(/federated|400/i);
  });

  it('untagged tasks match every agent', async () => {
    const result = (await coder.postTask(TEST_CHANNEL, `Anyone: sweep logs [${UNIQUE_TAG}]`)) as { task: Task };
    const work = (await vision.listTasks({ forMe: true })) as { open_matching: Task[] };
    expect(work.open_matching.some((t) => t.id === result.task.id)).toBe(true);
    // Clean up so reruns stay tidy.
    await coder.updateTask(result.task.id, 'cancel');
  });
});

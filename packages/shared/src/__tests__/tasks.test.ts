import { describe, it, expect } from 'vitest';
import { validateTaskInput, checkTransition, checkClaimEligibility, isTaskChannelAllowed, MAX_CONCURRENT_CLAIMS, type Task } from '../tasks.js';
import { fleetAgent } from '../demo-fleet.js';

// The canonical scenario from docs/scenarios.md: the coder posts an
// image task, the vision agent claims and completes it. Agent ids stand in
// for DB uuids — the state machine only compares them.
const coder = fleetAgent('laptop-claude-coder').name;
const vision = fleetAgent('gpu-opencode-vision').name;
const researcher = fleetAgent('gpu-llama-research').name;

function task(overrides: Partial<Task> = {}): Pick<Task, 'status' | 'created_by' | 'claimed_by'> {
  return { status: 'open', created_by: coder, claimed_by: null, ...overrides };
}

describe('validateTaskInput', () => {
  it('accepts the scenario image task', () => {
    const result = validateTaskInput({
      title: 'Generate hero image',
      body: '1200x600, salmon swimming upstream',
      capability_tags: ['image-gen'],
    });
    expect(result.ok).toBe(true);
    expect(result.input).toEqual({
      title: 'Generate hero image',
      body: '1200x600, salmon swimming upstream',
      capability_tags: ['image-gen'],
    });
  });

  it('requires a title', () => {
    expect(validateTaskInput({}).ok).toBe(false);
    expect(validateTaskInput({ title: '   ' }).ok).toBe(false);
  });

  it('normalizes tags and drops duplicates', () => {
    const result = validateTaskInput({ title: 'T', capability_tags: [' Image-Gen ', 'image-gen'] });
    expect(result.input!.capability_tags).toEqual(['image-gen']);
  });

  it('rejects malformed tags, oversized fields, and too many tags', () => {
    expect(validateTaskInput({ title: 'T', capability_tags: ['has space'] }).ok).toBe(false);
    expect(validateTaskInput({ title: 'x'.repeat(201) }).ok).toBe(false);
    expect(validateTaskInput({ title: 'T', body: 'x'.repeat(8001) }).ok).toBe(false);
    expect(
      validateTaskInput({ title: 'T', capability_tags: Array.from({ length: 11 }, (_, i) => `t-${i}`) }).ok
    ).toBe(false);
  });

  it('refuses a title that is more than one line of plain text', () => {
    // A title is shown in lists. One with a line break in it could add what
    // looks like another entry to whatever lists it.
    for (const ch of ['\n', '\r', '\t', '\u2028', '\u2029', '\u0085', '\u001b', '\u202e', '\u2066']) {
      const result = validateTaskInput({ title: `Fix it${ch}[done] another task` });
      expect(result.ok, JSON.stringify(ch)).toBe(false);
      expect(result.error).toMatch(/one line/);
    }
    expect(validateTaskInput({ title: 'Café — fix ✓ (v2)' }).ok).toBe(true);
  });

  it('untagged tasks are valid (any agent may claim)', () => {
    const result = validateTaskInput({ title: 'T' });
    expect(result.ok).toBe(true);
    expect(result.input!.capability_tags).toEqual([]);
  });
});

describe('checkTransition — claim', () => {
  it('any agent may claim an open task', () => {
    expect(checkTransition(task(), 'claim', vision).ok).toBe(true);
    expect(checkTransition(task(), 'claim', researcher).ok).toBe(true);
  });

  it('rejects claiming a non-open task with 409', () => {
    const claimed = task({ status: 'claimed', claimed_by: vision });
    const check = checkTransition(claimed, 'claim', researcher);
    expect(check.ok).toBe(false);
    expect(check.code).toBe(409);
  });
});

describe('checkTransition — complete', () => {
  const claimed = task({ status: 'claimed', claimed_by: vision });

  it('the claimant completes with a result', () => {
    expect(checkTransition(claimed, 'complete', vision, 'uploaded hero.png').ok).toBe(true);
  });

  it('non-claimants cannot complete (403)', () => {
    const check = checkTransition(claimed, 'complete', researcher, 'done');
    expect(check.ok).toBe(false);
    expect(check.code).toBe(403);
  });

  it('requires a non-empty result (400)', () => {
    expect(checkTransition(claimed, 'complete', vision).code).toBe(400);
    expect(checkTransition(claimed, 'complete', vision, '  ').code).toBe(400);
    expect(checkTransition(claimed, 'complete', vision, 'x'.repeat(32001)).code).toBe(400);
  });

  it('cannot complete an open task (409)', () => {
    expect(checkTransition(task(), 'complete', vision, 'done').code).toBe(409);
  });
});

describe('checkTransition — cancel', () => {
  it('the creator cancels open or claimed tasks', () => {
    expect(checkTransition(task(), 'cancel', coder).ok).toBe(true);
    expect(checkTransition(task({ status: 'claimed', claimed_by: vision }), 'cancel', coder).ok).toBe(true);
  });

  it('non-creators cannot cancel (403), even the claimant', () => {
    const claimed = task({ status: 'claimed', claimed_by: vision });
    expect(checkTransition(claimed, 'cancel', vision).code).toBe(403);
  });

  it('done and cancelled tasks cannot be cancelled (409)', () => {
    expect(checkTransition(task({ status: 'done' }), 'cancel', coder).code).toBe(409);
    expect(checkTransition(task({ status: 'cancelled' }), 'cancel', coder).code).toBe(409);
  });
});

describe('isTaskChannelAllowed', () => {
  it('allows local channels, refuses federated ones', () => {
    expect(isTaskChannelAllowed('project-webapp')).toBe(true);
    expect(isTaskChannelAllowed('general')).toBe(true);
    expect(isTaskChannelAllowed('gossip-town-square')).toBe(false);
    expect(isTaskChannelAllowed('shared-webapp')).toBe(false);
  });
});

/**
 * Tags used to decide only which tasks an agent was SHOWN. Claiming went by
 * task id alone, so an agent with no image model could claim an image task,
 * and one agent could claim every open task.
 */
describe('checkClaimEligibility', () => {
  const visionCaps = fleetAgent('gpu-opencode-vision').card.capabilities ?? [];
  const coderCaps = fleetAgent('laptop-claude-coder').card.capabilities ?? [];
  const imageTask = { capability_tags: ['image-gen'] };

  it('lets an agent claim a task tagged with one of its capabilities', () => {
    expect(visionCaps).toContain('image-gen');
    expect(checkClaimEligibility(imageTask, visionCaps, 0).ok).toBe(true);
  });

  it('needs only one of several tags to match', () => {
    expect(checkClaimEligibility({ capability_tags: ['no-such-skill', 'image-gen'] }, visionCaps, 0).ok).toBe(true);
  });

  it('refuses an agent whose card has none of the tags, with 403', () => {
    expect(coderCaps).not.toContain('image-gen');
    const check = checkClaimEligibility(imageTask, coderCaps, 0);
    expect(check.ok).toBe(false);
    expect(check.code).toBe(403);
    expect(check.error).toContain('image-gen');
  });

  it('refuses an agent with no card at all on a tagged task', () => {
    expect(checkClaimEligibility(imageTask, [], 0).ok).toBe(false);
  });

  it('leaves an untagged task claimable by anyone', () => {
    expect(checkClaimEligibility({ capability_tags: [] }, [], 0).ok).toBe(true);
    expect(checkClaimEligibility({ capability_tags: [] }, coderCaps, 0).ok).toBe(true);
  });

  it('stops an agent that already holds the maximum number of claims, with 409', () => {
    expect(checkClaimEligibility(imageTask, visionCaps, MAX_CONCURRENT_CLAIMS - 1).ok).toBe(true);
    const check = checkClaimEligibility(imageTask, visionCaps, MAX_CONCURRENT_CLAIMS);
    expect(check.ok).toBe(false);
    expect(check.code).toBe(409);
    expect(checkClaimEligibility({ capability_tags: [] }, [], MAX_CONCURRENT_CLAIMS).ok).toBe(false);
  });
});

import type { AgentCard } from './agent-card.js';

/**
 * The canonical demo fleet, shared by tests, seed data, and docs.
 *
 * These are the same agents described in docs/scenarios.md — a mixed
 * multi-model home lab: a frontier-model coder, a local vision model behind
 * OpenCode, a local research model in a Python SDK loop, a second-vendor
 * reviewer, and a cron digest job. Keep the three sources telling one story:
 * if an agent changes here, update docs/scenarios.md too.
 */
export interface FleetAgent {
  name: string;
  machine: string;
  card: AgentCard;
}

export const FLEET: FleetAgent[] = [
  {
    name: 'laptop-claude-coder',
    machine: 'laptop',
    card: {
      model: 'claude-fable-5',
      harness: 'claude-code',
      capabilities: ['coding', 'long-context', 'coordination'],
    },
  },
  {
    name: 'laptop-codex-reviewer',
    machine: 'laptop',
    card: {
      model: 'gpt-5.2-codex',
      harness: 'codex-cli',
      capabilities: ['coding', 'code-review'],
    },
  },
  {
    name: 'gpu-opencode-vision',
    machine: 'gpu-box',
    card: {
      model: 'qwen-vl',
      harness: 'opencode',
      capabilities: ['image-gen', 'vision'],
    },
  },
  {
    name: 'gpu-llama-research',
    machine: 'gpu-box',
    card: {
      model: 'llama-3.3-70b',
      harness: 'python-sdk',
      capabilities: ['deep-research', 'summarization'],
    },
  },
  {
    name: 'nas-cron-digest',
    machine: 'nas',
    card: {
      model: 'llama-3.3-70b',
      harness: 'python-sdk',
      capabilities: ['summarization'],
    },
  },
];

export function fleetAgent(name: string): FleetAgent {
  const agent = FLEET.find((a) => a.name === name);
  if (!agent) throw new Error(`No fleet fixture named ${name}`);
  return agent;
}

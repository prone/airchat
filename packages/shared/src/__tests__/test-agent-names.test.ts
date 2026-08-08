import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Integration tests must not invent a new agent name on every run.
 *
 * They used to: names were suffixed with Date.now(), so each execution
 * registered brand-new agents that nothing removed. On the live board that
 * reached 37 of 83 active agents — and because they were the most recently
 * active, they sat at the TOP of every "who can I message?" listing, burying
 * the real agents. A deploy runs the suite, so every deploy made it worse.
 *
 * Uniqueness was never needed across runs, only within one (so nonce-test-1
 * differs from nonce-test-2). Re-registering an existing agent is supported, so
 * fixed names update the same handful of rows.
 *
 * This guards the failure mode rather than the symptom. Cleaning up afterwards
 * is a chore that hides the regression; failing here names the file.
 */

const INTEGRATION_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'integration',
);

/**
 * A name built from a clock or a random value. Anchored to agent-name context
 * so an unrelated Date.now() — a timestamp field, a duration measurement — does
 * not trip it.
 */
const DYNAMIC_AGENT_NAME = /(agent_name|agentName|target_agent|targetAgent)\s*[:=]\s*[`'"][^`'"]*\$\{[^}]*(Date\.now|Math\.random|randomBytes|randomUUID)/;

function integrationFiles(): string[] {
  try {
    return readdirSync(INTEGRATION_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(INTEGRATION_DIR, f));
  } catch {
    return [];
  }
}

describe('integration tests reuse agent names instead of creating new ones', () => {
  it('finds the integration suite (guard is pointless if the path moved)', () => {
    expect(integrationFiles().length).toBeGreaterThan(0);
  });

  it('never builds an agent name from a clock or a random value', () => {
    const offenders: string[] = [];

    for (const file of integrationFiles()) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (DYNAMIC_AGENT_NAME.test(line)) {
          offenders.push(`${file.split('/').pop()}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    // Named explicitly so a failure says which line to fix, not just "true !== false".
    expect(offenders, [
      'An agent name is built from Date.now(), Math.random() or a random byte',
      'source. That registers a NEW agent on every run, and nothing removes them.',
      '',
      'Use a fixed name. Uniqueness is only needed WITHIN a run (nonce-test-1 vs',
      'nonce-test-2), and re-registering an existing agent is supported, so a',
      'fixed name updates the same row instead of adding one.',
      '',
      'Offending lines:',
      ...offenders,
    ].join('\n')).toEqual([]);
  });

  it('catches the pattern it is meant to catch', () => {
    // Proves the regex works — a guard that silently matches nothing is worse
    // than no guard, because it reads as passing.
    const bad = [
      'agent_name: `edge-case-test-${Date.now()}`,',
      "agentName = `reregister-test-${Date.now()}`;",
      'target_agent: `probe-${Math.random().toString(36)}`,',
    ];
    for (const line of bad) expect(DYNAMIC_AGENT_NAME.test(line)).toBe(true);
  });

  it('does not flag a fixed name, or an unrelated timestamp', () => {
    const fine = [
      "agent_name: 'edge-case-test',",
      "agentName = 'reregister-test';",
      'timestamp: new Date().toISOString(),',
      'const started = Date.now();',
      'nonce: generateNonce(),',
    ];
    for (const line of fine) expect(DYNAMIC_AGENT_NAME.test(line)).toBe(false);
  });
});

/**
 * The prune script must never target an agent the test suites actually use.
 *
 * This is not hypothetical. The residue patterns were written when integration
 * suites suffixed agent names with `Date.now()`, so every run left new rows
 * behind. Fixing that made the names fixed — and a fixed name is an identity,
 * not residue. The prune then deactivated the agents the integration tier
 * authenticates with, and the entire tier failed 401 on the next deploy.
 *
 * Rather than hand-maintaining a protected list that would drift, read the
 * names straight out of the integration sources. A suite that adopts a new
 * agent name is covered the moment it is written.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { RESIDUE_PATTERNS } from '../residue-patterns.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const integrationDir = path.join(
  here,
  '..',
  '..',
  'packages',
  'shared',
  'src',
  '__tests__',
  'integration'
);

/** `agentName: 'x'` and `agent_name: 'x'`, the two spellings the suites use. */
const AGENT_NAME_LITERAL = /\b(?:agentName|agent_name)\s*:\s*['"`]([^'"`]+)['"`]/g;

function agentNamesUsedByTests(): { name: string; file: string }[] {
  const found: { name: string; file: string }[] = [];
  for (const file of fs.readdirSync(integrationDir)) {
    if (!file.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(integrationDir, file), 'utf-8');
    for (const m of src.matchAll(AGENT_NAME_LITERAL)) {
      // Skip interpolated names — they are not stable identities anyway.
      if (m[1].includes('${')) continue;
      found.push({ name: m[1], file });
    }
  }
  return found;
}

describe('prune residue patterns', () => {
  it('finds the agent names the integration suites register', () => {
    const names = agentNamesUsedByTests();
    // Guards the guard: if the regex stops matching, every assertion below
    // passes vacuously.
    expect(names.length).toBeGreaterThan(4);
    expect(names.map((n) => n.name)).toContain('macbook-integration-test');
  });

  it('never matches a name a test suite registers', () => {
    const offenders = agentNamesUsedByTests()
      .flatMap(({ name, file }) =>
        RESIDUE_PATTERNS.filter(({ pattern }) => pattern.test(name)).map(
          ({ pattern, source }) => `${name} (${file}) matched ${pattern} — "${source}"`
        )
      );

    expect(
      offenders,
      'These patterns would deactivate agents the tests authenticate with, ' +
        'which breaks the integration tier on the next run:\n  ' +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('still recognises the historic residue it exists to clear', () => {
    const historic = [
      'macbook-agent-a6b32b27',
      'macbook-dmtest-ad29e5',
      'macbook-fakeproj',
      'supernode-admin-setup-at-1234',
    ];
    for (const name of historic) {
      expect(
        RESIDUE_PATTERNS.some(({ pattern }) => pattern.test(name)),
        `${name} should still be recognised as residue`
      ).toBe(true);
    }
  });
});

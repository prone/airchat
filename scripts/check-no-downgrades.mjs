#!/usr/bin/env node
// Fails if a PR lowers any dependency version in package-lock.json.
//
// `npm audit fix --force` is allowed to resolve advisories by installing
// semver-major changes, including going backwards -- it once proposed
// next@9.3.3 (2020) to shed a transitive sharp/libvips CVE. A downgrade of
// that shape would sail through review as "a dependency change". This makes
// it a hard CI failure instead.
//
// Usage: node scripts/check-no-downgrades.mjs [baseRef]   (default: origin/main)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const baseRef = process.argv[2] || 'origin/main';

/** Compare dotted numeric cores; prerelease suffixes are ignored. */
function compareVersions(a, b) {
  const core = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [core(a), core(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function versionsOf(lockJson) {
  const out = new Map();
  for (const [path, meta] of Object.entries(lockJson.packages || {})) {
    if (!path || !meta?.version) continue; // skip the root ("") entry
    out.set(path, meta.version);
  }
  return out;
}

let baseLock;
try {
  baseLock = JSON.parse(
    execFileSync('git', ['show', `${baseRef}:package-lock.json`], {
      encoding: 'utf-8',
      maxBuffer: 128 * 1024 * 1024,
    }),
  );
} catch {
  console.log(`No package-lock.json at ${baseRef} — nothing to compare. Skipping.`);
  process.exit(0);
}

const head = versionsOf(JSON.parse(readFileSync('package-lock.json', 'utf-8')));
const base = versionsOf(baseLock);

const downgrades = [];
for (const [path, baseVersion] of base) {
  const headVersion = head.get(path);
  if (!headVersion) continue; // removed entirely — not a downgrade
  if (compareVersions(headVersion, baseVersion) < 0) {
    downgrades.push({ path, from: baseVersion, to: headVersion });
  }
}

if (downgrades.length === 0) {
  console.log(`OK: no dependency downgrades vs ${baseRef} (${base.size} packages compared)`);
  process.exit(0);
}

console.error(`\nBLOCKED: ${downgrades.length} dependency downgrade(s) vs ${baseRef}:\n`);
for (const d of downgrades) {
  console.error(`  ${d.path.replace(/^node_modules\//, '')}: ${d.from} -> ${d.to}`);
}
console.error(
  '\nDowngrades are almost always `npm audit fix --force` resolving an advisory\n' +
    'by moving backwards. Use `npm audit fix` (semver-compatible only), or wait\n' +
    'for an upstream fix. If this downgrade is deliberate, remove this check in\n' +
    'the same PR and say why.\n',
);
process.exit(1);

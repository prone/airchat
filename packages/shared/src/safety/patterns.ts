/**
 * Pattern set loader for AirChat safety classification.
 *
 * Loads pattern definitions from a JSON config file. The engine (classifier.ts)
 * is open source; the pattern definitions can come from:
 *   1. The starter set bundled here (minimal, obvious patterns)
 *   2. A private pattern feed (production patterns, not in the public repo)
 *   3. A custom file path specified by the operator
 *
 * Pattern sets are versioned and hot-updatable — the loader can be called
 * again to pick up new patterns without restarting the process.
 */

import { readFileSync, existsSync } from 'fs';
import type { PatternSet } from './types.js';

/**
 * Minimal starter pattern set included in the public repo.
 *
 * Contains only patterns that are:
 *   - Obvious (wrapper escape, reserved agent names)
 *   - Well-known attack classes that don't benefit from secrecy
 *   - Necessary for the engine to function at all
 *
 * Production deployments should load the full pattern set from the
 * private pattern feed (airchat-patterns repo).
 */
export const STARTER_PATTERNS: PatternSet = {
  version: '0.1.0-starter',
  updated_at: '2026-03-14T00:00:00Z',
  patterns: [
    // W-1: Wrapper escape — immediate quarantine
    {
      id: 'W-1',
      category: 'W',
      description: 'Message contains safety wrapper text (wrapper escape attempt)',
      regex: '\\[(?:END\\s+)?AIRCHAT(?:\\s+(?:GOSSIP|SHARED))?\\s+DATA',
      label: 'quarantined',
      action: 'quarantine',
      de_escalates: false,
    },
    // W-2: Context manipulation
    {
      id: 'W-2',
      category: 'W',
      description: 'Context manipulation language',
      regex: '(?:ignore\\s+(?:your\\s+)?(?:previous|prior|above)|disregard\\s+(?:your\\s+)?instructions|you\\s+are\\s+now\\s+in\\s+a\\s+new\\s+context|new\\s+(?:system\\s+)?context)',
      label: 'contains-instructions',
      action: 'quarantine',
      de_escalates: false,
    },
  ],

  // Starter set has no sandbox keywords (those are in the private feed)
  sandbox_keywords: [],

  compound_rules: [],

  entropy: {
    threshold: 5.5,
    min_length: 20,
  },

  decode_inspect: {
    encodings: [
      { name: 'hex', detection_regex: '(?:[0-9a-fA-F]{2}\\s*){10,}', quarantine_on_match: true },
      { name: 'base64', detection_regex: '[A-Za-z0-9+/=]{20,}', quarantine_on_match: true },
      { name: 'url-encoded', detection_regex: '(?:%[0-9a-fA-F]{2}){5,}', quarantine_on_match: true },
    ],
  },

  // Reserved agent name prefixes — always enforced
  reserved_agent_prefixes: [
    'airchat-',
    'system-',
    'admin-',
    'official-',
  ],

  // Framing indicators for de-escalation (AD/UA only, never IM)
  framing_indicators: [
    'example:',
    'template:',
    'try this:',
    'here\'s a prompt:',
    'snippet:',
    'sample:',
    'here is a prompt:',
    'prompt template:',
  ],
};

/**
 * Load a pattern set from a JSON file.
 * Falls back to the starter set if the file doesn't exist.
 */
export function loadPatternSet(filePath?: string): PatternSet {
  // Check for a custom pattern file path
  const path = filePath ?? process.env.AIRCHAT_PATTERN_FILE;

  if (path && existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as PatternSet;

      // Basic validation
      if (!parsed.version || !parsed.patterns || !Array.isArray(parsed.patterns)) {
        console.warn(`[safety] Invalid pattern file at ${path}, falling back to starter set`);
        return STARTER_PATTERNS;
      }

      console.log(`[safety] Loaded pattern set v${parsed.version} from ${path}`);
      return parsed;
    } catch (err) {
      console.warn(`[safety] Failed to load pattern file at ${path}: ${err}`);
      return STARTER_PATTERNS;
    }
  }

  // No custom file — use starter set
  return STARTER_PATTERNS;
}

/**
 * Validate a pattern set (check regex validity, required fields, etc.).
 * Returns an array of error messages (empty if valid).
 */
export function validatePatternSet(patternSet: PatternSet): string[] {
  const errors: string[] = [];

  if (!patternSet.version) errors.push('Missing version');
  if (!patternSet.patterns) errors.push('Missing patterns array');

  for (const p of patternSet.patterns ?? []) {
    if (!p.id) errors.push(`Pattern missing id`);
    if (!p.regex) errors.push(`Pattern ${p.id}: missing regex`);
    try {
      new RegExp(p.regex, p.flags ?? 'i');
    } catch {
      errors.push(`Pattern ${p.id}: invalid regex "${p.regex}"`);
    }
  }

  for (const rule of patternSet.compound_rules ?? []) {
    if (!rule.id) errors.push('Compound rule missing id');
    if (!rule.requires?.length) errors.push(`Rule ${rule.id}: missing requires`);
  }

  return errors;
}

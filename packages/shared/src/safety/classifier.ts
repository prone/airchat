/**
 * Safety classification engine for AirChat gossip layer.
 *
 * This is the PUBLIC engine — it loads and runs patterns but does not
 * contain the specific pattern definitions. Patterns are loaded from
 * a configurable PatternSet (see patterns.ts for the loader).
 */

import type {
  ClassificationResult,
  HeuristicPattern,
  PatternSet,
  SafetyLabel,
} from './types.js';
import { normalize, extractMetadataStrings } from './normalize.js';

/**
 * Shannon entropy in bits per character.
 */
function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const char of text) {
    freq.set(char, (freq.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Detect whether content has framing context (quotation marks, code blocks,
 * or framing language like "example:", "template:", etc.).
 */
function hasFramingContext(text: string, framingIndicators: string[]): boolean {
  const lower = text.toLowerCase();

  // Check for framing language indicators
  for (const indicator of framingIndicators) {
    if (lower.includes(indicator.toLowerCase())) return true;
  }

  // Check for quotation wrapping (content inside quotes or code blocks)
  if (/["'][\s\S]{10,}["']/.test(text)) return true;
  if (/```[\s\S]+```/.test(text)) return true;

  return false;
}

/**
 * Check if an agent name uses a reserved prefix.
 */
export function isReservedAgentName(
  agentName: string,
  reservedPrefixes: string[]
): boolean {
  const lower = agentName.toLowerCase();
  return reservedPrefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

/**
 * Run heuristic patterns against normalized text.
 * Returns all matching pattern IDs and their labels/actions.
 */
function runPatterns(
  normalizedText: string,
  patterns: HeuristicPattern[]
): Array<{ pattern: HeuristicPattern; match: RegExpMatchArray }> {
  const matches: Array<{ pattern: HeuristicPattern; match: RegExpMatchArray }> = [];

  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern.regex, pattern.flags ?? 'i');
      const match = normalizedText.match(regex);
      if (match) {
        matches.push({ pattern, match });
      }
    } catch {
      // Invalid regex in pattern definition — skip silently
      // (pattern validation should catch this during loading)
    }
  }

  return matches;
}

/**
 * Determine the most severe safety label from a set of labels.
 */
function mostSevereLabel(labels: SafetyLabel[]): SafetyLabel {
  const severity: Record<SafetyLabel, number> = {
    'quarantined': 5,
    'high-entropy': 4,
    'requests-data': 3,
    'references-tools': 2,
    'contains-instructions': 1,
    'clean': 0,
  };

  let worst: SafetyLabel = 'clean';
  for (const label of labels) {
    if (severity[label] > severity[worst]) {
      worst = label;
    }
  }
  return worst;
}

/**
 * Classify a federated message using the loaded pattern set.
 *
 * This is the Phase 1 (synchronous) classification pipeline.
 * Runs heuristic patterns, entropy analysis, and decode-inspect.
 * Does NOT run LLM classification (Phase 2) or sandbox (Phase 3).
 */
export function classifyMessage(
  content: string,
  metadata: Record<string, unknown> | null,
  patternSet: PatternSet
): ClassificationResult {
  const labels: SafetyLabel[] = [];
  const matchedPatterns: string[] = [];
  let routeToSandbox = false;
  let sandboxPriority: 'normal' | 'elevated' | null = null;

  // --- Normalize content ---
  const { normalized, decoded_segments } = normalize(content);

  // --- Extract and normalize metadata strings ---
  const metadataStrings = extractMetadataStrings(metadata);
  const allText = [normalized, ...metadataStrings.map((s) => normalize(s).normalized)].join(' ');

  // --- Detect framing context (for de-escalation) ---
  const framed = hasFramingContext(content, patternSet.framing_indicators);

  // --- Run heuristic patterns on combined text ---
  const patternMatches = runPatterns(allText, patternSet.patterns);

  for (const { pattern } of patternMatches) {
    matchedPatterns.push(pattern.id);
    labels.push(pattern.label);

    // Determine action (with de-escalation for framed AD/UA, but NOT IM)
    let action = pattern.action;
    if (framed && pattern.de_escalates && pattern.category !== 'IM') {
      // De-escalate: sandbox → flag, sandbox-elevated → sandbox, quarantine stays
      if (action === 'sandbox') action = 'flag';
      if (action === 'sandbox-elevated') action = 'sandbox';
      // quarantine and escalate are NOT de-escalated
    }

    if (action === 'quarantine') {
      labels.push('quarantined');
    }
    if (action === 'sandbox' || action === 'sandbox-elevated') {
      routeToSandbox = true;
      if (action === 'sandbox-elevated') {
        sandboxPriority = 'elevated';
      } else if (sandboxPriority !== 'elevated') {
        sandboxPriority = 'normal';
      }
    }
  }

  // --- Entropy analysis ---
  const entropyConfig = patternSet.entropy;
  // Check content segments longer than min_length
  const words = normalized.split(/\s+/);
  for (const word of words) {
    if (word.length >= entropyConfig.min_length) {
      const e = shannonEntropy(word);
      if (e > entropyConfig.threshold) {
        labels.push('high-entropy');
        matchedPatterns.push('E-1');
        break;
      }
    }
  }

  // --- Decode-inspect: classify decoded segments ---
  for (const segment of decoded_segments) {
    const segmentMatches = runPatterns(segment, patternSet.patterns);
    for (const { pattern } of segmentMatches) {
      // Decoded content with keywords/IM patterns → immediate quarantine
      // (encoding is evidence of intent — no de-escalation, no framing)
      if (
        pattern.category === 'IM' ||
        pattern.category === 'SK' ||
        pattern.category === 'D' ||
        pattern.category === 'T'
      ) {
        labels.push('quarantined');
        matchedPatterns.push(`DECODED:${pattern.id}`);
      } else if (pattern.category === 'AD' || pattern.category === 'UA') {
        routeToSandbox = true;
        sandboxPriority = 'elevated';
        matchedPatterns.push(`DECODED:${pattern.id}`);
      }
    }
  }

  // --- Sandbox keyword routing ---
  const contentLower = allText.toLowerCase();
  for (const kw of patternSet.sandbox_keywords) {
    if (contentLower.includes(kw.keyword.toLowerCase())) {
      routeToSandbox = true;
      matchedPatterns.push(`SK:${kw.keyword}`);
      if (sandboxPriority !== 'elevated') {
        sandboxPriority = 'normal';
      }
      break; // One keyword match is enough to route
    }
  }

  // --- Compound signal evaluation ---
  const matchedCategories = new Set(
    patternMatches.map((m) => m.pattern.category)
  );

  for (const rule of patternSet.compound_rules) {
    const allPresent = rule.requires.every((cat) => matchedCategories.has(cat));
    if (!allPresent) continue;

    // Apply framing de-escalation if applicable
    if (framed && rule.framing_affects) continue;

    matchedPatterns.push(rule.id);

    if (rule.action === 'quarantine') {
      labels.push('quarantined');
    } else if (rule.action === 'sandbox' || rule.action === 'sandbox-elevated') {
      routeToSandbox = true;
      if (rule.action === 'sandbox-elevated') {
        sandboxPriority = 'elevated';
      }
    }
  }

  // --- Determine final label ---
  const uniqueLabels = [...new Set(labels)];
  const primaryLabel = uniqueLabels.length > 0 ? mostSevereLabel(uniqueLabels) : 'clean';

  return {
    label: primaryLabel,
    labels: uniqueLabels.length > 0 ? uniqueLabels : ['clean'],
    matched_patterns: matchedPatterns,
    route_to_sandbox: routeToSandbox,
    sandbox_priority: routeToSandbox ? (sandboxPriority ?? 'normal') : null,
  };
}

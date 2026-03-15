/**
 * Safety classification types for the AirChat gossip layer.
 *
 * These types define the pattern schema and classification results.
 * The classification ENGINE is open source. The specific PATTERN
 * DEFINITIONS are loaded from a configurable source (see patterns.ts).
 */

/** Safety labels applied to federated messages during classification. */
export type SafetyLabel =
  | 'clean'
  | 'contains-instructions'
  | 'requests-data'
  | 'references-tools'
  | 'high-entropy'
  | 'quarantined';

/** Result of classifying a single message. */
export interface ClassificationResult {
  /** Primary label (most severe). */
  label: SafetyLabel;
  /** All labels that matched (a message can trigger multiple). */
  labels: SafetyLabel[];
  /** Pattern IDs that matched (e.g., 'W-1', 'IM-3', 'D-1'). */
  matched_patterns: string[];
  /** Whether the message should be routed to sandbox (Phase 3). */
  route_to_sandbox: boolean;
  /** Sandbox priority if routed ('normal' | 'elevated'). */
  sandbox_priority: 'normal' | 'elevated' | null;
}

/**
 * Pattern categories:
 *   W  — Wrapper escape
 *   A  — Authority impersonation
 *   I  — Instruction embedding
 *   D  — Data exfiltration requests
 *   T  — Tool/URL references
 *   E  — Encoding/entropy
 *   C  — Cross-message correlation
 *   AD — Agent-directed (direct address)
 *   IM — Identity manipulation
 *   UA — Urgency/authority pressure
 *   SK — Sandbox keywords
 */
export type PatternCategory =
  | 'W' | 'A' | 'I' | 'D' | 'T' | 'E' | 'C'
  | 'AD' | 'IM' | 'UA' | 'SK';

/** Action taken when a pattern matches. */
export type PatternAction =
  | 'quarantine'        // Immediate block, hidden from agents
  | 'flag'              // Visible with safety label
  | 'sandbox'           // Route to sandbox detonation
  | 'sandbox-elevated'  // Route to sandbox with elevated priority
  | 'escalate';         // Escalate based on compound signals

/** A single heuristic detection pattern. */
export interface HeuristicPattern {
  /** Unique pattern ID (e.g., 'W-1', 'IM-3'). */
  id: string;
  /** Pattern category. */
  category: PatternCategory;
  /** Human-readable description. */
  description: string;
  /** Regex pattern to match (applied to normalized text). */
  regex: string;
  /** Regex flags (default: 'i' for case-insensitive). */
  flags?: string;
  /** Safety label to apply on match. */
  label: SafetyLabel;
  /** Action to take on match. */
  action: PatternAction;
  /** Whether this pattern de-escalates under framing context. */
  de_escalates: boolean;
}

/** Sandbox keyword entry. */
export interface SandboxKeyword {
  /** The keyword or phrase to match. */
  keyword: string;
  /** Category for grouping (package-manager, git, shell, credential, url, airchat). */
  category: string;
  /** Brief description of why this keyword is monitored. */
  risk: string;
}

/** Compound signal rule (cross-pattern escalation). */
export interface CompoundRule {
  /** Rule ID (e.g., 'C-1'). */
  id: string;
  /** Description. */
  description: string;
  /** Pattern categories that must co-occur. */
  requires: PatternCategory[];
  /** Time window in seconds (for temporal correlation). */
  window_seconds?: number;
  /** Action when compound rule triggers. */
  action: PatternAction;
  /** Whether framing context affects this rule. */
  framing_affects: boolean;
}

/** Entropy detection configuration. */
export interface EntropyConfig {
  /** Shannon entropy threshold for flagging (default: 5.5 bits/char). */
  threshold: number;
  /** Minimum string length to analyze (default: 20). */
  min_length: number;
}

/** Decode-inspect configuration for encoded content detection. */
export interface DecodeInspectConfig {
  /** Encoding types to detect and decode. */
  encodings: Array<{
    name: string;
    /** Regex to detect this encoding in message text. */
    detection_regex: string;
    /** Whether decoded content triggers immediate quarantine on keyword/IM match. */
    quarantine_on_match: boolean;
  }>;
}

/** Top-level pattern set definition — loaded from config file. */
export interface PatternSet {
  /** Semantic version (e.g., '1.0.0'). */
  version: string;
  /** ISO timestamp of last update. */
  updated_at: string;
  /** Heuristic patterns (Phase 1 classification). */
  patterns: HeuristicPattern[];
  /** Sandbox keywords (Phase 3 routing). */
  sandbox_keywords: SandboxKeyword[];
  /** Compound signal rules. */
  compound_rules: CompoundRule[];
  /** Entropy detection config. */
  entropy: EntropyConfig;
  /** Decode-inspect config. */
  decode_inspect: DecodeInspectConfig;
  /** Reserved agent name prefixes (rejected at origin). */
  reserved_agent_prefixes: string[];
  /** Framing language that triggers de-escalation for AD/UA patterns (NOT IM). */
  framing_indicators: string[];
}

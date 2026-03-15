/**
 * AirChat Safety Classification — Public API
 *
 * Open-source classification engine for federated message safety.
 * The engine loads and runs patterns; specific pattern definitions
 * are loaded from a configurable source (starter set or private feed).
 */

export { classifyMessage, isReservedAgentName } from './classifier.js';
export { loadPatternSet, validatePatternSet, STARTER_PATTERNS } from './patterns.js';
export { normalize, extractMetadataStrings } from './normalize.js';
export type {
  SafetyLabel,
  ClassificationResult,
  PatternSet,
  HeuristicPattern,
  SandboxKeyword,
  CompoundRule,
  PatternCategory,
  PatternAction,
  EntropyConfig,
  DecodeInspectConfig,
} from './types.js';

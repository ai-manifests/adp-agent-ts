/**
 * adp-agent — public API.
 *
 * This file is the only import surface the library promises to keep stable.
 * Deep imports (e.g. 'adp-agent/dist/internal/...') are not supported.
 */

// --- Main class ---
export { AdpAgent } from './agent.js';
export type { AdpAgentOptions } from './agent.js';

// --- Types (full protocol surface) ---
export type {
  // ADP
  Vote,
  ReversibilityTier,
  StakeMagnitude,
  TerminationState,
  DissentCondition,
  VoteRevision,
  Proposal,
  TallyResult,
  SignedProposal,
  AgentManifest,
  AuthConfig,
  EvaluatorConfig,
  EvaluationResult,
  PeerConfig,
  PluginsConfig,
  AgentConfig,
  // ADJ
  CalibrationScore,
  JournalEntry,
  // ACB
  AcbDenomination,
  AcbPricingProfile,
  AcbSettlementMode,
  AcbSettlementProfile,
  AcbBudgetConstraints,
  AcbBudget,
  AcbContributionBreakdown,
  AcbEpistemicDistribution,
  AcbSubstrateDistribution,
  AcbSubstrateReport,
  AcbDefaults,
  // Calibration anchor (types only — implementations live in adp-agent-anchor)
  CalibrationAnchorTarget,
  CalibrationAnchorConfig,
} from './types.js';

// --- Journal ---
export type { JournalStore, DeliberationRecord } from './journal.js';
export { JsonlJournal } from './journal.js';
// Note: SqliteJournal is exported via the 'adp-agent/journal-sqlite' subpath
// so adopters who don't want the better-sqlite3 peer dep aren't forced to install it.

// --- Protocol primitives ---
export {
  computeWeight,
  computeTally,
  determineTermination,
  computeCalibration,
  generateId,
} from './protocol.js';

// --- Deliberation ---
export { PeerDeliberation, HttpTransport } from './deliberation.js';
export type { DeliberationResult, DeliberationRunOptions, PeerTransport } from './deliberation.js';

// --- Signing ---
export {
  generateKeyPair,
  canonicalize,
  canonicalizeValue,
  signProposal,
  verifyProposal,
} from './signing.js';

// --- Calibration snapshot (ADJ §7.4) ---
export {
  buildSnapshot,
  buildSignedEnvelope,
  signSnapshot,
  verifySnapshot,
  canonicalSnapshotMessage,
  computeJournalHash,
  extractScoringPairs,
} from './calibration-snapshot.js';
export type {
  CalibrationSnapshot,
  CalibrationSnapshotEnvelope,
  ScoringPair,
} from './calibration-snapshot.js';

// --- Calibration verifier (peer spot-checks) ---
export {
  verifyPeerCalibration,
  applyDivergencePenalty,
} from './calibration-verifier.js';
export type { VerificationResult } from './calibration-verifier.js';

// --- ACB pricing / settlement / contribution ---
export {
  DEFAULT_PRICING,
  DEFAULT_SETTLEMENT,
  MAX_HABIT_DISCOUNT,
  computeDisagreementMagnitude,
  selectRoutine,
  computeCheapDraw,
  computeExpensiveDraw,
  computeDraw,
  computeHabitDiscount,
  findHabitHistory,
  ContributionTracker,
  distributeSubstrate,
  distributeEpistemic,
  buildSettlementRecord,
  buildBudgetCommittedEntry,
  budgetFromDefaults,
} from './acb.js';
export type {
  Routine,
  HistoricalDeliberation,
  ParticipantContribution,
  SettlementInputs,
} from './acb.js';

// --- Evaluator ---
export { evaluate } from './evaluator.js';

// --- MCP server ---
export { createMcpServer, mountMcpEndpoints } from './mcp-server.js';

// --- Middleware (for adopters mounting into an existing express app) ---
export { createAuthMiddleware, authHeaders } from './middleware/auth.js';
export { createJournalValidator, validateEntry } from './middleware/journal-validator.js';
export { createRateLimiter } from './middleware/rate-limit.js';

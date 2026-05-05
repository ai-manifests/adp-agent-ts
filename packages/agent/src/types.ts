// --- ADP types ---

export type Vote = 'approve' | 'reject' | 'abstain';
export type ReversibilityTier = 'reversible' | 'partially_reversible' | 'irreversible';
export type StakeMagnitude = 'low' | 'medium' | 'high';
export type TerminationState = 'converged' | 'partial_commit' | 'deadlocked';

export interface DissentCondition {
  id: string;
  condition: string;
  status: 'active' | 'falsified' | 'amended' | 'withdrawn';
  amendments: { round: number; newCondition: string; reason: string; triggeredBy: string }[];
  testedInRound: number | null;
  testedBy: string | null;
}

export interface VoteRevision {
  round: number;
  priorVote: Vote;
  newVote: Vote;
  priorConfidence: number | null;
  newConfidence: number | null;
  reason: string;
  timestamp: string;
}

export interface Proposal {
  proposalId: string;
  deliberationId: string;
  agentId: string;
  timestamp: string;
  action: { kind: string; target: string; parameters?: Record<string, string> };
  vote: Vote;
  confidence: number;
  domainClaim: { domain: string; authoritySource: string };
  reversibilityTier: ReversibilityTier;
  blastRadius: { scope: string[]; estimatedUsersAffected: number; rollbackCostSeconds: number };
  justification: { summary: string; evidenceRefs: string[] };
  stake: { declaredBy: string; magnitude: StakeMagnitude; calibrationAtStake: boolean };
  dissentConditions: DissentCondition[];
  revisions: VoteRevision[];
}

export interface TallyResult {
  approveWeight: number;
  rejectWeight: number;
  abstainWeight: number;
  totalWeight: number;
  approvalFraction: number;
  participationFraction: number;
  thresholdMet: boolean;
  participationFloorMet: boolean;
  converged: boolean;
}

// --- ADJ types ---

export interface CalibrationScore {
  value: number;
  sampleSize: number;
  staleness: number; // ms
}

export interface JournalEntry {
  entryId: string;
  entryType: string;
  deliberationId: string;
  timestamp: string;
  priorEntryHash: string | null;
  [key: string]: unknown;
}

// --- Signed proposal ---

export interface SignedProposal extends Proposal {
  signature: string;
}

// --- Agent manifest ---

export interface AgentManifest {
  agentId: string;
  identity: string;
  complianceLevel: number;
  decisionClasses: string[];
  domainAuthorities: Record<string, { authority: number; source: string }>;
  journalEndpoint: string;
  publicKey: string | null;
  trustLevel?: 'open' | 'registered' | 'attested';
}

// --- Auth config ---

export interface AuthConfig {
  /** This agent's bearer token — peers must send this to call protected endpoints */
  bearerToken: string;
  /** Map of peer agentId → their bearer token (for outgoing requests) */
  peerTokens: Record<string, string>;
  /** Ed25519 private key (hex) for signing proposals */
  privateKey?: string;
  /** Ed25519 public key (hex) served in manifest */
  publicKey?: string;
  /** Allow unsigned proposals from localhost (for testing) */
  allowUnsignedLocal?: boolean;
}

// --- Evaluator config ---

export interface EvaluatorConfig {
  /**
   * - 'static' uses defaultVote/defaultConfidence
   * - 'shell' runs a command and parses its output
   * - 'llm' calls an LLM provider (Anthropic / OpenAI) with structured-output
   *   forcing so the response is guaranteed to be a valid `EvaluationResult`
   */
  kind: 'shell' | 'static' | 'llm';
  /** Shell command to run (for kind: 'shell') */
  command?: string;
  /** Working directory for the command */
  workDir?: string;
  /** Kill the command / abort the LLM request after this many milliseconds */
  timeoutMs?: number;
  /** How to interpret stdout: 'json' parses EvaluationResult, 'exit-code' maps 0=approve/non-zero=reject */
  parseOutput?: 'json' | 'exit-code';
  /** Allowed command prefixes (S8 sandboxing). If set, command must start with one of these. */
  allowedCommands?: string[];

  // --- LLM evaluator fields (kind: 'llm') ---
  /** Which LLM API to call. */
  provider?: 'anthropic' | 'openai';
  /** Provider model id (e.g. `claude-opus-4-7`, `gpt-5`). */
  model?: string;
  /**
   * System prompt — the agent's identity and judging criteria. Stable
   * across actions, so providers may cache it server-side (Anthropic
   * prompt caching is enabled when this is set).
   */
  systemPrompt?: string;
  /**
   * User-message template. The following placeholders are substituted at
   * call time: `{action.kind}`, `{action.target}`, `{action.parameters}`,
   * `{agent.id}`, `{agent.decisionClass}`.
   */
  userTemplate?: string;
  /** Max tokens for the response (default 1024). */
  maxTokens?: number;
  /** Sampling temperature (default 0 — deterministic). */
  temperature?: number;
}

/**
 * Caller-supplied identity context, threaded into LLM evaluator prompts so
 * the same model can act as different agents with different judging criteria.
 */
export interface EvaluatorAgentContext {
  agentId: string;
  decisionClass: string;
}

export interface EvaluationResult {
  vote: Vote;
  confidence: number;
  summary: string;
  evidenceRefs: string[];
  dissentConditions: string[];
}

// --- Peer config (for P2P deliberation) ---

export interface PeerConfig {
  agentId: string;
  url: string;
  transport: 'http' | 'mcp';
}

// --- Plugin config ---

export interface PluginsConfig {
  evaluator?: EvaluatorConfig;
  trigger?: { kind: string; [key: string]: unknown };
  outcome?: { kind: string; [key: string]: unknown };
}

// --- ACB (Agent Cognitive Budget) types ---
// See acb-manifest.dev for the spec. ACB entries follow the ADJ common
// envelope so they can be appended to the same journal as ADJ entries.

export interface AcbDenomination {
  unit: 'EU';
  externalUnit?: string;
  externalRate?: number;
  rateSource?: string;
}

export interface AcbPricingProfile {
  profile: string;
  cheapRoutineRate: number;
  expensiveRoutineRate: number;
  roundMultiplier: number;
  unlockThreshold: number;
  habitMemoryDiscount?: string;
}

export type AcbSettlementMode = 'immediate' | 'deferred' | 'two_phase';

export interface AcbSettlementProfile {
  profile: string;
  mode: AcbSettlementMode;
  outcomeWindowSeconds?: number;
  substrateShare: number;
  epistemicShare: number;
  unspentReturnsTo: string;
}

export interface AcbBudgetConstraints {
  maxParticipants?: number;
  maxRounds?: number;
  irrevocable?: boolean;
}

/**
 * A budget posted by a requester to fund a deliberation. Mirrors the
 * `budget_committed` entry shape from the ACB v0 schema. When attached to
 * a `/api/deliberate` request, the deliberation runner writes it to the
 * journal at deliberation start and produces a settlement record at close.
 */
export interface AcbBudget {
  budgetId: string;
  budgetAuthority: string;
  postedAt?: string;
  denomination: AcbDenomination;
  amountTotal: number;
  pricing: AcbPricingProfile;
  settlement: AcbSettlementProfile;
  constraints?: AcbBudgetConstraints;
  signature: string;
}

export interface AcbContributionBreakdown {
  baseShare: number;
  falsificationBonus: number;
  loadBearingBonus: number;
  outcomeCorrectnessBonus: number;
  dissentQualityPenalty: number;
}

export interface AcbEpistemicDistribution {
  recipient: string;
  amount: number;
  contributionBreakdown?: AcbContributionBreakdown;
}

export interface AcbSubstrateDistribution {
  recipient: string;
  amount: number;
  basis: string;
  reportRef?: string;
}

export interface AcbSubstrateReport {
  recipient: string;
  cycles: number;
  reportRef?: string;
}

/** Default pricing/settlement profile an agent applies when a deliberation
 *  is started with `useDefaultBudget: true` but no explicit budget. */
export interface AcbDefaults {
  amountTotal: number;
  budgetAuthority: string;
  denomination?: AcbDenomination;
  pricing?: Partial<AcbPricingProfile>;
  settlement?: Partial<AcbSettlementProfile>;
}

// --- Calibration anchor (Phase 7 — optional Neo3 chain anchoring) ---

export type CalibrationAnchorTarget =
  | 'mock'         // in-memory, tests only
  | 'neo-express'  // local single-node Neo Express
  | 'neo-custom'   // operator's existing private Neo3 chain
  | 'neo-testnet'  // public Neo N3 testnet
  | 'neo-mainnet'; // public Neo N3 mainnet

/**
 * Optional opt-in: anchor the agent's signed calibration snapshots to a
 * Neo3-compatible blockchain on a schedule. The anchor is the *third-party
 * verifiable, registry-independent* layer on top of the always-on signed
 * snapshots (ADJ §7.4). Signed snapshots are the day-to-day trust mechanism;
 * chain anchoring is the cross-org, cross-chain, survives-agent-disappearance
 * tamper evidence layer for operators that want it.
 *
 * All four `target` values speak the same Neo3 RPC protocol; only `rpcUrl`,
 * `contractHash`, and the signing wallet change between deployments.
 */
export interface CalibrationAnchorConfig {
  enabled: boolean;
  target: CalibrationAnchorTarget;
  /** JSON-RPC endpoint for the chain. Required for any non-mock target. */
  rpcUrl?: string;
  /** Deployed CalibrationStore.cs contract hash, hex with or without 0x. */
  contractHash?: string;
  /** Hex private key for the signer. Loaded from ADP_ANCHOR_PRIVATE_KEY env if absent. */
  privateKey?: string;
  /** Network magic. Auto-selected per target if omitted. */
  networkMagic?: number;
  /** How often to publish the current calibration snapshot, in seconds. Default: 3600. */
  publishIntervalSeconds?: number;
}

// --- Agent config ---

export interface AgentConfig {
  agentId: string;
  port: number;
  domain: string;
  /**
   * Override the URL published as `manifest.journalEndpoint`. By default
   * the manifest publishes `http://{domain}:{port}/adj/v0`, which is
   * correct for peer-to-peer calls inside the same network (where
   * `domain:port` resolves to the agent's listening socket via
   * loopback / hairpin). When the agent sits behind a TLS-terminating
   * proxy (Cloudflare, Caddy, an ingress controller), external peers
   * can't reach the internal port and need the proxy URL instead.
   *
   * Example: an agent listening on `:3001` behind
   * `https://test-runner.adp-federation.dev` should set
   * `publicJournalEndpoint = 'https://test-runner.adp-federation.dev/adj/v0'`
   * so external federations and the registry's calibration audit can
   * reach it. Internal peer calls in the same network keep working
   * because they use `peer.url` from the deliberation runner's peer
   * list — they don't read this field.
   */
  publicJournalEndpoint?: string;
  decisionClasses: string[];
  authorities: Record<string, number>;
  stakeMagnitude: StakeMagnitude;
  defaultVote: Vote;
  defaultConfidence: number;
  dissentConditions: string[];
  /** Map of condition IDs to response when falsification is received */
  falsificationResponses: Record<string, 'acknowledge' | 'reject'>;
  journalDir: string;
  /** Evaluator plugin config (legacy, prefer plugins.evaluator) */
  evaluator?: EvaluatorConfig;
  /** Known peers for P2P deliberation */
  peers?: PeerConfig[];
  /** Whether this agent can initiate deliberations */
  initiator?: boolean;
  /** Plugin configs — the extensible way to configure triggers, outcomes, evaluators */
  plugins?: PluginsConfig;
  /** Authentication and signing config */
  auth?: AuthConfig;
  /** Allowed peer agent IDs (sybil resistance). If set, only these peers can participate. */
  allowedPeers?: string[];
  /** Optional ACB defaults applied when a deliberation requests a self-funded budget */
  acbDefaults?: AcbDefaults;
  /** Optional calibration anchor — periodically commits snapshots to a Neo3 chain */
  calibrationAnchor?: CalibrationAnchorConfig;
}

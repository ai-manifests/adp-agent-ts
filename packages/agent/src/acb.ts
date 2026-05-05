/**
 * ACB (Agent Cognitive Budget) integration for the federation prototype.
 *
 * See acb-manifest.dev for the spec. This module is the in-prototype port of
 * acb-ref-lib-ts: pricing, habit memory, default-v0 contribution scoring, and
 * the settlement record builder. It is intentionally self-contained so the
 * prototype does not need to depend on a not-yet-published npm package.
 *
 * Wired into deliberation.ts so that ACB-aware deliberations:
 *   1. Write a `budget_committed` entry at deliberation open
 *   2. Compute disagreement magnitude on the *initial* tally (before any
 *      belief-update round) and emit it as a `tally_observed` event
 *   3. Track per-agent contribution signals as the deliberation runs
 *   4. Write a `settlement_recorded` entry at deliberation close
 *
 * The contribution tracker is fed by deliberation.ts as it observes
 * proposals, falsification events, acknowledgments, and the final tally.
 */

import type {
  AcbBudget,
  AcbContributionBreakdown,
  AcbDefaults,
  AcbEpistemicDistribution,
  AcbPricingProfile,
  AcbSettlementProfile,
  AcbSubstrateDistribution,
  AcbSubstrateReport,
  JournalEntry,
  Proposal,
  TallyResult,
  TerminationState,
} from './types.js';
import { generateId } from './protocol.js';

// ---------- Default profiles ----------

export const DEFAULT_PRICING: AcbPricingProfile = {
  profile: 'default-v0',
  cheapRoutineRate: 50,
  expensiveRoutineRate: 200,
  roundMultiplier: 1.5,
  unlockThreshold: 0.30,
  habitMemoryDiscount: 'default-v0',
};

export const DEFAULT_SETTLEMENT: AcbSettlementProfile = {
  profile: 'default-v0',
  mode: 'immediate',
  substrateShare: 0.20,
  epistemicShare: 0.80,
  unspentReturnsTo: '',
};

export const MAX_HABIT_DISCOUNT = 0.80;

// ---------- Pricing ----------

export type Routine = 'cheap' | 'expensive';

/**
 * Compute disagreement magnitude from a weighted tally. ACB §5.1.
 *
 *     magnitude = 1 − |approve − reject| / (approve + reject)
 *
 * If non-abstaining weight is 0 (everyone abstained), magnitude is 1.0 —
 * total abstention is treated as maximal disagreement.
 */
export function computeDisagreementMagnitude(tally: TallyResult): number {
  const nonAbstaining = tally.approveWeight + tally.rejectWeight;
  if (nonAbstaining === 0) return 1.0;
  return 1 - Math.abs(tally.approveWeight - tally.rejectWeight) / nonAbstaining;
}

/**
 * Decide which routine applies. ACB §4.1 / §4.2 / §5.2.
 *
 * Cheap MUST apply when ALL of:
 *   - roundCount === 0
 *   - magnitude on initial tally < pricing.unlockThreshold
 *   - termination === 'converged'
 * Expensive otherwise.
 */
export function selectRoutine(
  pricing: AcbPricingProfile,
  initialTally: TallyResult,
  roundCount: number,
  termination: TerminationState,
): Routine {
  if (roundCount > 0) return 'expensive';
  if (termination !== 'converged') return 'expensive';
  const magnitude = computeDisagreementMagnitude(initialTally);
  if (magnitude >= pricing.unlockThreshold) return 'expensive';
  return 'cheap';
}

export function computeCheapDraw(
  pricing: AcbPricingProfile,
  participantCount: number,
  habitDiscount = 0,
): number {
  return pricing.cheapRoutineRate * participantCount * (1 - habitDiscount);
}

export function computeExpensiveDraw(
  pricing: AcbPricingProfile,
  participantCount: number,
  roundCount: number,
  habitDiscount = 0,
): number {
  const base = pricing.expensiveRoutineRate * participantCount;
  return base * Math.pow(pricing.roundMultiplier, roundCount) * (1 - habitDiscount);
}

export function computeDraw(
  pricing: AcbPricingProfile,
  routine: Routine,
  participantCount: number,
  roundCount: number,
  habitDiscount = 0,
): number {
  return routine === 'cheap'
    ? computeCheapDraw(pricing, participantCount, habitDiscount)
    : computeExpensiveDraw(pricing, participantCount, roundCount, habitDiscount);
}

// ---------- Habit memory ----------

export interface HistoricalDeliberation {
  similarity: number;
  successfulOutcome: boolean;
}

/**
 * Compute the habit discount from a list of similar prior deliberations.
 * ACB §7. Capped at MAX_HABIT_DISCOUNT (0.80).
 */
export function computeHabitDiscount(history: HistoricalDeliberation[]): number {
  if (history.length === 0) return 0;
  let weightSum = 0;
  let weightedSuccess = 0;
  let maxSimilarity = 0;
  for (const h of history) {
    weightSum += h.similarity;
    if (h.successfulOutcome) weightedSuccess += h.similarity;
    if (h.similarity > maxSimilarity) maxSimilarity = h.similarity;
  }
  if (weightSum === 0) return 0;
  const stability = weightedSuccess / weightSum;
  return Math.min(MAX_HABIT_DISCOUNT, maxSimilarity * stability);
}

/**
 * Look up similar prior deliberations in a journal directory. Implementations
 * may use embedding similarity, structural match, etc. The default is exact
 * match on `action.kind` plus `action.target` against prior `committed_action`
 * fields in `deliberation_closed` entries.
 */
export function findHabitHistory(
  priorEntries: JournalEntry[],
  action: { kind: string; target: string },
): HistoricalDeliberation[] {
  const closedByDlb = new Map<string, JournalEntry>();
  const outcomeByDlb = new Map<string, JournalEntry>();
  for (const e of priorEntries) {
    if (e.entryType === 'deliberation_closed') {
      closedByDlb.set(e.deliberationId, e);
    } else if (e.entryType === 'outcome_observed') {
      const existing = outcomeByDlb.get(e.deliberationId);
      if (!existing || new Date(e.timestamp as string) > new Date(existing.timestamp as string)) {
        outcomeByDlb.set(e.deliberationId, e);
      }
    }
  }

  const history: HistoricalDeliberation[] = [];
  for (const [dlb, closed] of closedByDlb) {
    const committed = (closed as any).committedAction as { kind?: string; target?: string } | null;
    if (!committed) continue;

    let similarity = 0;
    if (committed.kind === action.kind) {
      similarity = 0.5;
      if (committed.target === action.target) similarity = 1.0;
      else if (committed.target?.split('/')[0] === action.target.split('/')[0]) similarity = 0.85;
    }
    if (similarity === 0) continue;

    const outcome = outcomeByDlb.get(dlb);
    const success = outcome ? Number((outcome as any).success) : 0;
    history.push({ similarity, successfulOutcome: success >= 0.5 });
  }
  return history;
}

// ---------- Contribution tracking ----------

export interface ParticipantContribution {
  agentId: string;
  participated: boolean;
  acknowledgedFalsifications: number;
  loadBearing: boolean;
  outcomeBrierDelta: number | null;
  dissentQualityFlagged: boolean;
}

/**
 * Tracks per-agent contribution signals as a deliberation runs. The
 * deliberation runner calls these methods at well-defined points; the tracker
 * produces the final ParticipantContribution[] used by the settlement
 * pipeline.
 */
export class ContributionTracker {
  private participants = new Set<string>();
  private acknowledged = new Map<string, number>(); // agentId → count
  private flagged = new Set<string>();

  recordProposal(agentId: string): void {
    this.participants.add(agentId);
  }

  /**
   * Record a falsification event from `evidenceAgentId` that targeted
   * `targetAgentId`'s condition `conditionId`. The runner calls this for
   * EACH outgoing `falsification_evidence` event, regardless of acknowledgement.
   */
  recordFalsificationEvidence(_evidenceAgentId: string, _targetAgentId: string, _conditionId: string): void {
    // No-op — counted only when acknowledged below.
  }

  /**
   * Record that `targetAgentId` acknowledged a falsification originated by
   * `evidenceAgentId`. The acknowledged count is what counts toward the
   * default-v0 falsification bonus per ACB §6.2 (unacknowledged falsifications
   * pay zero to discourage spam).
   */
  recordAcknowledgement(evidenceAgentId: string, _targetAgentId: string, _conditionId: string): void {
    this.acknowledged.set(evidenceAgentId, (this.acknowledged.get(evidenceAgentId) ?? 0) + 1);
  }

  flagDissentQuality(agentId: string): void {
    this.flagged.add(agentId);
  }

  /**
   * Build the final per-agent contribution list. `loadBearingAgents` is the
   * set whose votes were load-bearing (removing their weight would have
   * changed the termination state); the runner computes this counterfactually
   * after the final tally. `brierDeltas` is per-agent (confidence − outcome)²
   * when the outcome is known at settlement time.
   */
  build(
    finalTally: TallyResult,
    weights: Record<string, number>,
    threshold: number,
    proposals: Proposal[],
    brierDeltas: Map<string, number>,
  ): ParticipantContribution[] {
    const loadBearing = computeLoadBearingAgents(finalTally, weights, threshold, proposals);

    const contributions: ParticipantContribution[] = [];
    for (const agentId of this.participants) {
      contributions.push({
        agentId,
        participated: true,
        acknowledgedFalsifications: this.acknowledged.get(agentId) ?? 0,
        loadBearing: loadBearing.has(agentId),
        outcomeBrierDelta: brierDeltas.get(agentId) ?? null,
        dissentQualityFlagged: this.flagged.has(agentId),
      });
    }
    return contributions;
  }
}

/**
 * Counterfactual load-bearing computation: an agent's vote is load-bearing if
 * removing their weight from the final tally would have dropped approval
 * fraction below threshold. Only computed for agents whose final vote was
 * `approve` (the load-bearing direction in a converged deliberation).
 */
function computeLoadBearingAgents(
  finalTally: TallyResult,
  weights: Record<string, number>,
  threshold: number,
  proposals: Proposal[],
): Set<string> {
  const loadBearing = new Set<string>();
  if (!finalTally.thresholdMet) return loadBearing;

  for (const p of proposals) {
    const currentVote =
      p.revisions.length > 0 ? p.revisions[p.revisions.length - 1].newVote : p.vote;
    if (currentVote !== 'approve') continue;

    const w = weights[p.agentId] ?? 0;
    if (w === 0) continue;

    const newApprove = finalTally.approveWeight - w;
    const newNonAbstaining = newApprove + finalTally.rejectWeight;
    const newApprovalFraction = newNonAbstaining > 0 ? newApprove / newNonAbstaining : 0;
    if (newApprovalFraction < threshold) loadBearing.add(p.agentId);
  }
  return loadBearing;
}

// ---------- Settlement ----------

export interface SettlementInputs {
  entryId: string;
  deliberationId: string;
  timestamp: string;
  priorEntryHash: string | null;
  budgetId: string;
  amountTotal: number;
  drawTotal: number;
  settlement: AcbSettlementProfile;
  contributions: ParticipantContribution[];
  substrateReports: AcbSubstrateReport[];
  habitDiscountApplied: number;
  unlockTriggered: boolean;
  disagreementMagnitudeInitial: number;
  outcomeReferenced: string | null;
  signature: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function distributeSubstrate(
  pool: number,
  reports: AcbSubstrateReport[],
): AcbSubstrateDistribution[] {
  if (reports.length === 0) return [];
  const total = reports.reduce((s, r) => s + r.cycles, 0);
  if (total === 0) return [];
  return reports.map(r => ({
    recipient: r.recipient,
    amount: round2((pool * r.cycles) / total),
    basis: 'cycles',
    reportRef: r.reportRef,
  }));
}

export function distributeEpistemic(
  pool: number,
  contributions: ParticipantContribution[],
): AcbEpistemicDistribution[] {
  const participants = contributions.filter(c => c.participated);
  if (participants.length === 0) return [];

  const perBonus = pool / 4;
  const equalShare = perBonus / participants.length;

  // Base share — equal across all participants
  const baseShare = equalShare;

  // Falsification bonus — proportional to acknowledged falsifications.
  // If nobody acknowledged any falsification, the pool distributes equally
  // so its share is not lost (preserves draw arithmetic and matches the
  // spec's "100% of epistemic pool" intent).
  const totalFalsifications = participants.reduce((s, c) => s + c.acknowledgedFalsifications, 0);
  const falsFor = (c: ParticipantContribution): number =>
    totalFalsifications === 0
      ? equalShare
      : (perBonus * c.acknowledgedFalsifications) / totalFalsifications;

  // Load-bearing bonus — equal across load-bearing agents. If nobody is
  // load-bearing (e.g. unanimous approval, or weight distribution where
  // removing any single agent still passes threshold), the pool distributes
  // equally across all participants.
  const lbCount = participants.filter(c => c.loadBearing).length;
  const lbFor = (c: ParticipantContribution): number => {
    if (lbCount === 0) return equalShare;
    return c.loadBearing ? perBonus / lbCount : 0;
  };

  // Outcome correctness bonus — inverse Brier delta when outcome is known.
  // If no outcomes are reported (immediate-mode settlement, no outcome yet),
  // the pool distributes equally.
  const withOutcomes = participants.filter(c => c.outcomeBrierDelta != null);
  const totalInverse = withOutcomes.reduce((s, c) => s + (1 - (c.outcomeBrierDelta ?? 0)), 0);
  const outcomeFor = (c: ParticipantContribution): number => {
    if (withOutcomes.length === 0 || totalInverse === 0) return equalShare;
    if (c.outcomeBrierDelta == null) return 0;
    return (perBonus * (1 - c.outcomeBrierDelta)) / totalInverse;
  };

  const pre = participants.map(c => {
    const breakdown: AcbContributionBreakdown = {
      baseShare,
      falsificationBonus: falsFor(c),
      loadBearingBonus: lbFor(c),
      outcomeCorrectnessBonus: outcomeFor(c),
      dissentQualityPenalty: 0,
    };
    const preTotal =
      breakdown.baseShare
      + breakdown.falsificationBonus
      + breakdown.loadBearingBonus
      + breakdown.outcomeCorrectnessBonus;
    return { agent: c.agentId, breakdown, preTotal, flagged: c.dissentQualityFlagged };
  });

  let recovered = 0;
  for (const r of pre) {
    if (r.flagged) {
      const penalty = r.preTotal * 0.25;
      r.breakdown = { ...r.breakdown, dissentQualityPenalty: penalty };
      recovered += penalty;
    }
  }
  if (recovered > 0) {
    const nonFlagged = pre.filter(r => !r.flagged);
    const nonFlaggedTotal = nonFlagged.reduce((s, r) => s + r.preTotal, 0);
    if (nonFlaggedTotal > 0) {
      for (const r of nonFlagged) {
        const share = (recovered * r.preTotal) / nonFlaggedTotal;
        r.breakdown = { ...r.breakdown, baseShare: r.breakdown.baseShare + share };
      }
    }
  }

  return pre.map(r => ({
    recipient: r.agent,
    amount: round2(
      r.breakdown.baseShare
      + r.breakdown.falsificationBonus
      + r.breakdown.loadBearingBonus
      + r.breakdown.outcomeCorrectnessBonus
      - r.breakdown.dissentQualityPenalty,
    ),
    contributionBreakdown: {
      baseShare: round2(r.breakdown.baseShare),
      falsificationBonus: round2(r.breakdown.falsificationBonus),
      loadBearingBonus: round2(r.breakdown.loadBearingBonus),
      outcomeCorrectnessBonus: round2(r.breakdown.outcomeCorrectnessBonus),
      dissentQualityPenalty: round2(r.breakdown.dissentQualityPenalty),
    },
  }));
}

/**
 * Build a `settlement_recorded` journal entry from the inputs by running the
 * default-v0 distribution pipeline. The result follows the ADJ common
 * envelope so it can be appended to the same journal as ADJ entries.
 */
export function buildSettlementRecord(inputs: SettlementInputs): JournalEntry {
  let substratePool = inputs.drawTotal * inputs.settlement.substrateShare;
  let epistemicPool = inputs.drawTotal * inputs.settlement.epistemicShare;

  let substrateDistributions = distributeSubstrate(substratePool, inputs.substrateReports);
  if (substrateDistributions.length === 0 && substratePool > 0) {
    // ACB §6.3: fold unallocated substrate share into epistemic pool.
    epistemicPool += substratePool;
    substratePool = 0;
    substrateDistributions = [];
  }

  const epistemicDistributions = distributeEpistemic(epistemicPool, inputs.contributions);

  return {
    entryId: inputs.entryId,
    entryType: 'settlement_recorded',
    deliberationId: inputs.deliberationId,
    timestamp: inputs.timestamp,
    priorEntryHash: inputs.priorEntryHash,
    budgetId: inputs.budgetId,
    settlementProfile: inputs.settlement.profile,
    outcomeReferenced: inputs.outcomeReferenced,
    drawTotal: round2(inputs.drawTotal),
    amountTotal: inputs.amountTotal,
    amountReturnedToRequester: round2(inputs.amountTotal - inputs.drawTotal),
    substrateDistributions,
    epistemicDistributions,
    habitDiscountApplied: inputs.habitDiscountApplied,
    unlockTriggered: inputs.unlockTriggered,
    disagreementMagnitudeInitial: inputs.disagreementMagnitudeInitial,
    signature: inputs.signature,
  };
}

// ---------- Budget construction ----------

/**
 * Build a `budget_committed` journal entry from an AcbBudget object, ready
 * to append to the journal at deliberation start.
 */
export function buildBudgetCommittedEntry(budget: AcbBudget, deliberationId: string): JournalEntry {
  return {
    entryId: generateId('adj'),
    entryType: 'budget_committed',
    deliberationId,
    timestamp: new Date().toISOString(),
    priorEntryHash: null,
    budgetId: budget.budgetId,
    budgetAuthority: budget.budgetAuthority,
    postedAt: budget.postedAt ?? new Date().toISOString(),
    denomination: budget.denomination,
    amountTotal: budget.amountTotal,
    pricing: budget.pricing,
    settlement: budget.settlement,
    constraints: budget.constraints,
    signature: budget.signature,
  };
}

/**
 * Materialize a full AcbBudget from the agent's defaults. Used when a
 * deliberation is initiated with `useDefaultBudget: true` (e.g. from a
 * webhook trigger that doesn't carry its own budget).
 */
export function budgetFromDefaults(defaults: AcbDefaults): AcbBudget {
  const pricing: AcbPricingProfile = { ...DEFAULT_PRICING, ...defaults.pricing };
  const settlement: AcbSettlementProfile = {
    ...DEFAULT_SETTLEMENT,
    unspentReturnsTo: defaults.budgetAuthority,
    ...defaults.settlement,
  };
  return {
    budgetId: generateId('bgt'),
    budgetAuthority: defaults.budgetAuthority,
    postedAt: new Date().toISOString(),
    denomination: defaults.denomination ?? { unit: 'EU' },
    amountTotal: defaults.amountTotal,
    pricing,
    settlement,
    signature: 'self',
  };
}

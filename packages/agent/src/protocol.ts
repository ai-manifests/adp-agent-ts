import type { CalibrationScore, Proposal, StakeMagnitude, TallyResult, ReversibilityTier, TerminationState, JournalEntry } from './types.js';

// --- Weighting (ADP §4) ---

const HALF_LIVES: Record<string, number> = {
  'code.correctness': 180, 'security.policy': 90,
  'api.compatibility': 30, 'code.style': 365,
};

export function computeWeight(authority: number, cal: CalibrationScore, decisionClass: string, magnitude: StakeMagnitude): number {
  const stake = magnitude === 'high' ? 1.0 : magnitude === 'medium' ? 0.85 : 0.50;

  // Graceful degradation (ADP §4): when no calibration history exists,
  // weight reduces to authority × stake. This handles bootstrap and the
  // "ADP without ADJ" case.
  if (cal.sampleSize === 0) {
    return authority * stake;
  }

  const effectiveCal = cal.value * (1 - 1 / (1 + cal.sampleSize));
  const hlDays = HALF_LIVES[decisionClass] ?? 90;
  const stalenessDays = cal.staleness / 86_400_000;
  const decay = Math.pow(2, -stalenessDays / hlDays);
  return authority * effectiveCal * decay * stake;
}

// --- Tally (ADP §5) ---

export function computeTally(proposals: Proposal[], weights: Record<string, number>, tier: ReversibilityTier, participationFloor = 0.50, weightCap = 0.35): TallyResult {
  // Compute total weight first for cap calculation
  let rawTotal = 0;
  for (const p of proposals) rawTotal += weights[p.agentId] ?? 0;

  let approve = 0, reject = 0, abstain = 0;
  for (const p of proposals) {
    // Apply weight cap (ADP §5.4): no agent exceeds cap × total weight
    const raw = weights[p.agentId] ?? 0;
    const w = rawTotal > 0 ? Math.min(raw, weightCap * rawTotal) : raw;
    const vote = p.revisions.length > 0 ? p.revisions[p.revisions.length - 1].newVote : p.vote;
    if (vote === 'approve') approve += w;
    else if (vote === 'reject') reject += w;
    else abstain += w;
  }
  const total = approve + reject + abstain;
  const nonAbstaining = approve + reject;
  const approvalFraction = nonAbstaining > 0 ? approve / nonAbstaining : 0;
  const participationFraction = total > 0 ? nonAbstaining / total : 0;
  const threshold = tier === 'irreversible' ? 2 / 3 : tier === 'partially_reversible' ? 0.60 : 0.501;
  const thresholdMet = approvalFraction >= threshold;
  const participationFloorMet = participationFraction >= participationFloor;

  return {
    approveWeight: approve, rejectWeight: reject, abstainWeight: abstain,
    totalWeight: total, approvalFraction, participationFraction,
    thresholdMet, participationFloorMet,
    converged: thresholdMet && participationFloorMet,
  };
}

export function determineTermination(tally: TallyResult, hasReversibleSubset: boolean): TerminationState {
  if (tally.converged) return 'converged';
  return hasReversibleSubset ? 'partial_commit' : 'deadlocked';
}

// --- Brier scoring (ADJ §5) ---

export function computeCalibration(pairs: { confidence: number; outcome: number; timestamp: number }[], now: number): CalibrationScore {
  if (pairs.length === 0) return { value: 0.5, sampleSize: 0, staleness: 0 };
  let sum = 0, mostRecent = 0;
  for (const p of pairs) {
    sum += (p.confidence - p.outcome) ** 2;
    if (p.timestamp > mostRecent) mostRecent = p.timestamp;
  }
  return {
    value: Math.max(0, Math.min(1, 1 - sum / pairs.length)),
    sampleSize: pairs.length,
    staleness: Math.max(0, now - mostRecent),
  };
}

// --- ID generation ---

let counter = 0;
export function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

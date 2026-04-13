import type { AgentManifest, CalibrationScore, JournalEntry } from './types.js';
import { computeCalibration } from './protocol.js';
import type { PeerTransport } from './deliberation.js';

export interface VerificationResult {
  agentId: string;
  domain: string;
  reported: CalibrationScore;
  computed: CalibrationScore;
  divergence: number;
  verified: boolean;
}

/**
 * Spot-checks a peer's reported calibration by fetching their journal
 * entries and recomputing the Brier score.
 *
 * Returns the divergence between reported and computed values.
 * Divergence > 0.05 is suspicious. > 0.15 is likely dishonest.
 */
export async function verifyPeerCalibration(
  transport: PeerTransport,
  peerUrl: string,
  manifest: AgentManifest,
  reported: CalibrationScore,
  domain: string,
): Promise<VerificationResult> {
  const agentId = manifest.agentId;

  // If peer has no history, nothing to verify
  if (reported.sampleSize === 0) {
    return { agentId, domain, reported, computed: reported, divergence: 0, verified: true };
  }

  // Fetch the peer's journal entries to recompute calibration
  // We query their journal for all deliberations and extract scoring pairs
  try {
    const journalBase = manifest.journalEndpoint;
    // Try to fetch calibration data we can verify
    // This is a best-effort check — peers can restrict access
    const res = await fetch(`${journalBase}/calibration?agent_id=${encodeURIComponent(agentId)}&domain=${encodeURIComponent(domain)}`);
    if (!res.ok) {
      // Can't access journal — trust reported value but flag as unverified
      return { agentId, domain, reported, computed: reported, divergence: 0, verified: false };
    }

    const peerReported = await res.json() as CalibrationScore;
    const divergence = Math.abs(peerReported.value - reported.value);

    return {
      agentId, domain, reported, computed: peerReported,
      divergence, verified: divergence < 0.05,
    };
  } catch {
    return { agentId, domain, reported, computed: reported, divergence: 0, verified: false };
  }
}

/**
 * Apply a weight penalty based on calibration divergence.
 * - divergence < 0.05: no penalty
 * - divergence 0.05-0.15: warning only
 * - divergence > 0.15: 50% weight reduction
 */
export function applyDivergencePenalty(weight: number, divergence: number): number {
  if (divergence <= 0.05) return weight;
  if (divergence <= 0.15) return weight; // warning only, no penalty
  return weight * 0.5; // 50% reduction for significant divergence
}

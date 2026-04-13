/**
 * Signed calibration snapshots — ADJ §7.4.
 *
 * Agents at L3 publish a signed summary of their current calibration state
 * at /.well-known/adp-calibration.json. The file is per-agent and contains
 * one signed snapshot per decision class the agent claims authority over.
 *
 * This is the cross-org trust mechanism that doesn't require peers to walk
 * the full journal: one HTTPS fetch + one signature check, and the peer
 * knows the calibration value is what the agent attests to, bound to a
 * specific journal state via the journal hash.
 */

import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import type { JournalEntry } from './types.js';
import './signing.js'; // ensures ed.etc.sha512Sync is installed

export interface CalibrationSnapshot {
  domain: string;
  calibrationValue: number;
  sampleSize: number;
  journalHash: string;
  computedAt: string;
  signature: string;
}

export interface CalibrationSnapshotEnvelope {
  agentId: string;
  publicKey: string;
  computedAt: string;
  snapshots: CalibrationSnapshot[];
}

/**
 * A single (confidence, outcome, deliberationId) tuple used to compute a
 * calibration value. The journal hash is computed over these in
 * outcome-timestamp order.
 */
export interface ScoringPair {
  deliberationId: string;
  confidence: number;
  outcome: number; // 0..1
  outcomeTimestamp: number; // epoch ms
}

/**
 * Canonical pair encoding used in the journal hash. Matches the
 * adp-registry CalibrationAuditService format so agent and registry
 * hashes align directly for divergence detection.
 */
function canonicalPair(p: ScoringPair): string {
  return `${p.deliberationId}:${p.confidence}:${p.outcome}|`;
}

/**
 * Compute the journal hash over a set of scoring pairs.
 * Deterministic: pairs are sorted by outcome timestamp (ascending) before
 * hashing. Hex-encoded SHA-256 of the concatenated canonical pair strings.
 */
export function computeJournalHash(pairs: ScoringPair[]): string {
  const sorted = [...pairs].sort((a, b) => a.outcomeTimestamp - b.outcomeTimestamp);
  const h = createHash('sha256');
  for (const p of sorted) h.update(canonicalPair(p));
  return h.digest('hex');
}

/**
 * The canonical string signed for a single snapshot. Minimal format chosen
 * so agents and verifiers can build it without a JSON canonicalization
 * library. ADJ §7.4.
 *
 *   <agentId>|<domain>|<calibrationValue>|<sampleSize>|<journalHash>|<computedAt>
 *
 * calibrationValue is fixed to 4 decimal places to match the Brier score
 * precision the rest of the stack uses.
 */
export function canonicalSnapshotMessage(
  agentId: string,
  snapshot: Pick<CalibrationSnapshot, 'domain' | 'calibrationValue' | 'sampleSize' | 'journalHash' | 'computedAt'>,
): string {
  const value = snapshot.calibrationValue.toFixed(4);
  return `${agentId}|${snapshot.domain}|${value}|${snapshot.sampleSize}|${snapshot.journalHash}|${snapshot.computedAt}`;
}

/**
 * Sign a single snapshot with the agent's Ed25519 private key.
 * Returns the hex-encoded signature.
 */
export async function signSnapshot(
  agentId: string,
  snapshot: Omit<CalibrationSnapshot, 'signature'>,
  privateKeyHex: string,
): Promise<string> {
  const message = new TextEncoder().encode(canonicalSnapshotMessage(agentId, snapshot));
  const privateKey = Buffer.from(privateKeyHex, 'hex');
  const signature = await ed.signAsync(message, privateKey);
  return Buffer.from(signature).toString('hex');
}

/**
 * Verify a single snapshot's signature against a public key.
 */
export async function verifySnapshot(
  agentId: string,
  snapshot: CalibrationSnapshot,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const message = new TextEncoder().encode(canonicalSnapshotMessage(agentId, snapshot));
    const signature = Buffer.from(snapshot.signature, 'hex');
    const publicKey = Buffer.from(publicKeyHex, 'hex');
    return await ed.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Extract scoring pairs for a given (agentId, domain) pair from the
 * full set of journal entries across the agent's history. Matches the
 * same filter the JsonlJournal and adp-registry use internally.
 */
export function extractScoringPairs(
  entries: JournalEntry[],
  agentId: string,
  domain: string,
): ScoringPair[] {
  const proposals = entries.filter(e =>
    e.entryType === 'proposal_emitted'
    && (e as any).proposal?.agentId === agentId
    && (e as any).proposal?.domain === domain
    && (e as any).proposal?.calibrationAtStake === true,
  );

  // Most-recent outcome per deliberation (honors supersedes)
  const outcomeByDlb = new Map<string, JournalEntry>();
  for (const e of entries) {
    if (e.entryType !== 'outcome_observed') continue;
    const existing = outcomeByDlb.get(e.deliberationId as string);
    if (!existing || new Date(e.timestamp as string) > new Date(existing.timestamp as string)) {
      outcomeByDlb.set(e.deliberationId as string, e);
    }
  }

  const pairs: ScoringPair[] = [];
  for (const p of proposals) {
    const outcome = outcomeByDlb.get(p.deliberationId);
    if (!outcome) continue;
    const raw = (outcome as any).success;
    const outcomeValue = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw);
    if (!Number.isFinite(outcomeValue)) continue;
    const outcomeTs = new Date((outcome as any).observedAt || (outcome as any).timestamp).getTime();
    pairs.push({
      deliberationId: p.deliberationId,
      confidence: (p as any).proposal.confidence,
      outcome: outcomeValue,
      outcomeTimestamp: Number.isFinite(outcomeTs) ? outcomeTs : Date.now(),
    });
  }
  return pairs;
}

/**
 * Compute a calibration value from a set of scoring pairs using the Brier
 * score. Clamped to [0, 1] and rounded to 4 decimal places to match the
 * canonicalSnapshotMessage precision.
 */
function computeCalibrationValue(pairs: ScoringPair[]): number {
  if (pairs.length === 0) return 0.5;
  let brierSum = 0;
  for (const p of pairs) {
    const diff = p.confidence - p.outcome;
    brierSum += diff * diff;
  }
  const brier = brierSum / pairs.length;
  const value = Math.max(0, Math.min(1, 1 - brier));
  return Math.round(value * 10000) / 10000;
}

/**
 * Build a single (unsigned) snapshot for an (agentId, domain) pair from the
 * given journal entries. The caller signs it separately.
 */
export function buildSnapshot(
  agentId: string,
  domain: string,
  entries: JournalEntry[],
  now: Date = new Date(),
): Omit<CalibrationSnapshot, 'signature'> {
  const pairs = extractScoringPairs(entries, agentId, domain);
  return {
    domain,
    calibrationValue: computeCalibrationValue(pairs),
    sampleSize: pairs.length,
    journalHash: computeJournalHash(pairs),
    computedAt: now.toISOString(),
  };
}

/**
 * Build a complete signed envelope for an agent covering every domain in
 * `domains`. Each snapshot is signed independently.
 */
export async function buildSignedEnvelope(params: {
  agentId: string;
  publicKey: string;
  privateKey: string;
  domains: string[];
  entries: JournalEntry[];
  now?: Date;
}): Promise<CalibrationSnapshotEnvelope> {
  const now = params.now ?? new Date();
  const snapshots: CalibrationSnapshot[] = [];
  for (const domain of params.domains) {
    const unsigned = buildSnapshot(params.agentId, domain, params.entries, now);
    const signature = await signSnapshot(params.agentId, unsigned, params.privateKey);
    snapshots.push({ ...unsigned, signature });
  }
  return {
    agentId: params.agentId,
    publicKey: params.publicKey,
    computedAt: now.toISOString(),
    snapshots,
  };
}

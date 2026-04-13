import { createHash } from 'node:crypto';
import type { CalibrationRecord, BlockchainCalibrationStore } from './blockchain.js';
import type { JournalEntry } from '@ai-manifests/adp-agent';
import { computeCalibration } from '@ai-manifests/adp-agent';

/**
 * In-memory mock blockchain store for development and testing.
 * Stores records in a Map. No persistence, no real chain.
 */
export class MockBlockchainStore implements BlockchainCalibrationStore {
  private records = new Map<string, CalibrationRecord>();
  private txCounter = 0;

  private key(agentId: string, domain: string): string {
    return `${agentId}:${domain}`;
  }

  async getCalibration(agentId: string, domain: string): Promise<CalibrationRecord | null> {
    return this.records.get(this.key(agentId, domain)) ?? null;
  }

  async publishCalibration(record: CalibrationRecord): Promise<string> {
    this.records.set(this.key(record.agentId, record.domain), record);
    return `mock_tx_${++this.txCounter}`;
  }

  verify(record: CalibrationRecord, journalEntries: JournalEntry[]): boolean {
    // Recompute calibration from journal entries and compare
    const proposals = journalEntries.filter(e =>
      e.entryType === 'proposal_emitted' &&
      (e as any).proposal?.agentId === record.agentId &&
      (e as any).proposal?.domain === record.domain &&
      (e as any).proposal?.calibrationAtStake
    );

    const outcomes = new Map<string, any>();
    for (const e of journalEntries) {
      if (e.entryType === 'outcome_observed') {
        outcomes.set(e.deliberationId, e);
      }
    }

    const pairs: { confidence: number; outcome: number; timestamp: number }[] = [];
    for (const p of proposals) {
      const o = outcomes.get(p.deliberationId);
      if (o) {
        pairs.push({
          confidence: (p as any).proposal.confidence,
          outcome: typeof (o as any).success === 'boolean' ? ((o as any).success ? 1 : 0) : (o as any).success,
          timestamp: new Date((o as any).observedAt || o.timestamp).getTime(),
        });
      }
    }

    if (pairs.length === 0 && record.sampleSize === 0) return true;

    const computed = computeCalibration(pairs, Date.now());

    // Allow small floating point difference
    return Math.abs(computed.value - record.value) < 0.01 &&
           computed.sampleSize === record.sampleSize;
  }

  /** Compute journal hash for a set of entries. */
  static computeJournalHash(entries: JournalEntry[]): string {
    const h = createHash('sha256');
    for (const e of entries) {
      h.update(JSON.stringify(e));
    }
    return h.digest('hex');
  }
}

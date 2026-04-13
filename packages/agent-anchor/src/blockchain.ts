import type { JournalEntry } from 'adp-agent';

/**
 * A calibration record stored on-chain.
 */
export interface CalibrationRecord {
  agentId: string;
  domain: string;
  value: number;       // [0, 1]
  sampleSize: number;
  timestamp: number;   // epoch ms
  journalHash: string; // hash of journal entries backing this score
}

/**
 * Pluggable blockchain calibration store.
 * Implementations: mock (dev), Neo3 (primary), Solana (secondary).
 *
 * The blockchain is a cache for cross-org trust, not the primary store.
 * Per-agent journals remain authoritative. The blockchain provides
 * bootstrapping and tamper-evident publication.
 */
export interface BlockchainCalibrationStore {
  /** Fetch calibration for an agent from the chain. Null if not found. */
  getCalibration(agentId: string, domain: string): Promise<CalibrationRecord | null>;

  /** Publish current calibration to the chain. Returns transaction hash. */
  publishCalibration(record: CalibrationRecord): Promise<string>;

  /** Verify that an on-chain record matches a journal replay. */
  verify(record: CalibrationRecord, journalEntries: JournalEntry[]): boolean;
}

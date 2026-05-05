import Database from 'better-sqlite3';
import type { JournalEntry, CalibrationScore } from './types.js';
import type { JournalStore, DeliberationRecord } from './journal.js';
import { computeCalibration } from './protocol.js';

/**
 * SQLite-backed journal store. Production-grade: concurrent reads,
 * indexed queries, atomic batch writes, WAL mode.
 */
export class SqliteJournal implements JournalStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        entry_id TEXT PRIMARY KEY,
        entry_type TEXT NOT NULL,
        deliberation_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        prior_entry_hash TEXT,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deliberation ON entries(deliberation_id);
      CREATE INDEX IF NOT EXISTS idx_type ON entries(entry_type);
    `);
  }

  append(entry: JournalEntry): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO entries (entry_id, entry_type, deliberation_id, timestamp, prior_entry_hash, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(entry.entryId, entry.entryType, entry.deliberationId, entry.timestamp, entry.priorEntryHash, JSON.stringify(entry));
  }

  appendBatch(entries: JournalEntry[]): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO entries (entry_id, entry_type, deliberation_id, timestamp, prior_entry_hash, data) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const tx = this.db.transaction((entries: JournalEntry[]) => {
      for (const e of entries) {
        insert.run(e.entryId, e.entryType, e.deliberationId, e.timestamp, e.priorEntryHash, JSON.stringify(e));
      }
    });
    tx(entries);
  }

  getDeliberation(deliberationId: string): JournalEntry[] {
    const rows = this.db.prepare(
      'SELECT data FROM entries WHERE deliberation_id = ? ORDER BY timestamp'
    ).all(deliberationId) as { data: string }[];
    return rows.map(r => JSON.parse(r.data));
  }

  getOutcome(deliberationId: string): JournalEntry | null {
    const row = this.db.prepare(
      "SELECT data FROM entries WHERE deliberation_id = ? AND entry_type = 'outcome_observed' ORDER BY timestamp DESC LIMIT 1"
    ).get(deliberationId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  getCalibration(agentId: string, domain: string): CalibrationScore {
    // Find all proposal_emitted entries for this agent+domain with calibration_at_stake
    const proposals = this.db.prepare(
      "SELECT data, deliberation_id FROM entries WHERE entry_type = 'proposal_emitted'"
    ).all() as { data: string; deliberation_id: string }[];

    const matchingDlbs: { confidence: number; dlbId: string }[] = [];
    for (const row of proposals) {
      const entry = JSON.parse(row.data);
      if (entry.proposal?.agentId === agentId &&
          entry.proposal?.domain === domain &&
          entry.proposal?.calibrationAtStake) {
        matchingDlbs.push({ confidence: entry.proposal.confidence, dlbId: row.deliberation_id });
      }
    }

    const pairs: { confidence: number; outcome: number; timestamp: number }[] = [];
    for (const { confidence, dlbId } of matchingDlbs) {
      const outcomeRow = this.db.prepare(
        "SELECT data FROM entries WHERE deliberation_id = ? AND entry_type = 'outcome_observed' ORDER BY timestamp DESC LIMIT 1"
      ).get(dlbId) as { data: string } | undefined;

      if (outcomeRow) {
        const outcome = JSON.parse(outcomeRow.data);
        pairs.push({
          confidence,
          outcome: typeof outcome.success === 'boolean' ? (outcome.success ? 1 : 0) : outcome.success,
          timestamp: new Date(outcome.observedAt || outcome.timestamp).getTime(),
        });
      }
    }

    return computeCalibration(pairs, Date.now());
  }

  /**
   * Batch query for federation-level aggregators. Finds every deliberation
   * whose deliberation_closed entry has timestamp >= since, sorted
   * newest-first, and returns full records. ADJ spec §7.1.
   */
  listDeliberationsSince(since: Date, limit: number): DeliberationRecord[] {
    const sinceIso = since.toISOString();
    const closeRows = this.db.prepare(`
      SELECT deliberation_id, timestamp
      FROM entries
      WHERE entry_type = 'deliberation_closed' AND timestamp >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(sinceIso, Math.max(0, limit)) as { deliberation_id: string; timestamp: string }[];

    const records: DeliberationRecord[] = [];
    const selectEntries = this.db.prepare(
      'SELECT data FROM entries WHERE deliberation_id = ? ORDER BY timestamp'
    );
    for (const row of closeRows) {
      const dataRows = selectEntries.all(row.deliberation_id) as { data: string }[];
      records.push({
        deliberationId: row.deliberation_id,
        entries: dataRows.map(r => JSON.parse(r.data)),
      });
    }
    return records;
  }

  close(): void {
    this.db.close();
  }
}

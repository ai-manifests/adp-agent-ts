import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import type { JournalEntry, CalibrationScore } from './types.js';
import { computeCalibration } from './protocol.js';

/**
 * Batch deliberation record — one entry of the listDeliberationsSince response.
 */
export interface DeliberationRecord {
  deliberationId: string;
  entries: JournalEntry[];
}

/**
 * Abstract journal store interface. Implementations: JsonlJournal, SqliteJournal.
 */
export interface JournalStore {
  append(entry: JournalEntry): void;
  appendBatch(entries: JournalEntry[]): void;
  getDeliberation(deliberationId: string): JournalEntry[];
  getOutcome(deliberationId: string): JournalEntry | null;
  getCalibration(agentId: string, domain: string): CalibrationScore;
  /**
   * Batch query — return full deliberation records for every deliberation
   * whose `deliberation_closed` entry has a timestamp at or after `since`,
   * ordered newest-first by close timestamp. Deliberations that have not
   * yet closed are excluded. See ADJ spec §7.1 `listDeliberationsSince`.
   */
  listDeliberationsSince(since: Date, limit: number): DeliberationRecord[];
}

/**
 * JSONL-backed journal store. L3 compliant — append-only, serves calibration.
 * Each deliberation gets its own file. PostMortem-compatible shape.
 */
export class JsonlJournal implements JournalStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  append(entry: JournalEntry): void {
    const file = join(this.dir, `${entry.deliberationId}.jsonl`);
    appendFileSync(file, JSON.stringify(entry) + '\n');
  }

  appendBatch(entries: JournalEntry[]): void {
    for (const e of entries) this.append(e);
  }

  getDeliberation(deliberationId: string): JournalEntry[] {
    const file = join(this.dir, `${deliberationId}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8')
      .split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  }

  getOutcome(deliberationId: string): JournalEntry | null {
    const entries = this.getDeliberation(deliberationId);
    const outcomes = entries.filter(e => e.entryType === 'outcome_observed');
    return outcomes.length > 0
      ? outcomes.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0]
      : null;
  }

  getCalibration(agentId: string, domain: string): CalibrationScore {
    return computeCalibration(this.getScoringPairs(agentId, domain), Date.now());
  }

  /**
   * List all deliberation IDs the journal knows about. Used by ACB habit
   * memory lookups so the runner can find similar prior decisions.
   */
  listDeliberations(): string[] {
    try {
      return readdirSync(this.dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace(/\.jsonl$/, ''));
    } catch {
      return [];
    }
  }

  /**
   * Batch query for federation-level aggregators. Walks the journal
   * directory, filters to deliberations closed at or after `since`, and
   * returns full records sorted newest-first. See ADJ spec §7.1.
   *
   * Open deliberations (no `deliberation_closed` entry) are excluded —
   * the spec defines the window by close time, not open time.
   */
  listDeliberationsSince(since: Date, limit: number): DeliberationRecord[] {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter(f => f.endsWith('.jsonl'));
    } catch {
      return [];
    }

    const cutoff = since.getTime();
    const candidates: { record: DeliberationRecord; closedAt: number }[] = [];

    for (const file of files) {
      let entries: JournalEntry[];
      try {
        entries = readFileSync(join(this.dir, file), 'utf-8')
          .split('\n')
          .filter(l => l.trim())
          .map(l => JSON.parse(l));
      } catch {
        continue;
      }
      if (entries.length === 0) continue;

      const closed = entries.find(e => e.entryType === 'deliberation_closed');
      if (!closed) continue; // open deliberations excluded

      const closedAt = new Date(closed.timestamp as string).getTime();
      if (isNaN(closedAt) || closedAt < cutoff) continue;

      const deliberationId = (entries[0].deliberationId as string) || file.replace(/\.jsonl$/, '');
      candidates.push({ record: { deliberationId, entries }, closedAt });
    }

    candidates.sort((a, b) => b.closedAt - a.closedAt);
    return candidates.slice(0, Math.max(0, limit)).map(c => c.record);
  }

  private getScoringPairs(agentId: string, domain: string) {
    let files: string[];
    try { files = readdirSync(this.dir).filter(f => f.endsWith('.jsonl')); }
    catch { return []; }

    const pairs: { confidence: number; outcome: number; timestamp: number }[] = [];
    for (const file of files) {
      const entries: JournalEntry[] = readFileSync(join(this.dir, file), 'utf-8')
        .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

      const proposal = entries.find(e =>
        e.entryType === 'proposal_emitted' &&
        (e as any).proposal?.agentId === agentId &&
        (e as any).proposal?.domain === domain &&
        (e as any).proposal?.calibrationAtStake === true
      );
      const outcomes = entries.filter(e => e.entryType === 'outcome_observed')
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      if (proposal && outcomes.length > 0) {
        const outcome = outcomes[0] as any;
        pairs.push({
          confidence: (proposal as any).proposal.confidence,
          outcome: typeof outcome.success === 'boolean' ? (outcome.success ? 1 : 0) : outcome.success,
          timestamp: new Date(outcome.observedAt || outcome.timestamp).getTime(),
        });
      }
    }
    return pairs;
  }
}

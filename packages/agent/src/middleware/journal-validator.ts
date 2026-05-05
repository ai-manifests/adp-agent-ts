import type { Request, Response, NextFunction } from 'express';
import type { JournalEntry } from '../types.js';

const VALID_ENTRY_TYPES = new Set([
  // ADJ v0
  'deliberation_opened', 'proposal_emitted', 'round_event',
  'deliberation_closed', 'outcome_observed',
  // ACB v0 hook entries (acb-manifest.dev) — ADJ v0.1 adopts these
  'budget_committed', 'budget_cancelled', 'settlement_recorded',
]);

const MAX_ENTRY_SIZE = 1024 * 1024; // 1MB per entry

/**
 * Validates a single journal entry against basic schema rules.
 * Returns an error string or null if valid.
 */
function validateEntry(entry: any): string | null {
  if (!entry || typeof entry !== 'object') return 'Entry must be an object';
  if (typeof entry.entryId !== 'string' || !entry.entryId.startsWith('adj_'))
    return `Invalid entryId: must start with 'adj_' (got '${entry.entryId}')`;
  if (!VALID_ENTRY_TYPES.has(entry.entryType))
    return `Invalid entryType: '${entry.entryType}'. Must be one of: ${[...VALID_ENTRY_TYPES].join(', ')}`;
  if (typeof entry.deliberationId !== 'string' || !entry.deliberationId.startsWith('dlb_'))
    return `Invalid deliberationId: must start with 'dlb_' (got '${entry.deliberationId}')`;
  if (typeof entry.timestamp !== 'string')
    return 'Missing or invalid timestamp';

  // Type-specific validation
  if (entry.entryType === 'proposal_emitted') {
    if (!entry.proposal || typeof entry.proposal !== 'object')
      return 'proposal_emitted must include a proposal object';
    if (typeof entry.proposal.agentId !== 'string')
      return 'proposal.agentId is required';
    if (typeof entry.proposal.confidence !== 'number' || entry.proposal.confidence < 0 || entry.proposal.confidence > 1)
      return 'proposal.confidence must be a number in [0, 1]';
  }

  if (entry.entryType === 'outcome_observed') {
    if (entry.success === undefined || entry.success === null)
      return 'outcome_observed must include success';
    const s = entry.success;
    if (typeof s === 'boolean') { /* ok */ }
    else if (typeof s === 'number' && (s < 0 || s > 1))
      return 'outcome_observed.success must be boolean or number in [0, 1]';
    if (typeof entry.reporterId !== 'string')
      return 'outcome_observed.reporterId is required';
  }

  if (entry.entryType === 'round_event') {
    // tally_observed (ACB v0.1 hook) is the one event_kind allowed at
    // round 0 — it's the initial-tally signal, computed before any
    // belief-update round runs.
    const minRound = entry.eventKind === 'tally_observed' ? 0 : 1;
    if (typeof entry.round !== 'number' || entry.round < minRound)
      return `round_event.round must be >= ${minRound}`;
    if (typeof entry.agentId !== 'string')
      return 'round_event.agentId is required';
  }

  if (entry.entryType === 'budget_committed') {
    if (typeof entry.budgetId !== 'string' || !entry.budgetId.startsWith('bgt_'))
      return `Invalid budgetId: must start with 'bgt_' (got '${entry.budgetId}')`;
    if (typeof entry.budgetAuthority !== 'string')
      return 'budget_committed.budgetAuthority is required';
    if (typeof entry.amountTotal !== 'number' || entry.amountTotal <= 0)
      return 'budget_committed.amountTotal must be > 0';
    if (!entry.pricing || typeof entry.pricing !== 'object')
      return 'budget_committed.pricing is required';
    if (!entry.settlement || typeof entry.settlement !== 'object')
      return 'budget_committed.settlement is required';
    const sub = Number(entry.settlement.substrateShare ?? 0);
    const epi = Number(entry.settlement.epistemicShare ?? 0);
    if (Math.abs(sub + epi - 1.0) > 0.001)
      return `budget_committed.settlement substrate (${sub}) + epistemic (${epi}) must sum to 1.0`;
  }

  if (entry.entryType === 'settlement_recorded') {
    if (typeof entry.budgetId !== 'string' || !entry.budgetId.startsWith('bgt_'))
      return `Invalid settlement_recorded.budgetId (got '${entry.budgetId}')`;
    const drawTotal = Number(entry.drawTotal ?? 0);
    const amountTotal = Number(entry.amountTotal ?? 0);
    const returned = Number(entry.amountReturnedToRequester ?? 0);
    if (drawTotal > amountTotal + 0.001)
      return `settlement_recorded.drawTotal (${drawTotal}) exceeds amountTotal (${amountTotal})`;
    if (Math.abs(amountTotal - drawTotal - returned) > 0.01)
      return `settlement_recorded.amountReturnedToRequester (${returned}) does not match amountTotal − drawTotal (${(amountTotal - drawTotal).toFixed(2)})`;
  }

  if (entry.entryType === 'budget_cancelled') {
    if (typeof entry.budgetId !== 'string' || !entry.budgetId.startsWith('bgt_'))
      return `Invalid budget_cancelled.budgetId (got '${entry.budgetId}')`;
    if (typeof entry.reason !== 'string')
      return 'budget_cancelled.reason is required';
  }

  // Size check
  if (JSON.stringify(entry).length > MAX_ENTRY_SIZE)
    return `Entry exceeds maximum size of ${MAX_ENTRY_SIZE} bytes`;

  return null;
}

/**
 * Express middleware that validates journal entries before they are stored.
 * Expects req.body to be an array of entries or a single entry.
 */
export function createJournalValidator() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const entries = Array.isArray(req.body) ? req.body : [req.body];
    const errors: string[] = [];

    for (let i = 0; i < entries.length; i++) {
      const error = validateEntry(entries[i]);
      if (error) errors.push(`Entry[${i}]: ${error}`);
    }

    if (errors.length > 0) {
      res.status(400).json({ error: 'Journal validation failed', details: errors });
      return;
    }

    next();
  };
}

export { validateEntry };

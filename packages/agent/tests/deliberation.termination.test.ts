import { describe, it, expect } from 'vitest';
import {
  HttpTransport,
  PeerDeliberation,
  type PeerTransport,
} from '../src/deliberation.js';
import type {
  AgentConfig, AgentManifest, CalibrationScore, JournalEntry,
  PeerConfig, Proposal, TallyResult,
} from '../src/types.js';
import type { JournalStore } from '../src/journal.js';

class MemoryJournal implements JournalStore {
  private entries: JournalEntry[] = [];
  append(entry: JournalEntry): void { this.entries.push(entry); }
  appendAll(entries: JournalEntry[]): void { this.entries.push(...entries); }
  getDeliberation(id: string): JournalEntry[] {
    return this.entries.filter(e => e.deliberationId === id);
  }
  getOutcome(): JournalEntry | null { return null; }
  listDeliberations(): string[] {
    return [...new Set(this.entries.map(e => e.deliberationId))];
  }
  getAllEntries(): JournalEntry[] { return [...this.entries]; }
}

function buildProposal(agentId: string, vote: 'approve' | 'reject' | 'abstain'): Proposal {
  return {
    proposalId: `prp_${agentId}`,
    deliberationId: 'dlb_test',
    agentId,
    timestamp: new Date().toISOString(),
    action: { kind: 'merge_pull_request', target: 'test/test#1' },
    vote,
    confidence: 0.85,
    domainClaim: { domain: 'code.correctness', authoritySource: 'inline:test' },
    reversibilityTier: 'partially_reversible',
    blastRadius: { scope: [], estimatedUsersAffected: 0, rollbackCostSeconds: 0 },
    justification: { summary: '', evidenceRefs: [] },
    stake: { declaredBy: 'self', magnitude: 'high', calibrationAtStake: true },
    dissentConditions: [],
    revisions: [],
  };
}

class StaticTransport implements PeerTransport {
  registered: { url: string; agentId: string }[] = [];
  constructor(
    private manifestForUrl: (url: string) => AgentManifest,
    private proposalForUrl: (url: string) => Proposal,
  ) {}
  registerAgent(peerUrl: string, agentId: string): void {
    this.registered.push({ url: peerUrl, agentId });
  }
  async fetchManifest(peerUrl: string): Promise<AgentManifest> {
    const m = this.manifestForUrl(peerUrl);
    this.registerAgent(peerUrl, m.agentId);
    return m;
  }
  async fetchCalibration(): Promise<CalibrationScore> {
    return { value: 0.5, sampleSize: 0, staleness: 0 };
  }
  async requestProposal(peerUrl: string): Promise<Proposal> {
    return this.proposalForUrl(peerUrl);
  }
  async sendFalsification(): Promise<any> { return { action: 'reject' }; }
  async pushJournalEntries(): Promise<void> {}
}

const SELF_DOMAIN = 'self.test';
const PEER_DOMAIN = 'peer.test';

const SELF_CONFIG: AgentConfig = {
  agentId: 'did:adp:self',
  port: 3001,
  domain: SELF_DOMAIN,
  decisionClasses: ['code.correctness'],
  authorities: { 'code.correctness': 0.9 },
  stakeMagnitude: 'high',
  defaultVote: 'reject',
  defaultConfidence: 0.85,
  dissentConditions: [],
  falsificationResponses: {},
  journalDir: '',
};

const PEER_MANIFEST: AgentManifest = {
  agentId: 'did:adp:peer',
  identity: 'did:web:peer.test',
  complianceLevel: 3,
  decisionClasses: ['code.correctness'],
  domainAuthorities: { 'code.correctness': { authority: 0.6, source: 'inline:peer' } },
  journalEndpoint: 'http://peer.test/adj/v0',
  publicKey: null,
};

describe('PeerDeliberation termination — ADP §7.2 / §7.3', () => {
  it('non-converged outcome defaults to deadlocked (atomic action — no reversible subset)', async () => {
    // Self rejects, peer rejects → no approver to falsify → no path to convergence.
    const transport = new StaticTransport(
      () => PEER_MANIFEST,
      url => buildProposal(url.includes('peer') ? 'did:adp:peer' : 'did:adp:self', 'reject'),
    );
    const dlb = new PeerDeliberation(
      SELF_CONFIG,
      new MemoryJournal(),
      [{ agentId: 'did:adp:peer', url: 'http://peer.test', transport: 'http' }],
      transport,
    );
    const result = await dlb.run({ kind: 'merge_pull_request', target: 'x/y#1' });
    expect(result.status).toBe('deadlocked');
  });

  it('non-converged outcome with hasReversibleSubset=true returns partial_commit', async () => {
    const transport = new StaticTransport(
      () => PEER_MANIFEST,
      url => buildProposal(url.includes('peer') ? 'did:adp:peer' : 'did:adp:self', 'reject'),
    );
    const dlb = new PeerDeliberation(
      SELF_CONFIG,
      new MemoryJournal(),
      [{ agentId: 'did:adp:peer', url: 'http://peer.test', transport: 'http' }],
      transport,
    );
    const result = await dlb.run(
      { kind: 'apply_terraform_plan', target: 'env/prod' },
      'partially_reversible',
      // Pretend the caller verified that a reversible subset exists.
      { hasReversibleSubset: () => true },
    );
    expect(result.status).toBe('partial_commit');
  });

  it('callback receives action and final tally', async () => {
    const transport = new StaticTransport(
      () => PEER_MANIFEST,
      url => buildProposal(url.includes('peer') ? 'did:adp:peer' : 'did:adp:self', 'reject'),
    );
    const dlb = new PeerDeliberation(
      SELF_CONFIG,
      new MemoryJournal(),
      [{ agentId: 'did:adp:peer', url: 'http://peer.test', transport: 'http' }],
      transport,
    );
    let receivedAction: any = null;
    let receivedTally: TallyResult | null = null;
    await dlb.run(
      { kind: 'merge_pull_request', target: 'x/y#1' },
      'partially_reversible',
      {
        hasReversibleSubset: (action, tally) => {
          receivedAction = action;
          receivedTally = tally;
          return false;
        },
      },
    );
    expect(receivedAction?.kind).toBe('merge_pull_request');
    expect(receivedAction?.target).toBe('x/y#1');
    expect(receivedTally).not.toBeNull();
    expect(receivedTally!.converged).toBe(false);
  });
});

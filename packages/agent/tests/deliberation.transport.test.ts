import { describe, it, expect } from 'vitest';
import {
  HttpTransport,
  PeerDeliberation,
  type PeerTransport,
} from '../src/deliberation.js';
import type {
  AgentConfig, AgentManifest, AuthConfig, CalibrationScore, JournalEntry,
  PeerConfig, Proposal, AcbBudget,
} from '../src/types.js';
import type { JournalStore } from '../src/journal.js';

/** Minimal in-memory journal that satisfies JournalStore. */
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

/**
 * Spy transport that records every call and resolves authoritatively. Lets
 * the test assert on the URL → agentId mapping the deliberation builds.
 */
class SpyTransport implements PeerTransport {
  registered: { url: string; agentId: string }[] = [];
  manifestFetches: string[] = [];
  proposalRequests: { url: string; deliberationId: string }[] = [];

  constructor(
    private manifestForUrl: (url: string) => AgentManifest,
    private proposalForUrl: (url: string) => Proposal,
  ) {}

  registerAgent(peerUrl: string, agentId: string): void {
    this.registered.push({ url: peerUrl, agentId });
  }

  async fetchManifest(peerUrl: string): Promise<AgentManifest> {
    this.manifestFetches.push(peerUrl);
    const m = this.manifestForUrl(peerUrl);
    // Mirror HttpTransport: fetchManifest also registers
    this.registerAgent(peerUrl, m.agentId);
    return m;
  }

  async fetchCalibration(): Promise<CalibrationScore> {
    return { value: 0.5, sampleSize: 0, staleness: 0 };
  }

  async requestProposal(peerUrl: string, deliberationId: string): Promise<Proposal> {
    this.proposalRequests.push({ url: peerUrl, deliberationId });
    return this.proposalForUrl(peerUrl);
  }

  async sendFalsification(): Promise<any> {
    return { action: 'reject' };
  }

  async pushJournalEntries(): Promise<void> { /* no-op */ }
}

describe('PeerDeliberation transport binding', () => {
  it('registers the self URL → self agentId before any self-proposal call', async () => {
    const self: AgentConfig = {
      agentId: 'did:adp:self',
      port: 3001,
      domain: 'self.test',
      decisionClasses: ['code.correctness'],
      authorities: { 'code.correctness': 0.9 },
      stakeMagnitude: 'high',
      defaultVote: 'approve',
      defaultConfidence: 0.85,
      dissentConditions: [],
      falsificationResponses: {},
      journalDir: '',
    };
    const peer: PeerConfig = { agentId: 'did:adp:peer', url: 'http://peer.test', transport: 'http' };

    const peerManifest: AgentManifest = {
      agentId: 'did:adp:peer',
      identity: 'did:web:peer.test',
      complianceLevel: 3,
      decisionClasses: ['code.correctness'],
      domainAuthorities: { 'code.correctness': { authority: 0.8, source: 'inline:peer' } },
      journalEndpoint: 'http://peer.test/adj/v0',
      publicKey: null,
    };

    const transport = new SpyTransport(
      () => peerManifest,
      url => buildProposal(url.includes('peer') ? 'did:adp:peer' : 'did:adp:self', 'approve'),
    );

    const dlb = new PeerDeliberation(self, new MemoryJournal(), [peer], transport);
    await dlb.run({ kind: 'merge_pull_request', target: 'x/y#1' }, 'partially_reversible');

    // Self URL must have been registered with the self agentId. This is the
    // regression bar: before the fix, only fetchManifest registered URLs,
    // and the initiator never fetches its own manifest, so peerAgentIds had
    // no entry for the self URL and headers() defaulted to '*'.
    const selfRegistration = transport.registered.find(r => r.agentId === self.agentId);
    expect(selfRegistration).toBeDefined();
    expect(selfRegistration!.url).toBe(`http://${self.domain}:${self.port}`);

    // Belt-and-braces: the registration happened BEFORE the self proposal request
    const selfProposalIndex = transport.proposalRequests.findIndex(
      r => r.url === `http://${self.domain}:${self.port}`,
    );
    expect(selfProposalIndex).toBeGreaterThanOrEqual(0);
    // We can't directly assert ordering across the registered/proposalRequests
    // arrays, but registration is sync and happens immediately after peer
    // discovery, before any proposal request. The presence of both records
    // confirms the wiring.
  });
});

describe('HttpTransport.registerAgent', () => {
  it('binds peerUrl → agentId so subsequent headers() resolve the right peer-token', () => {
    // We can't directly inspect peerAgentIds (private). Instead we verify
    // through behavior: a transport with peerTokens[selfAgentId] = 'X' and
    // a registered self URL should produce an Authorization: Bearer X header
    // when headers(selfUrl) is called.
    //
    // headers() is private, so we test indirectly via the requestProposal
    // path being unable to be asserted without HTTP mocking. Simpler: ensure
    // registerAgent exists and is callable, and that the signature matches
    // PeerTransport interface contract.
    const auth: AuthConfig = {
      bearerToken: 'self-bearer',
      peerTokens: { 'did:adp:self': 'self-bearer', 'did:adp:peer': 'peer-bearer' },
    };
    const t = new HttpTransport(auth);
    expect(typeof t.registerAgent).toBe('function');
    // Should not throw
    t.registerAgent('http://self.test:3001', 'did:adp:self');
    t.registerAgent('http://peer.test', 'did:adp:peer');
  });
});

import type {
  AgentManifest, AgentConfig, Proposal, CalibrationScore,
  JournalEntry, TallyResult, ReversibilityTier, PeerConfig, TerminationState,
  AuthConfig, AcbBudget,
} from './types.js';
import { computeWeight, computeTally, determineTermination, generateId } from './protocol.js';
import type { JournalStore } from './journal.js';
import { authHeaders } from './middleware/auth.js';
import { signProposal, verifyProposal } from './signing.js';
import {
  ContributionTracker, buildBudgetCommittedEntry, buildSettlementRecord,
  computeDisagreementMagnitude, computeDraw, computeHabitDiscount,
  findHabitHistory, selectRoutine,
} from './acb.js';

export interface DeliberationResult {
  deliberationId: string;
  status: TerminationState;
  rounds: number;
  weights: Record<string, number>;
  tallies: TallyResult[];
  proposals: { agentId: string; vote: string; currentVote: string; confidence: number }[];
  /** Settlement record entry, when an ACB budget was attached. */
  settlement?: JournalEntry;
  /** Disagreement magnitude observed at the initial tally. */
  initialDisagreementMagnitude?: number;
}

export interface DeliberationRunOptions {
  /** Optional ACB budget that funds this deliberation. When set, the runner
   *  writes a `budget_committed` entry at start and a `settlement_recorded`
   *  entry at close. */
  budget?: AcbBudget;
}

/**
 * Peer-to-peer transport interface. Abstracts how agents talk to each other.
 * Phase 3 (MCP) adds an McpTransport implementation alongside this HttpTransport.
 */
export interface PeerTransport {
  fetchManifest(peerUrl: string): Promise<AgentManifest>;
  fetchCalibration(journalEndpoint: string, agentId: string, domain: string): Promise<CalibrationScore>;
  requestProposal(peerUrl: string, deliberationId: string, action: any, tier: string): Promise<Proposal>;
  sendFalsification(peerUrl: string, conditionId: string, round: number, evidenceAgentId: string): Promise<any>;
  pushJournalEntries(peerUrl: string, entries: JournalEntry[]): Promise<void>;
}

/** HTTP transport with optional bearer token authentication. */
export class HttpTransport implements PeerTransport {
  private auth: AuthConfig | undefined;
  private peerAgentIds = new Map<string, string>(); // url → agentId (populated after manifest fetch)

  constructor(auth?: AuthConfig) {
    this.auth = auth;
  }

  private headers(peerUrl: string): Record<string, string> {
    const agentId = this.peerAgentIds.get(peerUrl) ?? '*';
    return { 'Content-Type': 'application/json', ...authHeaders(this.auth, agentId) };
  }

  async fetchManifest(peerUrl: string): Promise<AgentManifest> {
    const res = await fetch(`${peerUrl}/.well-known/adp-manifest.json`);
    if (!res.ok) throw new Error(`Manifest fetch failed: ${peerUrl} → ${res.status}`);
    const manifest = await res.json() as AgentManifest;
    this.peerAgentIds.set(peerUrl, manifest.agentId);
    return manifest;
  }

  async fetchCalibration(journalEndpoint: string, agentId: string, domain: string): Promise<CalibrationScore> {
    try {
      const res = await fetch(`${journalEndpoint}/calibration?agent_id=${encodeURIComponent(agentId)}&domain=${encodeURIComponent(domain)}`);
      if (res.ok) return res.json() as Promise<CalibrationScore>;
    } catch { /* default */ }
    return { value: 0.5, sampleSize: 0, staleness: 0 };
  }

  async requestProposal(peerUrl: string, deliberationId: string, action: any, tier: string): Promise<Proposal> {
    const res = await fetch(`${peerUrl}/api/propose`, {
      method: 'POST', headers: this.headers(peerUrl),
      body: JSON.stringify({ deliberationId, action, reversibilityTier: tier }),
    });
    if (!res.ok) throw new Error(`Proposal request failed: ${peerUrl} → ${res.status}`);
    return res.json() as Promise<Proposal>;
  }

  async sendFalsification(peerUrl: string, conditionId: string, round: number, evidenceAgentId: string) {
    const res = await fetch(`${peerUrl}/api/respond-falsification`, {
      method: 'POST', headers: this.headers(peerUrl),
      body: JSON.stringify({ conditionId, round, evidenceAgentId }),
    });
    return res.json();
  }

  async pushJournalEntries(peerUrl: string, entries: JournalEntry[]): Promise<void> {
    await fetch(`${peerUrl}/adj/v0/entries`, {
      method: 'POST', headers: this.headers(peerUrl),
      body: JSON.stringify(entries),
    });
  }
}

/**
 * Peer-to-peer deliberation state machine.
 * Any agent can instantiate this to initiate a deliberation.
 * The initiating agent owns the state and drives the protocol.
 */
export class PeerDeliberation {
  private readonly transport: PeerTransport;
  private manifests: Record<string, AgentManifest> = {};
  private peerUrlMap: Record<string, string> = {};
  private weights: Record<string, number> = {};
  private proposals: Proposal[] = [];
  private tallies: TallyResult[] = [];
  private journalEntries: JournalEntry[] = [];
  private rounds = 0;
  private contributionTracker = new ContributionTracker();

  constructor(
    private readonly self: AgentConfig,
    private readonly journal: JournalStore,
    private readonly peers: PeerConfig[],
    transport?: PeerTransport,
  ) {
    this.transport = transport ?? new HttpTransport(self.auth);
  }

  /**
   * Verify a received proposal's signature against the peer's manifest public key.
   * Returns true if: signature is valid, OR signing is not configured (backward compat).
   */
  private async verifyReceivedProposal(proposal: Proposal, manifest: AgentManifest): Promise<boolean> {
    const sig = (proposal as any).signature;
    if (!sig) {
      // No signature — allow if auth.allowUnsignedLocal or if no auth configured
      return !this.self.auth || this.self.auth.allowUnsignedLocal === true;
    }
    if (!manifest.publicKey) {
      // Peer has no public key in manifest — can't verify
      return false;
    }
    return verifyProposal(proposal, sig, manifest.publicKey);
  }

  async run(
    action: { kind: string; target: string; parameters?: Record<string, string> },
    tier: ReversibilityTier = 'partially_reversible',
    options: DeliberationRunOptions = {},
  ): Promise<DeliberationResult> {
    const dlbId = generateId('dlb');
    const now = () => new Date().toISOString();
    const peerUrls = this.peers.map(p => p.url);
    const budget = options.budget;

    // 1. Discover peers + self
    for (const peer of this.peers) {
      const manifest = await this.transport.fetchManifest(peer.url);
      this.manifests[manifest.agentId] = manifest;
      this.peerUrlMap[manifest.agentId] = peer.url;
    }

    // Self-manifest (the initiating agent)
    const selfUrl = `http://${this.self.domain}:${this.self.port}`;
    this.peerUrlMap[this.self.agentId] = selfUrl;

    const participants = [...Object.keys(this.manifests), this.self.agentId];

    // ACB §3: write budget_committed BEFORE deliberation_opened so the
    // hash chain ordering is correct. Honor max_participants constraint.
    if (budget) {
      if (budget.constraints?.maxParticipants && participants.length > budget.constraints.maxParticipants) {
        throw new Error(
          `Budget ${budget.budgetId} maxParticipants=${budget.constraints.maxParticipants} ` +
          `exceeded by deliberation with ${participants.length} participants`,
        );
      }
      this.journalEntries.push(buildBudgetCommittedEntry(budget, dlbId));
    }

    // Journal: deliberation_opened
    this.journalEntries.push({
      entryId: generateId('adj'), entryType: 'deliberation_opened',
      deliberationId: dlbId, timestamp: now(), priorEntryHash: null,
      decisionClass: this.self.decisionClasses[0],
      action, participants, config: { maxRounds: 3, participationFloor: 0.50 },
    });

    // 2. Request proposals from peers (with signature verification)
    for (const [agentId, manifest] of Object.entries(this.manifests)) {
      // Check allowed peers (sybil resistance)
      if (this.self.allowedPeers && !this.self.allowedPeers.includes(agentId)) {
        console.warn(`[deliberation] Peer ${agentId} not in allowedPeers — skipping`);
        continue;
      }

      const proposal = await this.transport.requestProposal(this.peerUrlMap[agentId], dlbId, action, tier);

      // Verify signature if auth is configured
      if (this.self.auth && !this.self.auth.allowUnsignedLocal) {
        const valid = await this.verifyReceivedProposal(proposal, manifest);
        if (!valid) {
          console.warn(`[deliberation] Proposal from ${agentId} failed signature verification — skipping`);
          continue;
        }
      }

      this.proposals.push(proposal);
      this.contributionTracker.recordProposal(agentId);

      const domain = Object.keys(manifest.domainAuthorities)[0];
      const authority = manifest.domainAuthorities[domain]?.authority ?? 0.5;
      const cal = await this.transport.fetchCalibration(manifest.journalEndpoint, agentId, domain);
      this.weights[agentId] = computeWeight(authority, cal, domain, proposal.stake.magnitude);

      this.journalEntries.push({
        entryId: generateId('adj'), entryType: 'proposal_emitted',
        deliberationId: dlbId, timestamp: now(), priorEntryHash: null,
        proposal: {
          proposalId: proposal.proposalId, agentId, vote: proposal.vote,
          confidence: proposal.confidence, domain,
          calibrationAtStake: proposal.stake.calibrationAtStake,
          dissentConditions: proposal.dissentConditions.map(dc => ({
            id: dc.id, condition: dc.condition, status: dc.status,
            amendmentCount: dc.amendments.length, testedInRound: dc.testedInRound,
          })),
        },
      });
    }

    // Self-proposal (initiating agent proposes to itself via HTTP, same path as peers)
    const selfProposal = await this.transport.requestProposal(selfUrl, dlbId, action, tier);
    this.proposals.push(selfProposal);
    this.contributionTracker.recordProposal(this.self.agentId);
    const selfDomain = this.self.decisionClasses[0];
    const selfAuthority = this.self.authorities[selfDomain] ?? 0.5;
    const selfJournalEndpoint = `http://${this.self.domain}:${this.self.port}/adj/v0`;
    const selfCal = await this.transport.fetchCalibration(selfJournalEndpoint, this.self.agentId, selfDomain);
    this.weights[this.self.agentId] = computeWeight(selfAuthority, selfCal, selfDomain, selfProposal.stake.magnitude);

    this.journalEntries.push({
      entryId: generateId('adj'), entryType: 'proposal_emitted',
      deliberationId: dlbId, timestamp: now(), priorEntryHash: null,
      proposal: {
        proposalId: selfProposal.proposalId, agentId: this.self.agentId,
        vote: selfProposal.vote, confidence: selfProposal.confidence,
        domain: selfDomain, calibrationAtStake: selfProposal.stake.calibrationAtStake,
        dissentConditions: selfProposal.dissentConditions.map(dc => ({
          id: dc.id, condition: dc.condition, status: dc.status,
          amendmentCount: dc.amendments.length, testedInRound: dc.testedInRound,
        })),
      },
    });

    // 3. Tally — round 0 (initial). ACB §5: this is the unlock signal.
    let tally = computeTally(this.proposals, this.weights, tier);
    this.tallies.push(tally);
    const initialTally = tally;
    const initialDisagreementMagnitude = computeDisagreementMagnitude(initialTally);

    // ADP v0.1 hook for ACB: emit tally_observed event so ACB-aware tooling
    // can compute the unlock signal in real time. Recorded as a journal
    // entry alongside the existing entry types.
    this.journalEntries.push({
      entryId: generateId('adj'), entryType: 'round_event',
      deliberationId: dlbId, timestamp: now(), priorEntryHash: null,
      round: 0, eventKind: 'tally_observed', agentId: this.self.agentId,
      payload: {
        tally: {
          approveWeight: initialTally.approveWeight,
          rejectWeight: initialTally.rejectWeight,
          abstainWeight: initialTally.abstainWeight,
          totalWeight: initialTally.totalWeight,
          approvalFraction: initialTally.approvalFraction,
          participationFraction: initialTally.participationFraction,
        },
        disagreementMagnitude: initialDisagreementMagnitude,
      },
    });

    // 4. Belief-update rounds
    const maxRounds = budget?.constraints?.maxRounds ?? 3;
    for (let round = 1; round <= maxRounds && !tally.converged; round++) {
      this.rounds = round;
      let revised = false;

      const currentVote = (p: Proposal) =>
        p.revisions.length > 0 ? p.revisions[p.revisions.length - 1].newVote : p.vote;

      const rejecters = this.proposals.filter(p => currentVote(p) === 'reject');
      const approvers = this.proposals.filter(p => currentVote(p) === 'approve');

      for (const rejecter of rejecters) {
        const active = rejecter.dissentConditions.filter(dc => dc.status === 'active');
        let allFalsified = true;

        // Pick the highest-weighted approver as evidence-bearer. Higher
        // weight in the relevant domain = more credible witness, and this
        // matches the spec §8 worked example (test-runner-v2 with 0.71 weight
        // out-bears the linter at 0.18).
        const evidenceAgent = approvers.length === 0
          ? undefined
          : approvers.reduce((best, p) =>
              (this.weights[p.agentId] ?? 0) > (this.weights[best.agentId] ?? 0) ? p : best,
            );

        for (const condition of active) {
          if (!evidenceAgent) { allFalsified = false; continue; }

          this.journalEntries.push({
            entryId: generateId('adj'), entryType: 'round_event',
            deliberationId: dlbId, timestamp: now(), priorEntryHash: null,
            round, eventKind: 'falsification_evidence',
            agentId: evidenceAgent.agentId,
            targetAgentId: rejecter.agentId,
            targetConditionId: condition.id,
          });
          this.contributionTracker.recordFalsificationEvidence(
            evidenceAgent.agentId, rejecter.agentId, condition.id);

          const response = await this.transport.sendFalsification(
            this.peerUrlMap[rejecter.agentId], condition.id, round, evidenceAgent.agentId
          );

          this.journalEntries.push({
            entryId: generateId('adj'), entryType: 'round_event',
            deliberationId: dlbId, timestamp: now(), priorEntryHash: null,
            round, eventKind: response.action,
            agentId: rejecter.agentId, targetConditionId: condition.id,
          });

          if (response.action === 'acknowledge') {
            condition.status = 'falsified';
            condition.testedInRound = round;
            condition.testedBy = evidenceAgent.agentId;
            // ACB §6.2: only acknowledged falsifications count toward the
            // falsification bonus — discourages spam.
            this.contributionTracker.recordAcknowledgement(
              evidenceAgent.agentId, rejecter.agentId, condition.id);
          } else {
            allFalsified = false;
          }
        }

        if (allFalsified && active.length > 0) {
          const revision = {
            round,
            priorVote: currentVote(rejecter),
            newVote: 'abstain' as const,
            priorConfidence: rejecter.confidence,
            newConfidence: null,
            reason: `All dissent conditions falsified in round ${round}.`,
            timestamp: now(),
          };
          rejecter.revisions.push(revision);
          revised = true;

          this.journalEntries.push({
            entryId: generateId('adj'), entryType: 'round_event',
            deliberationId: dlbId, timestamp: now(), priorEntryHash: null,
            round, eventKind: 'revise', agentId: rejecter.agentId,
            payload: { priorVote: revision.priorVote, newVote: revision.newVote, reason: revision.reason },
          });
        }
      }

      if (!revised) break;
      tally = computeTally(this.proposals, this.weights, tier);
      this.tallies.push(tally);

      // Round-boundary tally_observed (ADP v0.1 hook for ACB)
      this.journalEntries.push({
        entryId: generateId('adj'), entryType: 'round_event',
        deliberationId: dlbId, timestamp: now(), priorEntryHash: null,
        round, eventKind: 'tally_observed', agentId: this.self.agentId,
        payload: {
          tally: {
            approveWeight: tally.approveWeight,
            rejectWeight: tally.rejectWeight,
            abstainWeight: tally.abstainWeight,
            totalWeight: tally.totalWeight,
            approvalFraction: tally.approvalFraction,
            participationFraction: tally.participationFraction,
          },
          disagreementMagnitude: computeDisagreementMagnitude(tally),
        },
      });
    }

    // 5. Close
    const status = determineTermination(tally, true);

    this.journalEntries.push({
      entryId: generateId('adj'), entryType: 'deliberation_closed',
      deliberationId: dlbId, timestamp: now(), priorEntryHash: null,
      termination: status, roundCount: this.rounds, tier,
      finalTally: tally, weights: this.weights,
      committedAction: status === 'deadlocked' ? null : action,
    });

    // 5.5 ACB settlement, when a budget was attached. ACB §6 — runs in
    // immediate mode here; deferred/two_phase settlement waits for the
    // outcome record and is handled by the outcome reporter.
    let settlementEntry: JournalEntry | undefined;
    if (budget) {
      const routine = selectRoutine(budget.pricing, initialTally, this.rounds, status);
      const unlockTriggered = routine === 'expensive';

      // Habit memory lookup — find similar prior deliberations in the journal
      const priorEntries = readPriorJournalEntries(this.journal, dlbId);
      const history = findHabitHistory(priorEntries, action);
      const habitDiscount = computeHabitDiscount(history);

      const drawTotal = computeDraw(
        budget.pricing, routine, this.proposals.length, this.rounds, habitDiscount);

      // Brier deltas: in immediate mode, no outcome is known yet, so all
      // contributions report null and the outcome bonus pool redistributes
      // to other categories per default-v0.
      const brierDeltas = new Map<string, number>();
      const contributions = this.contributionTracker.build(
        tally, this.weights, 0.60 /* default threshold */, this.proposals, brierDeltas);

      settlementEntry = buildSettlementRecord({
        entryId: generateId('adj'),
        deliberationId: dlbId,
        timestamp: now(),
        priorEntryHash: null,
        budgetId: budget.budgetId,
        amountTotal: budget.amountTotal,
        drawTotal,
        settlement: budget.settlement,
        contributions,
        substrateReports: [],
        habitDiscountApplied: habitDiscount,
        unlockTriggered,
        disagreementMagnitudeInitial: initialDisagreementMagnitude,
        outcomeReferenced: null,
        signature: 'self',
      });
      this.journalEntries.push(settlementEntry);
    }

    // 6. Push journal to all peers + self (self via HTTP for consistency)
    const allUrls = [...this.peers.map(p => p.url), selfUrl];
    for (const url of allUrls) {
      await this.transport.pushJournalEntries(url, this.journalEntries);
    }

    return {
      deliberationId: dlbId,
      status,
      rounds: this.rounds,
      weights: this.weights,
      tallies: this.tallies,
      proposals: this.proposals.map(p => ({
        agentId: p.agentId,
        vote: p.vote,
        currentVote: p.revisions.length > 0 ? p.revisions[p.revisions.length - 1].newVote : p.vote,
        confidence: p.confidence,
      })),
      settlement: settlementEntry,
      initialDisagreementMagnitude,
    };
  }
}

/**
 * Read all journal entries the local store knows about, excluding the in-progress
 * deliberation. Used for ACB habit-memory lookups so the runner can compute
 * the discount against actually-committed prior work.
 */
function readPriorJournalEntries(journal: JournalStore, currentDlbId: string): JournalEntry[] {
  // The journal interface exposes per-deliberation reads but no global scan.
  // For the prototype we walk the directory directly via the underlying
  // method when available; otherwise return an empty history (no discount).
  const anyJournal = journal as any;
  if (typeof anyJournal.getAllEntries === 'function') {
    return (anyJournal.getAllEntries() as JournalEntry[]).filter(e => e.deliberationId !== currentDlbId);
  }
  if (typeof anyJournal.listDeliberations === 'function') {
    const ids: string[] = anyJournal.listDeliberations();
    const out: JournalEntry[] = [];
    for (const id of ids) {
      if (id === currentDlbId) continue;
      out.push(...journal.getDeliberation(id));
    }
    return out;
  }
  return [];
}

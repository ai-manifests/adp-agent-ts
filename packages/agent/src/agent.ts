/**
 * AdpAgent — the library entry point.
 *
 * Wraps the protocol runtime (journal + deliberation + signing + snapshot
 * publishing + MCP + ACB) into a single class adopters instantiate with a
 * config. Minimal use:
 *
 *     import { AdpAgent } from '@ai-manifests/adp-agent';
 *     const agent = new AdpAgent(config);
 *     await agent.start();
 *
 * Advanced use:
 *
 *     const agent = new AdpAgent(config, {
 *       journal: new SqliteJournal('/var/lib/adp/journal.db'),  // custom store
 *       app: existingExpressApp,                                 // mount into a parent app
 *     });
 *     agent.getApp().get('/custom/route', handler);              // add your own routes
 *     agent.afterStart(() => anchorScheduler.start());            // lifecycle hook
 *     agent.beforeStop(() => anchorScheduler.stop());
 *     await agent.start(3001);
 *
 * The anchor scheduler, gitea trigger, CI reporter, and other
 * deployment-specific pieces are NOT in this class — they're extensions
 * that adopters wire up via lifecycle hooks and getApp().
 */

import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'http';
import type {
  AgentConfig, AgentManifest, DissentCondition, Proposal,
  JournalEntry, PeerConfig, AcbBudget,
} from './types.js';
import { generateId } from './protocol.js';
import type { JournalStore } from './journal.js';
import { JsonlJournal } from './journal.js';
import { evaluate } from './evaluator.js';
import { createAuthMiddleware, authHeaders } from './middleware/auth.js';
import { createJournalValidator } from './middleware/journal-validator.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { signProposal } from './signing.js';
import { buildSignedEnvelope } from './calibration-snapshot.js';
import { PeerDeliberation } from './deliberation.js';
import { budgetFromDefaults } from './acb.js';
import { mountMcpEndpoints } from './mcp-server.js';

export interface AdpAgentOptions {
  /** Custom JournalStore implementation. Defaults to a JsonlJournal at config.journalDir. */
  journal?: JournalStore;
  /** Existing Express app to mount routes into. Defaults to a fresh app. */
  app?: Express;
  /** Disable the default express.json body-parser middleware (useful when mounting into a parent app that already sets it up). */
  skipBodyParser?: boolean;
}

type Hook = () => void | Promise<void>;

/**
 * The runtime class an ADP-compliant agent instantiates to become federation-ready.
 */
export class AdpAgent {
  private readonly _config: AgentConfig;
  private readonly _journal: JournalStore;
  private readonly _app: Express;
  private _server: Server | null = null;
  private readonly _afterStart: Hook[] = [];
  private readonly _beforeStop: Hook[] = [];

  constructor(config: AgentConfig, options: AdpAgentOptions = {}) {
    this._config = config;
    this._journal = options.journal ?? new JsonlJournal(config.journalDir);
    this._app = options.app ?? express();
    if (!options.skipBodyParser) {
      // Capture the raw request bytes alongside the parsed JSON. Trigger
      // plugins (e.g. Gitea webhooks) need to verify HMAC signatures over
      // the exact bytes they received; without this, a downstream router's
      // own `express.json({ verify })` middleware never fires (the global
      // parser has already consumed the stream) and signature verification
      // falls back to `JSON.stringify(req.body)`, which produces re-encoded
      // bytes that don't match the sender's hash.
      this._app.use(express.json({
        limit: '1mb',
        verify: (req: Request & { rawBody?: string }, _res, buf) => {
          req.rawBody = buf.toString('utf8');
        },
      }));
    }
    this._buildRoutes();
  }

  // ---------- public API ----------

  getApp(): Express { return this._app; }
  getJournal(): JournalStore { return this._journal; }
  getConfig(): Readonly<AgentConfig> { return this._config; }

  /** Register a hook to run after start() binds the server. */
  afterStart(fn: Hook): this { this._afterStart.push(fn); return this; }
  /** Register a hook to run before stop() closes the server. */
  beforeStop(fn: Hook): this { this._beforeStop.push(fn); return this; }

  /** Bind the HTTP server. Returns the underlying http.Server. Idempotent. */
  async start(port?: number): Promise<Server> {
    if (this._server) return this._server;
    const bindPort = port ?? this._config.port;
    this._server = await new Promise<Server>(resolve => {
      const s = this._app.listen(bindPort, () => resolve(s));
    });
    for (const hook of this._afterStart) {
      await hook();
    }
    return this._server;
  }

  /** Close the HTTP server. Idempotent. */
  async stop(): Promise<void> {
    for (const hook of this._beforeStop) {
      try { await hook(); } catch (err) {
        console.warn(`[adp-agent] beforeStop hook failed: ${(err as Error).message}`);
      }
    }
    if (!this._server) return;
    await new Promise<void>((resolve, reject) => {
      this._server!.close(err => (err ? reject(err) : resolve()));
    });
    this._server = null;
  }

  // ---------- route registration ----------

  private _buildRoutes(): void {
    const config = this._config;
    const journal = this._journal;
    const app = this._app;

    const requireAuth = createAuthMiddleware(config.auth);
    const validateJournal = createJournalValidator();
    const rateLimitApi = createRateLimiter({ maxTokens: 10, refillRate: 1 });
    const rateLimitDeliberate = createRateLimiter({ maxTokens: 2, refillRate: 0.1 });
    const rateLimitJournal = createRateLimiter({ maxTokens: 50, refillRate: 10 });

    mountMcpEndpoints(app, config, journal);

    app.get('/healthz', (_req: Request, res: Response) => {
      res.json({ status: 'ok', agentId: config.agentId });
    });

    // --- .well-known/adp-manifest.json ---
    app.get('/.well-known/adp-manifest.json', (_req: Request, res: Response) => {
      const manifest: AgentManifest = {
        agentId: config.agentId,
        identity: `did:web:${config.domain}`,
        complianceLevel: 3,
        decisionClasses: config.decisionClasses,
        domainAuthorities: Object.fromEntries(
          Object.entries(config.authorities).map(([domain, authority]) => [
            domain, { authority, source: `mcp-manifest:${config.agentId}#authorities` },
          ]),
        ),
        journalEndpoint: `http://${config.domain}:${config.port}/adj/v0`,
        publicKey: config.auth?.publicKey ?? null,
        trustLevel: config.allowedPeers ? 'registered' : 'open',
      };
      res.json(manifest);
    });

    // --- .well-known/adp-calibration.json (ADJ §7.4) ---
    app.get('/.well-known/adp-calibration.json', async (_req: Request, res: Response) => {
      if (!config.auth?.privateKey || !config.auth?.publicKey) {
        res.status(503).json({
          error: 'Agent has no signing key configured; cannot publish signed calibration',
        });
        return;
      }
      try {
        const allEntries: JournalEntry[] = [];
        const anyJournal = journal as JournalStore & { listDeliberations?: () => string[] };
        if (typeof anyJournal.listDeliberations === 'function') {
          for (const dlbId of anyJournal.listDeliberations()) {
            allEntries.push(...journal.getDeliberation(dlbId));
          }
        }
        const envelope = await buildSignedEnvelope({
          agentId: config.agentId,
          publicKey: config.auth.publicKey,
          privateKey: config.auth.privateKey,
          domains: config.decisionClasses,
          entries: allEntries,
        });
        res.json(envelope);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message ?? 'Failed to build signed envelope' });
      }
    });

    // --- POST /api/propose ---
    app.post('/api/propose', rateLimitApi, requireAuth, async (req: Request, res: Response) => {
      const { deliberationId, action, reversibilityTier } = req.body;
      const domain = config.decisionClasses[0];
      const evalResult = await evaluate(config.evaluator, action);

      const vote = evalResult?.vote ?? config.defaultVote;
      const confidence = evalResult?.confidence ?? config.defaultConfidence;
      const summary = evalResult?.summary ?? `Evaluation by ${config.agentId}`;
      const evidenceRefs = evalResult?.evidenceRefs ?? [];
      const conditionStrings = evalResult?.dissentConditions?.length
        ? evalResult.dissentConditions
        : config.dissentConditions;

      const conditions: DissentCondition[] = conditionStrings.map((cond: string, i: number) => ({
        id: `dc_${config.agentId.split(':').pop()}_${String(i + 1).padStart(2, '0')}`,
        condition: cond,
        status: 'active',
        amendments: [],
        testedInRound: null,
        testedBy: null,
      }));

      const proposal: Proposal = {
        proposalId: generateId('prp'),
        deliberationId,
        agentId: config.agentId,
        timestamp: new Date().toISOString(),
        action,
        vote,
        confidence,
        domainClaim: { domain, authoritySource: `mcp-manifest:${config.agentId}#authorities` },
        reversibilityTier: reversibilityTier || 'partially_reversible',
        blastRadius: { scope: [action.target], estimatedUsersAffected: 0, rollbackCostSeconds: 60 },
        justification: { summary, evidenceRefs },
        stake: { declaredBy: 'self', magnitude: config.stakeMagnitude, calibrationAtStake: true },
        dissentConditions: conditions,
        revisions: [],
      };

      if (config.auth?.privateKey) {
        const signature = await signProposal(proposal, config.auth.privateKey);
        res.json({ ...proposal, signature });
      } else {
        res.json(proposal);
      }
    });

    // --- POST /api/respond-falsification ---
    app.post('/api/respond-falsification', rateLimitApi, requireAuth, (req: Request, res: Response) => {
      const { conditionId, round, evidenceAgentId } = req.body;
      const response = config.falsificationResponses[conditionId] || 'acknowledge';
      if (response === 'acknowledge') {
        res.json({
          action: 'acknowledge', conditionId, round,
          reviseVote: 'abstain',
          reason: `Condition ${conditionId} falsified by ${evidenceAgentId}.`,
        });
      } else {
        res.json({
          action: 'reject', conditionId, round,
          reason: `Evidence insufficient to falsify ${conditionId}.`,
        });
      }
    });

    // --- ADJ query contract ---
    app.get('/adj/v0/calibration', (req: Request, res: Response) => {
      const agentId = (req.query.agent_id as string) || config.agentId;
      const domain = (req.query.domain as string) || config.decisionClasses[0];
      res.json(journal.getCalibration(agentId, domain));
    });

    app.get('/adj/v0/deliberation/:id', (req: Request, res: Response) => {
      res.json(journal.getDeliberation(String(req.params.id)));
    });

    // Batch (ADJ §7.1 listDeliberationsSince)
    app.get('/adj/v0/deliberations', (req: Request, res: Response) => {
      const sinceParam = req.query.since as string | undefined;
      const limitParam = req.query.limit as string | undefined;
      if (!sinceParam) {
        res.status(400).json({ error: "'since' query parameter required (ISO 8601 timestamp)" });
        return;
      }
      const since = new Date(sinceParam);
      if (isNaN(since.getTime())) {
        res.status(400).json({ error: `'since' is not a valid ISO 8601 timestamp: ${sinceParam}` });
        return;
      }
      const requested = limitParam ? parseInt(limitParam, 10) : 500;
      const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 500;
      const records = journal.listDeliberationsSince(since, limit);
      res.json({ since: since.toISOString(), limit, total: records.length, records });
    });

    app.get('/adj/v0/outcome/:id', (req: Request, res: Response) => {
      const outcome = journal.getOutcome(String(req.params.id));
      res.json(outcome || null);
    });

    app.post('/adj/v0/entries', rateLimitJournal, requireAuth, validateJournal, (req: Request, res: Response) => {
      const entries = Array.isArray(req.body) ? req.body : [req.body];
      journal.appendBatch(entries);
      res.json({ written: entries.length });
    });

    // --- POST /api/deliberate — P2P initiator ---
    app.post('/api/deliberate', rateLimitDeliberate, requireAuth, async (req: Request, res: Response) => {
      const { action, peerUrls, tier, budget, useDefaultBudget } = req.body;
      if (!action) { res.status(400).json({ error: 'action required' }); return; }

      const peers: PeerConfig[] =
        (peerUrls || config.peers?.map((p: PeerConfig) => p.url) || []).map((url: string) => ({
          agentId: '', url, transport: 'http' as const,
        }));

      let resolvedBudget: AcbBudget | undefined = budget;
      if (!resolvedBudget && useDefaultBudget && config.acbDefaults) {
        resolvedBudget = budgetFromDefaults(config.acbDefaults);
      }

      const deliberation = new PeerDeliberation(config, journal, peers);
      try {
        const result = await deliberation.run(
          action,
          tier || 'partially_reversible',
          resolvedBudget ? { budget: resolvedBudget } : {},
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // --- POST /api/budget ---
    app.post('/api/budget', requireAuth, (req: Request, res: Response) => {
      if (!config.acbDefaults) {
        res.status(404).json({ error: 'agent has no acbDefaults configured' });
        return;
      }
      const overrides = req.body || {};
      const base = budgetFromDefaults(config.acbDefaults);
      res.json({
        ...base,
        ...overrides,
        pricing: { ...base.pricing, ...(overrides.pricing || {}) },
        settlement: { ...base.settlement, ...(overrides.settlement || {}) },
      });
    });

    // --- POST /api/record-outcome ---
    app.post('/api/record-outcome', requireAuth, async (req: Request, res: Response) => {
      const { deliberationId, success, evidenceRefs, peerUrls } = req.body;
      if (!deliberationId) { res.status(400).json({ error: 'deliberationId required' }); return; }

      const outcomeEntry: JournalEntry = {
        entryId: generateId('adj'),
        entryType: 'outcome_observed',
        deliberationId,
        timestamp: new Date().toISOString(),
        priorEntryHash: null,
        observedAt: new Date().toISOString(),
        outcomeClass: 'binary',
        success: success ? 1.0 : 0.0,
        evidenceRefs: evidenceRefs || [],
        reporterId: config.agentId,
        reporterConfidence: 0.95,
        groundTruth: true,
      };

      journal.appendBatch([outcomeEntry]);

      // Gossip to peers, best-effort. Each peer gets the per-peer token from
      // config.peers (URL → agentId → peerTokens[agentId]). Falling back to
      // the wildcard '*' lookup is a soft fallback for ad-hoc peerUrls that
      // aren't in config.peers — which is the only path that will work if
      // peerTokens has no '*' entry. Previously this hardcoded '*' for every
      // gossip target, which 401'd silently against any federation that
      // (correctly) uses agentId-keyed tokens with no wildcard.
      const urlToAgentId = new Map<string, string>();
      for (const p of config.peers ?? []) urlToAgentId.set(p.url, p.agentId);
      const urls: string[] = peerUrls || config.peers?.map((p: PeerConfig) => p.url) || [];
      for (const url of urls) {
        try {
          const peerAgentId = urlToAgentId.get(url) ?? '*';
          await fetch(`${url}/adj/v0/entries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(config.auth, peerAgentId) },
            body: JSON.stringify([outcomeEntry]),
          });
        } catch { /* best effort */ }
      }

      res.json({ written: true, entryId: outcomeEntry.entryId });
    });
  }
}

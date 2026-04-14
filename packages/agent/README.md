# @ai-manifests/adp-agent

Reference implementation of the [Agent Deliberation Protocol](https://adp-manifest.dev). Build a federation-ready agent with:

```bash
npm install @ai-manifests/adp-agent
```

## Minimal use

```ts
import { AdpAgent, type AgentConfig } from '@ai-manifests/adp-agent';

const config: AgentConfig = {
  agentId: 'did:adp:my-agent-v1',
  port: 3000,
  domain: 'my-agent.example.com',
  decisionClasses: ['code.correctness'],
  authorities: { 'code.correctness': 0.7 },
  stakeMagnitude: 'medium',
  defaultVote: 'approve',
  defaultConfidence: 0.65,
  dissentConditions: ['if any test marked critical regresses'],
  falsificationResponses: {},
  journalDir: './journal',
};

const agent = new AdpAgent(config);
await agent.start();
```

That's all. The library handles:

- **Manifest endpoint** at `/.well-known/adp-manifest.json`
- **Signed calibration snapshots** at `/.well-known/adp-calibration.json` (ADJ §7.4)
- **Deliberation API** (`POST /api/deliberate`, `POST /api/propose`, `POST /api/respond-falsification`)
- **Outcome recording** (`POST /api/record-outcome`)
- **ADJ query contract** (`/adj/v0/calibration`, `/adj/v0/deliberation/:id`, `/adj/v0/deliberations`, `/adj/v0/outcome/:id`, `/adj/v0/entries`)
- **ACB budget endpoints** (`POST /api/budget`) — when `acbDefaults` is configured
- **MCP tool server** at `/mcp` — agents can call each other's ADP/ADJ operations as MCP tools
- **Health check** at `/healthz`
- **Ed25519 proposal signing**, **Brier-score calibration**, **journal append/query**

You only write the **evaluator** — the thing that produces votes. See [`adp-agent-template`](https://git.marketally.com/ai-manifests/adp-agent-template) for the full pattern.

## AdpAgent class

```ts
class AdpAgent {
  constructor(config: AgentConfig, options?: AdpAgentOptions);

  // Lifecycle
  start(port?: number): Promise<Server>;
  stop(): Promise<void>;
  afterStart(fn: () => void | Promise<void>): this;
  beforeStop(fn: () => void | Promise<void>): this;

  // Access
  getApp(): Express;             // Mount your own routes on top
  getJournal(): JournalStore;    // For admin/testing
  getConfig(): Readonly<AgentConfig>;
}

interface AdpAgentOptions {
  journal?: JournalStore;        // Defaults to JsonlJournal(config.journalDir)
  app?: Express;                 // Defaults to a fresh express() instance
  skipBodyParser?: boolean;      // Skip default express.json() middleware
}
```

## Custom journal

Default is JSONL. For production, use SQLite:

```ts
import { SqliteJournal } from '@ai-manifests/adp-agent/journal-sqlite';
import { AdpAgent } from '@ai-manifests/adp-agent';

const journal = new SqliteJournal('/var/lib/adp/journal.db');
const agent = new AdpAgent(config, { journal });
```

`better-sqlite3` is an optional peer dependency — install it explicitly when using `SqliteJournal`:

```bash
npm install better-sqlite3
```

Or bring your own `JournalStore` implementation (Postgres, event-sourced log, whatever). The interface is:

```ts
interface JournalStore {
  append(entry: JournalEntry): void;
  appendBatch(entries: JournalEntry[]): void;
  getDeliberation(deliberationId: string): JournalEntry[];
  getOutcome(deliberationId: string): JournalEntry | null;
  getCalibration(agentId: string, domain: string): CalibrationScore;
  listDeliberationsSince(since: Date, limit: number): DeliberationRecord[];
}
```

## Public exports

All exports live on the default entry point. Deep imports are not supported.

- **Class**: `AdpAgent`
- **Types**: `AgentConfig`, `AgentManifest`, `Proposal`, `JournalEntry`, `AcbBudget`, `CalibrationAnchorConfig`, and every other protocol type
- **Journal**: `JournalStore`, `JsonlJournal`, `DeliberationRecord` (plus `SqliteJournal` via the `@ai-manifests/adp-agent/journal-sqlite` subpath)
- **Protocol primitives**: `computeWeight`, `computeTally`, `determineTermination`, `computeCalibration`, `generateId`
- **Deliberation**: `PeerDeliberation`, `HttpTransport`, `DeliberationResult`, `PeerTransport`
- **Signing**: `generateKeyPair`, `signProposal`, `verifyProposal`, `canonicalize`
- **Calibration snapshot (ADJ §7.4)**: `buildSnapshot`, `buildSignedEnvelope`, `signSnapshot`, `verifySnapshot`, `computeJournalHash`, `extractScoringPairs`
- **Calibration verifier**: `verifyPeerCalibration`, `applyDivergencePenalty`
- **ACB**: `computeDisagreementMagnitude`, `selectRoutine`, `computeCheapDraw`, `computeExpensiveDraw`, `computeHabitDiscount`, `buildSettlementRecord`, `buildBudgetCommittedEntry`, `budgetFromDefaults`, `ContributionTracker`, `distributeEpistemic`, `distributeSubstrate`, `DEFAULT_PRICING`, `DEFAULT_SETTLEMENT`, `MAX_HABIT_DISCOUNT`
- **Evaluator**: `evaluate`
- **MCP**: `createMcpServer`, `mountMcpEndpoints`
- **Middleware**: `createAuthMiddleware`, `createJournalValidator`, `createRateLimiter`, `authHeaders`, `validateEntry`

## Optional: chain anchoring

For third-party tamper evidence, install the optional anchor package:

```bash
npm install @ai-manifests/adp-agent-anchor
```

See [`adp-agent-anchor` README](../agent-anchor/README.md) for wiring.

## License

Apache-2.0 — see [`LICENSE`](LICENSE) for the full text.

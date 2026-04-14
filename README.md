# adp-agent

Reference implementation of the [Agent Deliberation Protocol](https://adp-manifest.dev). Monorepo for two npm packages plus a JSON Schema for config validation.

| Package | Description |
|---|---|
| [`@ai-manifests/adp-agent`](packages/agent) | Protocol runtime — `AdpAgent` class, deliberation state machine, journal (JSONL + optional SQLite), Ed25519 signing, signed calibration snapshots (ADJ §7.4), ACB pricing/settlement, MCP tool server, middleware. The thing you install to build an ADP-compliant agent. |
| [`@ai-manifests/adp-agent-anchor`](packages/agent-anchor) | Optional Neo3 blockchain anchor. Periodically commits signed calibration snapshots to a Neo3-compatible chain for third-party tamper evidence. Depends on `@ai-manifests/adp-agent`; pulls in `@cityofzion/neon-js`. |

Companion repo: [`adp-agent-template`](https://git.marketally.com/ai-manifests/adp-agent-template) — a forkable starter that depends on these packages and gives new adopters a 30-second clone-and-run.

## Relationship to the specs

```
mcp-manifest    declares what an agent can do
ADP             declares how agents agree on doing it together
ADJ             declares how those agreements are recorded and scored
ACB             declares how the cognitive work of agreeing is paid for
```

- `@ai-manifests/adp-agent` implements all four specs' runtime surface for a single agent
- `@ai-manifests/adp-agent-anchor` is strictly optional — the always-on signed calibration snapshot at `.well-known/adp-calibration.json` (ADJ §7.4) is the day-to-day trust mechanism; the chain anchor is the survives-everything tamper-evidence layer for operators who want it

## Quickstart

Minimal usage from the `@ai-manifests/adp-agent` package:

```ts
import { AdpAgent, JsonlJournal, type AgentConfig } from '@ai-manifests/adp-agent';

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

That's the entire adoption surface. The library handles manifest serving, calibration snapshot publishing, deliberation, journal, ACB, MCP, and signing. You only write the evaluator that produces votes — see the [template repo](https://git.marketally.com/ai-manifests/adp-agent-template) for the full pattern.

## With optional chain anchoring

```ts
import { AdpAgent } from '@ai-manifests/adp-agent';
import { createAnchorStore, CalibrationAnchorScheduler } from '@ai-manifests/adp-agent-anchor';

const agent = new AdpAgent(config);
const store = createAnchorStore(config.calibrationAnchor);
if (store) {
  const scheduler = new CalibrationAnchorScheduler(
    config, store,
    () => agent.getJournal().listDeliberationsSince(new Date(0), 10000).flatMap(r => r.entries),
  );
  agent.afterStart(() => scheduler.start());
  agent.beforeStop(() => scheduler.stop());
}
await agent.start();
```

Targets: `mock`, `neo-express`, `neo-custom`, `neo-testnet`, `neo-mainnet`. All four use the same `Neo3BlockchainStore` client and the same `CalibrationStore.cs` smart contract — only the RPC URL, contract hash, and signing wallet change between deployments.

## Build

```bash
npm install
npm run build
npm test
```

Requires Node.js 20+. The monorepo uses npm workspaces; `npm install` from the root installs deps for both packages.

## Project layout

```
adp-agent/
├── packages/
│   ├── agent/               # @ai-manifests/adp-agent (npm)
│   │   ├── src/
│   │   │   ├── agent.ts              # AdpAgent class (public API)
│   │   │   ├── index.ts              # Barrel export
│   │   │   ├── types.ts              # All protocol types
│   │   │   ├── protocol.ts           # Weight, tally, termination, calibration
│   │   │   ├── journal.ts            # JournalStore interface + JsonlJournal
│   │   │   ├── journal-sqlite.ts     # Optional SQLite backend
│   │   │   ├── deliberation.ts       # PeerDeliberation state machine
│   │   │   ├── signing.ts            # Ed25519 sign/verify
│   │   │   ├── calibration-snapshot.ts  # Signed snapshot module (ADJ §7.4)
│   │   │   ├── calibration-verifier.ts  # Peer spot-checks
│   │   │   ├── acb.ts                # ACB pricing + settlement + contribution
│   │   │   ├── evaluator.ts          # Shell evaluator runner
│   │   │   ├── mcp-server.ts         # MCP tool server
│   │   │   ├── mcp-client.ts         # MCP peer client
│   │   │   └── middleware/           # auth, rate-limit, journal-validator
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── agent-anchor/        # @ai-manifests/adp-agent-anchor (npm)
│       ├── src/
│       │   ├── index.ts              # Barrel export
│       │   ├── blockchain.ts         # BlockchainCalibrationStore interface
│       │   ├── blockchain-mock.ts    # Mock store for tests
│       │   ├── blockchain-neo3.ts    # Real Neo3 client (neon-js)
│       │   └── calibration-anchor.ts # Scheduler
│       ├── package.json
│       └── tsconfig.json
├── schema/
│   └── agent-config.schema.json   # JSON Schema for AgentConfig
├── package.json             # Workspace root
├── tsconfig.base.json       # Shared compiler options
└── tsconfig.json            # Project references
```

## Schema

[`schema/agent-config.schema.json`](schema/agent-config.schema.json) — JSON Schema for `AgentConfig`. Reference it from your agent's config file for editor autocomplete:

```json
{
  "$schema": "https://adp-manifest.dev/schema/agent-config/v0.json",
  "agentId": "did:adp:my-agent-v1",
  ...
}
```

## Reference deployment

The [federation prototype](https://git.marketally.com/ai-manifests/adp-federation-prototype) on CT 128 is the canonical "what a real 4-agent production federation looks like" example. It depends on this library via a local file reference and is the test harness that validates the library's behavior under real traffic.

## License

Apache-2.0 — see [`LICENSE`](packages/agent/LICENSE) for the full text.

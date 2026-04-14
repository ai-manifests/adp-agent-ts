# @ai-manifests/adp-agent-anchor

Optional Neo3 blockchain anchor for [`@ai-manifests/adp-agent`](https://git.marketally.com/ai-manifests/adp-agent). Commits signed calibration snapshots to a Neo3-compatible chain on a schedule for third-party tamper evidence.

```bash
npm install @ai-manifests/adp-agent @ai-manifests/adp-agent-anchor
```

## Why it's optional

The always-on [signed calibration snapshot](https://adj-manifest.dev) at `/.well-known/adp-calibration.json` (ADJ §7.4) is the primary trust mechanism — peers and registries verify against it with one HTTPS fetch plus a signature check, no chain required. The chain anchor is a **strictly optional** overlay that adds:

1. **Third-party verification** without routing through the registry
2. **Evidence that survives agent disappearance** — the anchored record stays on-chain even if the agent's HTTPS endpoint goes offline
3. **Anti-rewrite defense** — on-chain records are mechanically detectable if an agent later rewrites its journal

For a federation with a trusted registry, these properties are nice-to-have. For a federation where participants don't fully trust each other or the registry, they're load-bearing.

## Supported targets

All four targets use the same `Neo3BlockchainStore` client and the same `CalibrationStore.cs` smart contract — only the RPC URL, contract hash, and signing wallet change.

| Target | Use case |
|---|---|
| `mock` | Unit tests (in-memory, no network) |
| `neo-express` | Local dev chain (Neo Express) |
| `neo-custom` | Operator's existing private Neo3 chain |
| `neo-testnet` | Public Neo N3 testnet (free faucet GAS) |
| `neo-mainnet` | Public Neo N3 mainnet (real GAS, real immutability) |

## Usage

```ts
import { AdpAgent } from '@ai-manifests/adp-agent';
import { createAnchorStore, CalibrationAnchorScheduler } from '@ai-manifests/adp-agent-anchor';

const agent = new AdpAgent(config);

if (config.calibrationAnchor?.enabled) {
  const store = createAnchorStore(config.calibrationAnchor);
  if (store) {
    const scheduler = new CalibrationAnchorScheduler(
      config,
      store,
      () => agent.getJournal().listDeliberationsSince(new Date(0), 10000).flatMap(r => r.entries),
      config.calibrationAnchor.publishIntervalSeconds ?? 3600,
    );
    agent.afterStart(() => scheduler.start());
    agent.beforeStop(() => scheduler.stop());
  }
}

await agent.start();
```

## Config

The `calibrationAnchor` field on `AgentConfig` (defined in `adp-agent`) controls the anchor:

```json
{
  "calibrationAnchor": {
    "enabled": true,
    "target": "neo-custom",
    "rpcUrl": "http://10.0.0.127:50012",
    "contractHash": "0x52743c2e73b597f0822308d45b2ff0a9c9271964",
    "networkMagic": 366497916,
    "publishIntervalSeconds": 900
  }
}
```

The `privateKey` field should **never** go in the config file. Pass it via the `ADP_ANCHOR_PRIVATE_KEY` environment variable instead, or via your preferred secrets store.

## API

- **`createAnchorStore(config)`** — builds a `BlockchainCalibrationStore` from the config's `target`. Returns `MockBlockchainStore` for `'mock'`, `Neo3BlockchainStore` for any `neo-*` target, or `null` if required config fields are missing.

- **`CalibrationAnchorScheduler(self, store, readJournal, intervalSeconds?)`** — periodic publisher. Reads the journal via the `readJournal` callback (passed in so the scheduler is unit-testable), builds the current signed snapshot for each declared decision class, and publishes to the chain every `intervalSeconds` (default 3600). Exposes `.start()`, `.stop()`, `.publishNow()`, and `.status()`.

- **`Neo3BlockchainStore(options)`** — low-level RPC client. `options.rpcUrl`, `options.contractHash`, `options.privateKey`, `options.networkMagic`, `options.publishTimeoutSeconds`. Implements `BlockchainCalibrationStore`.

- **`MockBlockchainStore`** — in-memory implementation for tests. Same interface.

- **`BlockchainCalibrationStore`** — the interface both implementations conform to. If you have a non-Neo3 chain, implement this yourself.

## Smart contract

The companion smart contract is [`adp-calibration-contract/CalibrationStore.cs`](https://git.marketally.com/ai-manifests/adp-calibration-contract) — a C# Neo3 contract compiled with `nccs` (Neo.Compiler.CSharp). Deploy once per chain; capture the contract hash into `config.calibrationAnchor.contractHash`.

The contract has two public operations:

- `setCalibration(agentId, domain, valueInt, sampleSize, journalHash)` — writes a calibration record (no witness check; authentication is off-chain via the ADJ signed snapshot)
- `getCalibration(agentId, domain) → [agentId, domain, valueInt, sampleSize, timestamp, journalHash] | null`

Value is scaled to an integer in [0, 10000] for 4-decimal precision.

## License

Apache-2.0 — see [`LICENSE`](LICENSE) for the full text.

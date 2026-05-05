/**
 * Calibration anchor scheduler — Phase 7.
 *
 * Runs in-process inside an agent. On a schedule, it builds the agent's
 * current signed calibration snapshot (the same data served at
 * /.well-known/adp-calibration.json), then publishes the snapshot's
 * (value, sampleSize, journalHash) tuple to a Neo3-compatible chain via
 * the configured BlockchainCalibrationStore.
 *
 * The chain anchor is the *third-party verifiable, registry-independent*
 * tamper-evidence layer. Signed snapshots (ADJ §7.4) are the always-on
 * trust mechanism for day-to-day verification; the chain anchor is the
 * survives-agent-disappearance, no-registry-required commitment for
 * operators that want it.
 */

import type {
  AgentConfig,
  CalibrationAnchorConfig,
  CalibrationAnchorTarget,
  JournalEntry,
} from '@ai-manifests/adp-agent';
import type { BlockchainCalibrationStore, CalibrationRecord } from './blockchain.js';
import { MockBlockchainStore } from './blockchain-mock.js';
import { Neo3BlockchainStore } from './blockchain-neo3.js';
import { buildSnapshot } from '@ai-manifests/adp-agent';

/** Default cadence: hourly. Operators with active federations may want shorter. */
const DEFAULT_PUBLISH_INTERVAL_S = 3600;

/**
 * Build the chain client for a given anchor target. Returns a configured
 * BlockchainCalibrationStore instance, or null if the config is incomplete
 * (e.g. enabled but missing rpcUrl). Mock target needs no config.
 */
export function createAnchorStore(
  config: CalibrationAnchorConfig,
): BlockchainCalibrationStore | null {
  if (config.target === 'mock') {
    return new MockBlockchainStore();
  }

  // All non-mock targets are Neo3-compatible
  if (!config.rpcUrl || !config.contractHash) {
    return null;
  }

  const privateKey = config.privateKey ?? process.env.ADP_ANCHOR_PRIVATE_KEY;
  return new Neo3BlockchainStore({
    rpcUrl: config.rpcUrl,
    contractHash: config.contractHash,
    privateKey,
    networkMagic: config.networkMagic ?? networkMagicForTarget(config.target),
  });
}

/**
 * Background scheduler that periodically publishes calibration snapshots
 * to a chain. Reads journal entries via a callback so it can be unit-tested
 * without a full agent stack, and so the agent can decide which entries
 * to expose.
 */
export class CalibrationAnchorScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private publishCount = 0;
  private lastPublishedAt: Date | null = null;
  private lastError: Error | null = null;

  constructor(
    private readonly self: AgentConfig,
    private readonly store: BlockchainCalibrationStore,
    private readonly readJournal: () => JournalEntry[],
    private readonly intervalSeconds: number = DEFAULT_PUBLISH_INTERVAL_S,
  ) {}

  /** Begin periodic publishing. Idempotent — safe to call once at startup. */
  start(): void {
    if (this.running) return;
    this.running = true;
    // Fire once immediately so a freshly-started agent gets an initial commit
    void this.publishNow();
    this.timer = setInterval(() => void this.publishNow(), this.intervalSeconds * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  /**
   * Build and publish a snapshot for every domain the agent claims authority
   * over. Returns the number of records successfully written. Errors per
   * domain are caught individually so one failed publish doesn't stop the
   * rest of the loop.
   */
  async publishNow(): Promise<number> {
    let written = 0;
    const entries = this.readJournal();

    for (const domain of this.self.decisionClasses) {
      try {
        const snapshot = buildSnapshot(this.self.agentId, domain, entries);
        const record: CalibrationRecord = {
          agentId: this.self.agentId,
          domain,
          value: snapshot.calibrationValue,
          sampleSize: snapshot.sampleSize,
          timestamp: Date.parse(snapshot.computedAt),
          journalHash: snapshot.journalHash,
        };
        await this.store.publishCalibration(record);
        written++;
      } catch (err) {
        this.lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(
          `[anchor] Failed to publish calibration for ${this.self.agentId}/${domain}: ${this.lastError.message}`,
        );
      }
    }

    if (written > 0) {
      this.publishCount += written;
      this.lastPublishedAt = new Date();
    }
    return written;
  }

  /** Status snapshot for monitoring / health endpoints. */
  status() {
    return {
      running: this.running,
      intervalSeconds: this.intervalSeconds,
      publishCount: this.publishCount,
      lastPublishedAt: this.lastPublishedAt?.toISOString() ?? null,
      lastError: this.lastError?.message ?? null,
    };
  }
}

/**
 * Network magic for each Neo3 target. The values for testnet and mainnet
 * are well-known; private chains and Neo Express use whatever magic the
 * operator configured (caller can override via CalibrationAnchorConfig.networkMagic).
 */
function networkMagicForTarget(target: CalibrationAnchorTarget): number {
  switch (target) {
    case 'neo-mainnet': return 0x334F454E; // 860833102 — Neo N3 MainNet
    case 'neo-testnet': return 0x3554334E; // 894710606 — Neo N3 TestNet (T5)
    case 'neo-express': return 0xC44A1F03; // Neo Express default
    case 'neo-custom':
    default:
      // Operator-supplied private chain — must be set explicitly via config.networkMagic
      return 0xC44A1F03;
  }
}

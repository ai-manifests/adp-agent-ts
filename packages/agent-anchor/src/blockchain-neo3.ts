/**
 * Neo3 blockchain calibration store.
 *
 * Real implementation against any Neo3-compatible JSON-RPC endpoint:
 *   - Local Neo Express on CT 127        (target=neo-express)
 *   - Operator's private Neo3 chain      (target=neo-custom)
 *   - Public Neo N3 testnet              (target=neo-testnet)
 *   - Public Neo N3 mainnet              (target=neo-mainnet)
 *
 * All four use the same code; only `rpcUrl`, `contractHash`, and the signing
 * `privateKey` change. The smart contract source is at
 * `adp-calibration-contract/CalibrationStore.cs` — it stores per-(agentId,
 * domain) calibration records and emits a `CalibrationPublished` event for
 * cross-chain verification.
 *
 * The blockchain is the *anchor* layer, not the primary trust mechanism.
 * Signed snapshots at the agent's `/.well-known/adp-calibration.json`
 * (ADJ §7.4) remain the day-to-day verification surface. Anchoring adds
 * a third-party-verifiable, registry-independent record that survives
 * agent disappearance and detects journal rewrites.
 */

import { rpc, sc, tx, wallet, u, CONST } from '@cityofzion/neon-js';
import type { CalibrationRecord, BlockchainCalibrationStore } from './blockchain.js';
import type { JournalEntry } from '@ai-manifests/adp-agent';
import { computeCalibration } from '@ai-manifests/adp-agent';

export interface Neo3StoreOptions {
  rpcUrl: string;
  /** Contract hash hex, with or without leading 0x. */
  contractHash: string;
  /** Hex-encoded WIF or raw private key for the signer. Optional for read-only stores. */
  privateKey?: string;
  /** Network magic. Defaults to MainNet (0x334F454E). Override for testnet/private chains. */
  networkMagic?: number;
  /** Maximum seconds to wait for a published transaction to appear in a block. */
  publishTimeoutSeconds?: number;
}

const DEFAULT_NETWORK_MAGIC = CONST.MAGIC_NUMBER.MainNet;
const DEFAULT_PUBLISH_TIMEOUT_S = 30;

export class Neo3BlockchainStore implements BlockchainCalibrationStore {
  private readonly rpcClient: InstanceType<typeof rpc.RPCClient>;
  private readonly contractHash: string;
  private readonly account: InstanceType<typeof wallet.Account> | null;
  private readonly networkMagic: number;
  private readonly publishTimeoutS: number;

  constructor(opts: Neo3StoreOptions) {
    this.rpcClient = new rpc.RPCClient(opts.rpcUrl);
    this.contractHash = opts.contractHash.startsWith('0x')
      ? opts.contractHash
      : '0x' + opts.contractHash;
    this.account = opts.privateKey ? new wallet.Account(opts.privateKey) : null;
    this.networkMagic = opts.networkMagic ?? DEFAULT_NETWORK_MAGIC;
    this.publishTimeoutS = opts.publishTimeoutSeconds ?? DEFAULT_PUBLISH_TIMEOUT_S;
  }

  /**
   * Read-only contract invocation: calls `getCalibration(agentId, domain)`
   * via the InvokeFunction RPC and decodes the returned struct.
   * Returns null if no record exists for the (agent, domain) pair.
   */
  async getCalibration(agentId: string, domain: string): Promise<CalibrationRecord | null> {
    const result = await this.rpcClient.invokeFunction(this.contractHash, 'getCalibration', [
      sc.ContractParam.string(agentId),
      sc.ContractParam.string(domain),
    ]);

    if (result.state !== 'HALT' || !result.stack || result.stack.length === 0) {
      return null;
    }

    const top = result.stack[0];
    // The contract returns null (Any with null value) when the record is missing.
    if (top.type === 'Any' && (top.value === null || top.value === undefined)) {
      return null;
    }
    if (top.type !== 'Array' || !Array.isArray(top.value)) {
      return null;
    }

    // Struct order matches CalibrationStore.cs:
    //   [agentId, domain, value (×10000), sampleSize, timestamp (ms), journalHash]
    const fields = top.value as Array<{ type: string; value: unknown }>;
    if (fields.length < 6) return null;

    return {
      agentId: decodeString(fields[0]),
      domain: decodeString(fields[1]),
      value: decodeInt(fields[2]) / 10000,
      sampleSize: decodeInt(fields[3]),
      timestamp: decodeInt(fields[4]),
      journalHash: decodeString(fields[5]),
    };
  }

  /**
   * Builds, signs, and broadcasts a `setCalibration` invocation. Polls the
   * RPC until the transaction is included in a block (or the timeout
   * expires), then returns the transaction hash. Throws if no signing key
   * is configured or if the broadcast fails.
   */
  async publishCalibration(record: CalibrationRecord): Promise<string> {
    if (!this.account) {
      throw new Error('Neo3 private key required for publishing calibration');
    }

    const valueScaled = Math.round(record.value * 10000);
    if (valueScaled < 0 || valueScaled > 10000) {
      throw new Error(`Calibration value out of range [0, 1]: ${record.value}`);
    }

    const script = sc.createScript({
      scriptHash: this.contractHash,
      operation: 'setCalibration',
      args: [
        sc.ContractParam.string(record.agentId),
        sc.ContractParam.string(record.domain),
        sc.ContractParam.integer(valueScaled),
        sc.ContractParam.integer(record.sampleSize),
        sc.ContractParam.integer(record.timestamp),
        sc.ContractParam.string(record.journalHash),
      ],
    });

    // Estimate system fee via dry-run invocation
    const dryRun = await this.rpcClient.invokeScript(
      u.HexString.fromHex(script),
      [{ account: this.account.scriptHash, scopes: 'CalledByEntry' }],
    );
    if (dryRun.state !== 'HALT') {
      throw new Error(
        `setCalibration dry-run failed: ${dryRun.state} ${dryRun.exception ?? ''}`.trim(),
      );
    }

    const currentHeight = await this.rpcClient.getBlockCount();
    const transaction = new tx.Transaction({
      script,
      systemFee: u.BigInteger.fromNumber(dryRun.gasconsumed),
      networkFee: u.BigInteger.fromDecimal('0.01', 8),
      validUntilBlock: currentHeight + 1000,
      signers: [{ account: this.account.scriptHash, scopes: 'CalledByEntry' }],
    });

    transaction.sign(this.account, this.networkMagic);

    const txHash = await this.rpcClient.sendRawTransaction(transaction);
    await this.waitForTransaction(txHash);
    return txHash;
  }

  /**
   * Verifies that an on-chain record matches what a fresh journal replay
   * would produce. Used by peers and registries to detect either a
   * tampered chain record or a tampered journal — whichever doesn't match
   * is the one to suspect.
   *
   * This is chain-agnostic: it doesn't talk to the chain at all, it just
   * recomputes from the supplied journal entries and compares values.
   */
  verify(record: CalibrationRecord, journalEntries: JournalEntry[]): boolean {
    const proposals = journalEntries.filter(e =>
      e.entryType === 'proposal_emitted'
      && (e as any).proposal?.agentId === record.agentId
      && (e as any).proposal?.domain === record.domain
      && (e as any).proposal?.calibrationAtStake === true,
    );

    const outcomesByDlb = new Map<string, JournalEntry>();
    for (const e of journalEntries) {
      if (e.entryType !== 'outcome_observed') continue;
      const existing = outcomesByDlb.get(e.deliberationId as string);
      if (!existing || new Date(e.timestamp as string) > new Date(existing.timestamp as string)) {
        outcomesByDlb.set(e.deliberationId as string, e);
      }
    }

    const pairs: { confidence: number; outcome: number; timestamp: number }[] = [];
    for (const p of proposals) {
      const outcome = outcomesByDlb.get(p.deliberationId);
      if (!outcome) continue;
      const success = (outcome as any).success;
      const outcomeValue = typeof success === 'boolean' ? (success ? 1 : 0) : Number(success);
      if (!Number.isFinite(outcomeValue)) continue;
      pairs.push({
        confidence: (p as any).proposal.confidence,
        outcome: outcomeValue,
        timestamp: new Date((outcome as any).observedAt || (outcome as any).timestamp).getTime(),
      });
    }

    if (pairs.length === 0 && record.sampleSize === 0) return true;

    const computed = computeCalibration(pairs, Date.now());
    return Math.abs(computed.value - record.value) < 0.01
      && computed.sampleSize === record.sampleSize;
  }

  /**
   * Polls `getapplicationlog` until the transaction is included in a
   * block. Throws on timeout or on transaction failure.
   */
  private async waitForTransaction(txHash: string): Promise<void> {
    const deadline = Date.now() + this.publishTimeoutS * 1000;
    while (Date.now() < deadline) {
      try {
        const log = await this.rpcClient.getApplicationLog(txHash);
        const execution = log.executions?.[0];
        if (execution) {
          if (execution.vmstate !== 'HALT') {
            throw new Error(
              `Calibration commit transaction failed: ${execution.vmstate} ${execution.exception ?? ''}`.trim(),
            );
          }
          return;
        }
      } catch (err) {
        // getApplicationLog throws while the tx is still pending; that's expected
        if (err instanceof Error && /Unknown transaction/i.test(err.message)) {
          // pending — keep waiting
        } else if (err instanceof Error && /committed|failed/i.test(err.message)) {
          throw err;
        }
      }
      await sleep(1000);
    }
    throw new Error(`Timed out waiting for calibration commit tx ${txHash} to be included`);
  }
}

// --- helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeString(field: { type: string; value: unknown }): string {
  if (field.type === 'ByteString' && typeof field.value === 'string') {
    // Neo3 RPC returns ByteString values as base64 — decode to UTF-8
    try {
      return Buffer.from(field.value, 'base64').toString('utf-8');
    } catch {
      return String(field.value);
    }
  }
  return String(field.value ?? '');
}

function decodeInt(field: { type: string; value: unknown }): number {
  if (field.type === 'Integer') {
    if (typeof field.value === 'string') return parseInt(field.value, 10);
    if (typeof field.value === 'number') return field.value;
    if (typeof field.value === 'bigint') return Number(field.value);
  }
  return Number(field.value ?? 0);
}

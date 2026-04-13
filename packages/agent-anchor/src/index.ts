/**
 * adp-agent-anchor — optional Neo3 blockchain anchor for ADP calibration snapshots.
 *
 * Used together with `adp-agent`. The anchor scheduler runs in-process
 * inside an agent; on a schedule, it builds the agent's current signed
 * calibration snapshot and commits the (value, sampleSize, journalHash)
 * tuple to a Neo3-compatible chain via the configured BlockchainCalibrationStore.
 *
 * Minimal use:
 *
 *     import { AdpAgent } from 'adp-agent';
 *     import { createAnchorStore, CalibrationAnchorScheduler } from 'adp-agent-anchor';
 *
 *     const agent = new AdpAgent(config);
 *     if (config.calibrationAnchor?.enabled) {
 *       const store = createAnchorStore(config.calibrationAnchor);
 *       if (store) {
 *         const scheduler = new CalibrationAnchorScheduler(
 *           config, store, () => agent.getJournal().listDeliberationsSince(new Date(0), 10000).flatMap(r => r.entries),
 *         );
 *         agent.afterStart(() => scheduler.start());
 *         agent.beforeStop(() => scheduler.stop());
 *       }
 *     }
 *     await agent.start();
 */

export type { CalibrationRecord, BlockchainCalibrationStore } from './blockchain.js';
export { MockBlockchainStore } from './blockchain-mock.js';
export { Neo3BlockchainStore } from './blockchain-neo3.js';
export type { Neo3StoreOptions } from './blockchain-neo3.js';
export {
  createAnchorStore,
  CalibrationAnchorScheduler,
} from './calibration-anchor.js';

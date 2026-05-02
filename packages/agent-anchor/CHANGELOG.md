# Changelog

All notable changes to `@ai-manifests/adp-agent-anchor` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] - 2026-05-02

### Fixed (packaging)
- **`@ai-manifests/adp-agent` is now a `peerDependency` at `^0.5.0`** (was a
  regular `dependency` at `^0.3.0`). The anchor extends the agent runtime
  rather than embedding it; the regular-dep pin produced a duplicate install
  in consumers (their top-level `^0.5.0` resolved to `0.5.0`, but the
  anchor's nested `^0.3.0` constraint forced npm to install `0.3.0` under
  `node_modules/@ai-manifests/adp-agent-anchor/node_modules/`). The
  `0.4.0` and `0.5.0` CHANGELOG entries described this dep as a peer-dep
  but the actual `package.json` was never updated to match. This release
  brings the manifest into agreement with the documented design.
- A matching `devDependency` on `@ai-manifests/adp-agent@^0.5.0` is added
  so the anchor's own build and test commands resolve the runtime locally.

### Migration
- Consumers who already declare `@ai-manifests/adp-agent` at the top level
  of their `package.json` (the supported configuration) need only run
  `npm install` to deduplicate. The previously-installed nested `0.3.0`
  copy is removed; the top-level `0.5.x` copy is the only install left.
- Consumers who relied on the anchor pulling in `@ai-manifests/adp-agent`
  transitively (i.e. did not declare it themselves) must add it as a
  direct dependency. This was already the documented pattern in the
  README; the manifest now enforces it.

## [0.5.0] - 2026-05-02

### Changed
- Peer dependency `@ai-manifests/adp-agent` updated to `^0.5.0`. The
  underlying runtime fixes the ADP §7.2 / §7.3 terminal-state
  misclassification (non-converged deliberations now default to
  `deadlocked` instead of `partial_commit`). See
  `@ai-manifests/adp-agent` 0.5.0 CHANGELOG for full detail and
  migration notes.
- No changes to the anchor scheduler, blockchain store, or Neo3 client.
  Bumped in lockstep so the monorepo tags one coherent release.

## [0.4.0] - 2026-05-02

### Changed
- Peer dependency `@ai-manifests/adp-agent` updated to `^0.4.0`. The
  underlying runtime adds `PeerTransport.registerAgent` (required
  interface method) and fixes the initiator self-URL → self-agentId
  binding that produced 401 errors on self-proposal under bearer-token
  auth. See `@ai-manifests/adp-agent` 0.4.0 CHANGELOG for full detail.
- No changes to the anchor scheduler, blockchain store, or Neo3 client
  itself. The version is bumped in lockstep so the monorepo tags one
  coherent release across both packages.

## [0.3.0] - 2026-04-14

### Changed
- Peer dependency `@ai-manifests/adp-agent` updated to `^0.3.0`. The underlying runtime ships a breaking change to `canonicalize` that fixes an integrity hole in proposal signing. See `@ai-manifests/adp-agent` CHANGELOG for details.
- No changes to the anchor scheduler, blockchain store, or Neo3 client itself. The version is bumped in lockstep so the monorepo tags one coherent release.

## [0.2.1] - 2026-04-14

### Fixed
- **README license section corrected.** `0.2.0` shipped with `package.json` and `LICENSE` correctly set to Apache-2.0, but the README's closing license section still read `CC0-1.0 — treat as public domain` — a leftover from the `0.1.0` era that was missed during the relicense. The README renders as the package description on npmjs.com, so the inconsistency was visible to anyone viewing the package page. No code or license-metadata changes; documentation-only patch.

## [0.2.0] - 2026-04-14

### Changed
- **License: CC0-1.0 → Apache-2.0.** This is the sole reason for the minor version bump. The previous `0.1.0` release was licensed CC0-1.0, which is silent on patent rights and lacks the contributor patent grant that enterprise legal teams expect when approving protocol reference implementations. Switching to Apache-2.0 provides an explicit patent grant from every contributor to every user — the industry-standard pattern for protocol families such as Protocol Buffers, Kubernetes, gRPC, and OpenTelemetry — and removes the legal-review friction that CC0 introduces for downstream adopters. The code itself is unchanged from `0.1.0`; only the license, `LICENSE` file, `NOTICE` file, and `author` metadata have been updated.
- `author` field set to `David H. Friedel Jr. — MarketAlly`.
- Peer dependency `@ai-manifests/adp-agent` updated to `^0.2.0` to match the lockstep version bump.

### Added
- `LICENSE` file containing the full Apache-2.0 license text.
- `NOTICE` file per Apache-2.0 convention, identifying the copyright holder.

## [0.1.0] - 2026-04-13

### Added
- Initial release.
- `BlockchainCalibrationStore` interface with `Neo3BlockchainStore` and `MockBlockchainStore` implementations.
- `CalibrationAnchorScheduler` — periodic publisher that commits signed calibration snapshots to a Neo3-compatible chain on a configurable interval.
- Support for `mock`, `neo-express`, `neo-custom`, `neo-testnet`, and `neo-mainnet` targets via a single `Neo3BlockchainStore` client.

> **Note:** `0.1.0` was released under CC0-1.0. See `0.2.0` for the license correction and rationale.

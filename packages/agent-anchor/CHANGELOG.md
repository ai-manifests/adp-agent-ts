# Changelog

All notable changes to `@ai-manifests/adp-agent-anchor` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

# Changelog

All notable changes to `@ai-manifests/adp-agent` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-04-14

### Changed (breaking)
- **`canonicalize` now produces a correct recursive canonical JSON form.** The previous implementation passed `Object.keys(copy).sort()` as the `replacer` argument to `JSON.stringify`, which — per the `replacer`-as-array semantics — silently dropped every nested object field whose name did not happen to match a top-level proposal key. In practice the old algorithm signed only top-level scalars and produced something like `{"agentId":"x","justification":{},"dissentConditions":[{}]}` regardless of what was actually inside `justification` or `dissentConditions`. That was both an integrity hole (nested tampering went undetected) and a cross-language incompatibility (any sane C# / Python canonicalize would produce different bytes).
- The new `canonicalize` recursively sorts object keys at every level, preserves array order, and serializes primitives via standard JSON — a simplified RFC 8785 (JCS) variant sufficient for ADP data shapes.
- **Signatures produced by `0.2.x` and earlier will NOT verify against `0.3.0` and later.** Signatures are ephemeral (one per deliberation round) so nothing persistent is affected, but any federation running a mix of `0.2.x` and `0.3.0` agents will fail signature verification on peer proposals until all peers upgrade.

### Added
- `canonicalizeValue(value)` exported alongside `canonicalize(proposal)` — the underlying recursive serializer, exposed for golden-vector testing and cross-language parity validation.

### Migration
- Upgrade every peer in a federation simultaneously. Do not run a mixed `0.2.x` / `0.3.0` federation.
- If you pinned `0.2.1` anywhere in a `package.json` you control, bump to `^0.3.0`.

## [0.2.1] - 2026-04-14

### Fixed
- **README license section corrected.** `0.2.0` shipped with `package.json` and `LICENSE` correctly set to Apache-2.0, but the README's closing license section still read `CC0-1.0 — treat as public domain` — a leftover from the `0.1.0` era that was missed during the relicense. The README renders as the package description on npmjs.com, so the inconsistency was visible to anyone viewing the package page. No code or license-metadata changes; documentation-only patch.

## [0.2.0] - 2026-04-14

### Changed
- **License: CC0-1.0 → Apache-2.0.** This is the sole reason for the minor version bump. The previous `0.1.0` release was licensed CC0-1.0, which is silent on patent rights and lacks the contributor patent grant that enterprise legal teams expect when approving protocol reference implementations. Switching to Apache-2.0 provides an explicit patent grant from every contributor to every user — the industry-standard pattern for protocol families such as Protocol Buffers, Kubernetes, gRPC, and OpenTelemetry — and removes the legal-review friction that CC0 introduces for downstream adopters. The code itself is unchanged from `0.1.0`; only the license, `LICENSE` file, `NOTICE` file, and `author` metadata have been updated.
- `author` field set to `David H. Friedel Jr. — MarketAlly`.

### Added
- `LICENSE` file containing the full Apache-2.0 license text.
- `NOTICE` file per Apache-2.0 convention, identifying the copyright holder.

## [0.1.0] - 2026-04-13

### Added
- Initial release extracted from `adp-federation-prototype`.
- `AdpAgent` class (manifest, calibration snapshot, deliberation, journal, MCP, ACB, middleware).
- `JournalStore` interface with `JsonlJournal` and optional `SqliteJournal` backends.
- `PeerDeliberation` state machine.
- Ed25519 proposal signing and signed calibration snapshots (ADJ §7.4).
- ACB pricing, contribution tracking, and settlement.
- MCP tool server.

> **Note:** `0.1.0` was released under CC0-1.0. See `0.2.0` for the license correction and rationale.

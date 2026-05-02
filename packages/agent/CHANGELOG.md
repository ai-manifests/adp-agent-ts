# Changelog

All notable changes to `@ai-manifests/adp-agent` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-05-02

### Fixed — `/api/record-outcome` gossip used wildcard token lookup

Outcome gossip from `POST /api/record-outcome` to peer `/adj/v0/entries`
hardcoded `authHeaders(config.auth, '*')` for the `Authorization` header.
That looked up `peerTokens['*']` regardless of which peer was being
contacted, so federations that (correctly) use per-agent tokens — keying
`peerTokens` by `did:adp:peer-agent-id` with no wildcard fallback — got
no `Authorization` header and were rejected `401` by the receiving peer's
auth middleware. The outcome was written locally but never propagated.

The fix builds a URL → agentId map from `config.peers` and uses
`authHeaders(config.auth, peerAgentId)` per peer. The wildcard `'*'`
remains as a soft fallback for ad-hoc URLs in the request body that
aren't in `config.peers`.

This matches the same architectural pattern the deliberation runner
already uses via `transport.headers(peerUrl)` and `registerAgent`.
Symptom in the field: a monitor agent's outcome plugin reports outcomes
locally but no peer's calibration ever updates. Now fixed.

### Note on cross-language parity
- The C# port (`Adp.Agent`) does not implement outcome gossip at all —
  `POST /api/record-outcome` writes to the local journal only. Tracked
  for parity in a later release.
- The Python port (`adp-agent`) follows the C# behavior on this surface
  (local-journal write, no peer gossip).

## [0.5.0] - 2026-05-02

### Fixed (breaking default change) — ADP §7.2 / §7.3 terminal state classification

`0.4.x` and earlier hardcoded `determineTermination(tally, true)` in
`PeerDeliberation.run()`, which meant **every non-converged deliberation
was classified as `partial_commit`**, regardless of whether the action
was actually decomposable. ADP §7.2 explicitly requires both that the
action have independently-executable sub-actions AND that a reversible
sub-action meet simple majority on its own sub-tally; without those, the
spec-correct terminal state is `deadlocked` (§7.3).

The misclassification meant federation-health metrics (notably any
"deadlock rate" derived metric) read zero against federations that were
in fact deadlocking, and any downstream escalation logic that fired on
`deadlocked` (per §7.3 — "the deliberation is escalated with the full
debate trace") never triggered.

### Added
- New optional callback on `DeliberationRunOptions`:
  ```ts
  hasReversibleSubset?: (
    action: { kind: string; target: string; parameters?: Record<string, string> },
    finalTally: TallyResult,
  ) => boolean;
  ```
  The runner invokes this with the final tally before classification.
  When omitted (or returns `false`), non-converged outcomes resolve
  as `deadlocked`. When the callback returns `true`, they resolve as
  `partial_commit`. Decomposition is action-kind-specific, so the
  decision belongs to the caller — the runner does not attempt to
  recompute a sub-tally on its own.

### Changed (breaking default)
- Without an explicit `hasReversibleSubset` callback, non-converged
  deliberations now resolve as **`deadlocked`** (was `partial_commit`).
  This is the spec-correct default for atomic actions
  (`merge_pull_request`, `deploy`, `revoke_token`, …) which is the
  vast majority of real-world deliberations.

### Migration
- Adopters whose actions are genuinely decomposable (`apply_terraform_plan`
  with per-resource sub-actions, batched-config-change PRs with per-file
  sub-actions, etc.) must add `hasReversibleSubset` to their
  `run(action, tier, options)` call and return `true` only when both
  conditions in §7.2 hold.
- Adopters relying on the `partial_commit` label without actually having
  a reversible subset were already in spec violation; the new default
  surfaces this explicitly. Their `deliberation_closed.termination`
  values will flip from `partial_commit` to `deadlocked` for any
  deliberation that hits the non-converged path. If escalation handlers
  were keyed on `partial_commit`, rewire them to fire on `deadlocked`.

### Tests
- `tests/deliberation.termination.test.ts` — covers default-deadlocked,
  explicit-partial-commit, and callback argument shape.

## [0.4.0] - 2026-05-02

### Added (breaking interface change)
- **`PeerTransport.registerAgent(peerUrl, agentId)`** — required method on the
  `PeerTransport` interface that binds a URL to an agent id in the transport's
  internal lookup map. Implemented by `HttpTransport` (writes to its
  `peerAgentIds` map) and `McpTransport` (no-op; MCP routing doesn't use the
  map). External implementors of `PeerTransport` must add this method —
  hence the minor version bump.

### Fixed
- **Initiator self-proposal no longer 401s under bearer-token auth.** Before
  this fix, the deliberation runner set `peerUrlMap[self.agentId] = selfUrl`
  but never told the transport about that binding. The transport's
  `peerAgentIds` map (URL → agentId, used by `headers()` to resolve the
  right peer-token via `auth.peerTokens[agentId]`) only got populated as a
  side-effect of `fetchManifest` — and the initiator never fetches its own
  manifest because it already knows what's in it. Result: every outgoing
  call from the deliberation runner to the self URL (the self-proposal
  request, the self-journal calibration fetch, the journal gossip push)
  fell back to the wildcard `'*'` lookup in `peerTokens`, which produced
  no `Authorization` header, which made the agent's own auth middleware
  reject the call with `401`. The deliberation aborted with `fetch failed`
  before any journal entries were written.
- The fix is a single new line in `PeerDeliberation.run()` after the self
  URL is set: `this.transport.registerAgent(selfUrl, this.self.agentId)`.
  Self-proposal calls now resolve `peerTokens[self.agentId]` correctly,
  the agent authenticates to itself with its own bearer, and the
  deliberation closes with a clean journal entry. Regression test:
  `tests/deliberation.transport.test.ts`.

### Migration
- Consumers using the bundled `HttpTransport` or `McpTransport` need only
  update the dependency — both implementations ship the new method.
- Consumers with custom `PeerTransport` implementations must add a
  `registerAgent(peerUrl: string, agentId: string): void` method. The
  simplest correct implementation is `this.peerAgentIds.set(peerUrl, agentId)`
  for HTTP-style transports, or a no-op for transports that don't use a
  URL→agentId map.

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

# Provider evidence and testing

Read before adding or changing provider-facing behavior and its regression evidence.

These are normative maintainer rules, complementary to `ARCHITECTURE.md`,
which remains the infrastructure model's source of truth. Load only the sections
relevant to the task. Paths in code spans are relative to the repository root.

Related contracts: [Pinned provider contracts](../test/provider-contracts/README.md) and [provider conformance](provider-conformance.md).

Stable rule IDs preserve the original guidance and are mapped in
[the migration audit](development-guidance-migration.json). These files are
for developing Hypervibe; the distributed user workflow lives in
[`skills/hypervibe`](../skills/hypervibe/SKILL.md).

## DG-017

Before implementing a provider-facing capability, define or extend the shared contract and check it against every named supported provider in the affected registry category, using official contracts/source. Record the named provider matrix, native identity/completion/recovery differences, prerequisites, and explicit unsupported or unverified cases before adding an adapter. Do not let the first provider's API shape become the shared contract or implement a one-off provider path around it. Keep registry-completeness and shared conformance tests in normal CI so a new provider cannot silently escape that review; contract coverage does not imply implemented or live-verified support.

## DG-018

Treat existing code, comments, mocks, and previous agent conclusions as hypotheses, not independent proof of provider behavior. Before fixing a provider bug, state the assumption being challenged, cite independent evidence, and identify a concrete counterexample that would falsify it. If evidence is unavailable, label the gap; do not present a guess as a verified fix.

## DG-019

Follow `test/provider-contracts/README.md`. Reproduce the counterexample in a failing test through the real client and serialized transport before changing runtime code. Derive expected responses from pinned official contracts/source or redacted real responses, never solely from our types, implementation, or submitted request. Mock only the transport in API contract tests; label recorded, reconstructed, and synthetic evidence honestly.

## DG-020

Check what the pinned schema actually constrains. Opaque JSON/scalars do not validate nested fields or their semantics. Source those expectations independently, exercise valid omitted/null/defaulted fields where the contract permits them, and keep malformed shapes in negative tests. Exercise every discriminator/union variant from the specific endpoint's published schema; a related webhook or summary API does not establish its full event vocabulary. Update schema pins only in reviewed changes, never by fetching upstream schemas during tests.

## DG-021

For protobuf JSON responses, distinguish implicit scalar defaults from missing resource identity. Normalize documented false/empty defaults at the provider boundary across reads and convergence checks; retain exact identity and explicit-success requirements before writes. Exercise omitted defaults through the real client instead of fixtures that always spell out every field.

## DG-022

Compare every affected interpretation across plan, apply, observation/status, and retry/recovery. Test relevant second-environment isolation, pagination, delayed visibility, unknown reads, and ambiguous writes through the real adapter and shared lifecycle. Reuse existing interpretation logic when semantics are the same; do not patch one predicate while leaving contradictory rules elsewhere.

## DG-023

Execute generated operational scripts in contract tests, including rejected and uncertain writes, operation/target correlation, terminal absence and secret-safe diagnostics. A request attempt does not establish cleanup ownership; require verified creation or independently observed ownership before compensation. Source-string assertions cannot prove these boundaries.

## DG-024

Complete the PR template's assumption/evidence/counterexample/test record, including observed failure before the fix and the passing result afterward. Distinguish a reproduced bug from the proven cause of a customer incident, and state remaining coverage gaps. Offline contracts and passing test counts do not establish live support.

## DG-025

Keep regression tests in the ordinary `npm test` acceptance gate, not only an opt-in or scheduled suite. Verify both the committed workflow and desired required-check configuration before claiming CI coverage; do not claim live branch-protection enforcement from repository files alone.

## DG-069

Require lifecycle contract tests for noop mutation freedom, action-scoped mutation authority, observation errors, duplicate identities, import round trips, billable/data-bearing confirmation, and idempotent deletion. Database lifecycle changes must run the same contract against Railway, Supabase, Cloud SQL, and RDS.

## DG-079

Treat provider support as an evidence ladder. Schema or registry presence, adapter code, documentation, and mocked tests may establish `ready-for-live`, but they never substitute for a successful recent live lifecycle contract. Keep public docs, provider metadata, capability matrices, and live-evidence status aligned; when they disagree, preserve the lower proven status and report the gap rather than describing the feature as supported.

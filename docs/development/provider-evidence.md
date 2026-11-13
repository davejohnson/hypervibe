# Provider evidence and testing

Read before adding or changing provider-facing behavior and its regression evidence.

These are normative maintainer rules, complementary to `ARCHITECTURE.md`,
which remains the infrastructure model's source of truth. Load only the sections
relevant to the task. Paths in code spans are relative to the repository root.

Related contracts: [Pinned provider contracts](../../test/provider-contracts/README.md) and [provider conformance](../provider-conformance.md).

## Existing-zone DNS evidence

The shared DNS engine implements scoped A, AAAA, CNAME, TXT, CAA and MX records
with exact imports and encrypted state for these provider pins:

| Provider | Pin | Ordinary CI evidence | Installed live lifecycle |
| --- | --- | --- | --- |
| Cloudflare | 5.19.1 | Actual provider init/validate; individual-record identity and imports | Unverified |
| Google Cloud DNS | 8.9.0 | Actual provider init/validate; authoritative RRset imports and preserved sibling values | Unverified |
| Amazon Route 53 | 6.40.0 | Actual provider init/validate; scoped RRset imports without overwrite permission | Unverified |
| Azure DNS | 4.65.0 | Actual provider init/validate; ARM-scoped RRsets and imports without automatic provider registration | Unverified |

Checksums were obtained with real OpenTofu provider locking for Darwin/Linux,
AMD64/ARM64. The [backend evidence](../../src/adapters/dns/tofu/README.md) links
the pinned primary schemas. Read-only observer transport fixtures, shared
plan/apply boundary regressions, and Pages/email consumer ordering run in normal
CI. They establish local behavior and provider configuration compatibility, not
cloud authentication, successful import/apply, propagation, certificates or native
absence after a live teardown. Installed live profile requirements are described
in [provider conformance](../provider-conformance.md); no live pass is asserted here.

Only existing explicitly selected zones are supported by the configuration.
Zone creation, DNSSEC signing, registrar DS/delegation changes and automatic CAA
security policy mutations are unavailable. Security requirements are observed
and blocked when unsatisfied or unknown. DNS provider selection does not promote
the corresponding hosting provider's capability status.

Stable rule IDs preserve the original guidance and are mapped in
[the migration audit](guidance-migration.json). These files are
for developing Hypervibe; the distributed user workflow lives in
[`skills/hypervibe`](../../skills/hypervibe/SKILL.md).

## DG-017

Start with the smallest complete user journey on one target cloud, then extend
it. Define the shared boundary from application intent, authorization and required
outcomes; use official provider evidence for native identity, completion and
failure semantics. Keep unsupported or unverified paths explicit rather than
making the first provider's API shape the universal contract.

For the OpenTofu path, verify the generated configuration, pinned provider versions,
real engine plan/apply behavior and resulting app together. Use the real pinned
binary for configuration and engine-boundary checks where meaningful; mocks or
source-string assertions cannot prove generated configuration is executable.
Do not rebuild provider schemas or custom resource CRUD for all clouds, or require
all clouds to be live before delivering one proven path. Extend shared regression
coverage as each capability becomes reachable.

Review affected implementations when a shared boundary changes. For an
adapter-local fix that preserves the shared contract, reuse verified evidence and
investigate only the affected assumptions; do not restart a full provider review.

Every implemented infrastructure provider needs a disposable live lifecycle
profile through the installed Hypervibe workflow: create, verify the fixture app
and resources, update, verify a noop, tear down, and independently confirm exact
native resource absence. Capture identities before teardown and after partial
applies. An empty plan, missing local binding, or successful delete request is
not deletion evidence. Preserve recovery state and fail the run if cleanup is
failed or unknown. Reusable test account/project prerequisites are separate from
the environment resources created by each run.

Keep profile coverage and the lifecycle harness's failure/cleanup checks in
ordinary acceptance. Live runs require configured dedicated test access and
exact infrastructure approval; missing access or an unimplemented provider must
be reported explicitly, never counted as a live pass. Record the tested source
revision with the complete lifecycle evidence before claiming support.

## DG-018

Treat existing code, comments, mocks, and previous agent conclusions as hypotheses, not independent proof of provider behavior. Before fixing a provider bug, state the assumption being challenged, cite independent evidence, and identify a concrete counterexample that would falsify it. If evidence is unavailable, label the gap; do not present a guess as a verified fix.

## DG-019

Follow `test/provider-contracts/README.md`. Reproduce the counterexample in a failing test through the real client and serialized transport before changing runtime code. Derive expected responses from pinned official contracts/source or redacted real responses, never solely from our types, implementation, or submitted request. Mock only the transport in API contract tests; label recorded, reconstructed, and synthetic evidence honestly.

## DG-020

Check what the pinned schema actually constrains; opaque fields do not establish nested semantics. Source expectations independently and test affected variants, documented omitted/null/defaulted fields and malformed responses. Cover all variants when changing a shared decoder or claiming full endpoint coverage, not for an unrelated adapter fix. Use the specific endpoint's contract, not a related API's vocabulary. Update pins in reviewed changes; never fetch upstream schemas during tests.

## DG-021

For protobuf JSON responses, distinguish implicit scalar defaults from missing resource identity. Normalize documented false/empty defaults at the provider boundary across reads and convergence checks; retain exact identity and explicit-success requirements before writes. Exercise omitted defaults through the real client instead of fixtures that always spell out every field.

## DG-022

Compare every affected interpretation across plan, apply, observation/status, and retry/recovery. Test relevant second-environment isolation, pagination, delayed visibility, unknown reads, and ambiguous writes through the real adapter and shared lifecycle. Reuse existing interpretation logic when semantics are the same; do not patch one predicate while leaving contradictory rules elsewhere.

## DG-023

Execute generated operational scripts in contract tests, including rejected and uncertain writes, operation/target correlation, terminal absence and secret-safe diagnostics. A request attempt does not establish cleanup ownership; require verified creation or independently observed ownership before compensation. Source-string assertions cannot prove these boundaries.

## DG-024

Complete the PR template's assumption/evidence/counterexample/test record, including observed failure before the fix and the passing result afterward. Distinguish a reproduced bug from the proven cause of a customer incident, and state remaining coverage gaps. Offline contracts and passing test counts do not establish live support.

## DG-025

Keep regressions in ordinary `npm test`, not only an opt-in or scheduled suite. Follow [DG-134](workflow.md#dg-134) for CI wiring and reuse of verified evidence.

## DG-069

Keep lifecycle boundary regressions in ordinary required CI: noop mutation
freedom, exact action authority, stale plan rejection, present/absent/unknown
observations, scoped identity, secret-safe results, billable/data-bearing
confirmation, concurrency and confirmed deletion. Cover partial execution and
uncertain retries across Hypervibe actions and the engine boundary.

Run meaningful generated-configuration and real pinned-binary checks for the
implemented engine path. Test affected retained Railway/integration clients through
their actual transport boundary. Explicit adoption needs round-trip coverage only
where that capability is supported and being changed; the unused GCP prototype
does not require an import project. Do not impose an obsolete all-provider matrix
or rewrite provider CRUD as a prerequisite for one complete cloud journey.

## DG-079

Treat support as an evidence ladder for each exact capability and version.
A schema, registry entry, generated file, adapter or mocked test does not prove
an integrated engine path or a live deployment. Record the checks completed and
the gaps before declaring a path ready for live validation; only successful,
recent live evidence can establish supported behavior. Keep public documentation,
capability metadata and evidence status aligned. When they disagree, report the
lower proven status. Engine adoption does not carry old provider support claims
forward automatically.

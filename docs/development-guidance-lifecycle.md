# Lifecycle, identity, and reconciliation

Read before changing spec, plan/apply, observations, resource identities, naming, runtime changes, import, or destruction.

These are normative maintainer rules, complementary to `ARCHITECTURE.md`,
which remains the infrastructure model's source of truth. Load only the sections
relevant to the task. Paths in code spans are relative to the repository root.

Related contracts: [State Ownership](../ARCHITECTURE.md#state-ownership), [Platform Bindings](../ARCHITECTURE.md#platform-bindings), and [Reconciliation Safety Invariants](../ARCHITECTURE.md#reconciliation-safety-invariants).

Stable rule IDs preserve the original guidance and are mapped in
[the migration audit](development-guidance-migration.json). These files are
for developing Hypervibe; the distributed user workflow lives in
[`skills/hypervibe`](../skills/hypervibe/SKILL.md).

## DG-026

Keep known public endpoints separate from desired DNS management. Hosted monitoring may use exact committed public-service bindings and scoped provider observations; never infer a domain or DNS provider from a project name, discard known URLs because DNS is unmanaged, or turn read-only discovery into adoption or mutation. Preserve endpoint source, environment, public-service defaults, and safe URL filtering across import and refresh.

## DG-035

Keep the desired-state loop central: `hv_spec` defines intent, `hv_plan` computes drift and blocked work, `hv_apply` converges a specific plan, and `hv_status` verifies convergence.

## DG-036

Lifecycle infrastructure changes belong in spec/plan/apply. Do not hide creates, attaches, purchases, migrations, deploy-source changes, DNS changes, schedules, or destroys inside CI, diagnostics, or helper tools.

## DG-037

Treat the persisted plan as an authorization boundary. An apply handler may mutate only the resource and operation named by its current non-noop action; dependencies must be explicit plan edges. Never let a service, environment-variable, secret, deploy, or diagnostic action implicitly create, repair, attach, or destroy a database or another unrelated resource.

## DG-038

A noop action must cause zero provider mutations. When a live resource exists but its local binding is missing, plan explicit adoption/binding reconciliation or block with guidance; do not silently adopt it and do not create a replacement from a shared bootstrap path.

## DG-039

Treat observation as present/absent/unknown. Only a provider-confirmed not-found response proves absence. Permission errors, unsupported observation, partial reads, timeouts, rate limits, and provider failures must block or preserve affected state; never turn them into an empty list/null/false that can plan a create or destroy. A response that omits a selected field is incomplete evidence, even when its HTTP status succeeds; distinguish omission from a contract-permitted null or false value before comparing desired state.

## DG-040

Hosted observation must verify exact source provenance and independently authorized provider scope. Never repair a stale binding by choosing a same-named resource. Bound work before per-resource reads and retain explicit unknown/unsupported field coverage; the existence of a recent report does not establish convergence. Redact exact supplied credentials even when a provider echoes them in ordinary labels.

## DG-041

Test first deployment with no local environment row as well as existing and partially bound environments. When generated-secret observation depends on an absent hosting identity, isolate the reviewed project bootstrap and re-plan before authorizing workloads or secret writes; never mark unknown destinations absent to break the dependency cycle.

## DG-042

Resolve resource identity by durable provider id first. Name matches are adoption candidates only; detect and block multiple matching services, databases, buckets, queues, projects, apps, or domains instead of choosing the first.

## DG-043

Keep resource naming in the shared deterministic naming policy. Provider adapters supply only documented namespace, length, alphabet, and reserved-name constraints; generic orchestration must not branch on provider names or duplicate naming formulas. Use plain logical names inside native environment namespaces, and one short scope discriminator where the namespace is shared. Do not concatenate the parent hierarchy into child names.

## DG-044

Treat naming changes as lifecycle changes, not cosmetic string edits. Audit spec, plan, apply, observation/status, import, uncertain-write recovery, runtime wiring, generated CI, and teardown together. Existing provider IDs, recorded physical names, explicit names, and recovery markers outrank new defaults; never automatically rename or replace them. Legacy-name discovery is read-only and must block unknown or ambiguous ownership before a new create.

## DG-045

A cross-provider naming change is incomplete until tests cover the affected native namespaces, two environments with the same logical names, normalization/truncation collisions, preserved legacy bindings, and mutation-free noop. Exercise real adapters and shared plan/apply paths with independently sourced provider contracts where available; a formatter snapshot, source-string assertion, or matching mock alone is not lifecycle or live API evidence. Extend these cases when adding a provider instead of copying its predecessor's naming code.

## DG-046

When a provider resource id is scoped by project, account, region, or environment, preserve the provider-native id and present its scope beside it in bindings, observations, and human output. Matching unscoped ids alone must never imply that two environments share the same data instance.

## DG-047

When a new prerequisite rejects legacy metadata, provide a reviewed, preservation-safe normalization path where independent observation can prove the missing identity. Route it through the existing isolated metadata repair before requiring that repaired field; never bypass unresolved state into unrelated full-plan actions. Preserve unsupported-capability and pending-recovery vetoes. Do not recommend re-import as a narrow repair when it replaces accepted state. Test repair followed by ordinary observation and noop reconciliation; the repair and every existing reader must agree on the complete scope. Also exercise re-entry into full planning with deferred secret inputs and runtime overrides; a correct isolated prerequisite plan does not prove that ordinary work resumes.

## DG-048

On request-scaled platforms, background workers must explicitly receive continuous/instance CPU and a nonzero runtime floor; web services must explicitly preserve request-based CPU when the provider requires a value. Provider contract tests must cover both shapes and ensure one-off jobs do not inherit service-only CPU settings.

## DG-049

Treat health probes as per-service runtime configuration. Apply and verify a declared probe for web or worker services across direct and generated-CI paths; only one-off jobs categorically omit HTTP probes.

## DG-050

Release commands must run from the exact candidate image with its reviewed runtime configuration before any runtime workload changes. Correlate the provider's exact execution identity, fail before rollout on missing or failed evidence, store only a versioned command hash for drift, and keep direct, GitHub, and portable CI behavior aligned.

## DG-051

Any reviewed plan that asks a provider to build from a mutable branch must freeze the full source commit first and require provider-resolved provenance to match it before creating or updating release resources. Never treat a branch name, caller-supplied digest, or unverified build result as immutable release evidence.

## DG-058

Keep application workload kind separate from provider resource type. A cron workload may be a provider service; derive `service` versus `job` only from the durable provider binding and cover mixed web/worker/cron topology through the real spec-to-workflow path.

## DG-059

For scheduled workloads that require an initial CI release, separate untriggered resource preparation from reviewed trigger activation. Preserve pending identity through failures, keep activation out of the applied-marker prerequisite cycle, and require exact release evidence plus a fresh resource-identity check before activating. Exercise emitted CI updates as well as plan/apply; a later identity check cannot excuse an earlier write to a same-named replacement.

## DG-067

Make creates and destroys retry-safe and honest. Billable or data-bearing actions require exact action-id confirmation; deletes must treat already-absent as success, wait for realistic provider completion, verify terminal absence, and only then remove local bindings. A helper resource created before its durable parent binding must be exact-identity compensated on later failure or retained as explicit recovery state; a retry must never silently adopt it. A successful provider mutation is acknowledgment, not convergence: boundedly re-observe the exact identity, revision and changed fields before issuing dependent mutations or storing convergence. A successful skipped receipt cannot prove an update or authorize clearing its binding.

## DG-068

Order multi-resource destroys by dependency and stop on unknown or failed deletion. Never delete a datastore volume, bucket contents, security group, credential, or other dependent resource after deletion of its owning resource failed or could not be verified.

## DG-070

A storage provider id is supported only with a registered adapter covering private creation, ownership-safe observation, runtime wiring, streaming list/get/put, and confirmed teardown. Schema acceptance or an S3-shaped example alone is not provider support.

## DG-071

Storage placement belongs in desired state, not connection credentials. Reuse an explicitly compatible primary cloud connection for storage and derive provider runtime credentials during apply; never require operators to fetch a second bucket/account/HMAC key when the connected cloud identity can create it safely.

## DG-074

Generic commands such as `hv_inspect` and `hv_import` must not default to, narrow their schema to, expose identifier fields for, or dispatch directly to one provider. Accept registered provider names, route through declared capabilities/provider-owned drivers, and return explicit `UNSUPPORTED` for a missing capability. Keep provider names, API shapes, and provider-specific mapping logic out of `src/tools`; contract tests must scan the full registered tool surface for regressions.

## DG-075

Report honestly. Do not return success unless provider receipts, health checks, logs, or live observation prove the intended state. Use explicit failed/skipped/pending/blocked receipts for partial progress.

## DG-077

Read-only inspection must not adopt repository edits, bootstrap legacy desired state, or write local environment files. Exercise changed and absent spec journals through the real command boundary; a helper named `get` may still write.

## DG-078

Run-to-completion markers must be standalone provider log entries; caller-controlled values echoed in ordinary output cannot prove an exit. Named CI tasks share their environment's deployment lock, never sweep another operation's resources, and reject reruns of an uncertain workflow execution. Prove credential scope during owner-authorized reconciliation rather than requiring CI's minimal token to list secret metadata.

## DG-080

Carry every declarative provider field through validation, observation, fingerprints, drift, action stale checks, create/update requests, receipts, and durable state; partial field support is not reconciliation.

## DG-090

Stale-plan fingerprints must include both environment-variable hashes and sorted key presence. Providers may mask secret values, so a newly present or removed key is meaningful state even when no hash is available.

## DG-091

Consequential confirmation is part of mutation authority, not a caller-only flag. At apply time, recompute the transition from fresh provider and binding evidence, then require both the persisted `requiresConfirm` marker and the exact caller-confirmed action id before any write.

## DG-095

Before writing repo-backed desired state or derived files, prove the current checkout belongs to the selected project using its committed spec or normalized repository identity; a spec-less unrelated checkout is not an empty canvas. When the selected project has a known remote, require a readable normalized exact remote match and never fall back to the checkout basename. When one operation journals desired state and derives repository files from it, order or stage writes so a derived-file failure cannot advance the authoritative spec or revision. Keep failure-injection and wrong-checkout regressions for these boundaries.

## DG-098

A successful administrative database query does not validate a workload's connection URL. Compare the actual credential sources and database targets privately, return only bounded alignment outcomes, and distinguish provider configuration from running-container state and SQL authentication. Unknown or unresolved inputs never establish a match. Exercise diagnostics through the public command response: secret redaction must preserve value-free outcomes without exposing their inputs; an adapter-only test cannot prove that an operator can read the result.

## DG-099

When a provider rotates a canonical database password, bootstrap its dependent credential aliases and connection URLs using supported references rather than copied password literals. Verify the serialized bootstrap contract against the provider's documented rotation behavior; changing a configured password alone does not prove that SQL authentication changed.

## DG-100

Repair existing credential aliases through an exact database action with raw-reference and resolved-value readback. Preserve the canonical value and every URL target, encrypt reviewed inputs, and reconcile uncertain writes without repeating them. Configuration convergence does not establish SQL authentication or running-container adoption.

## DG-105

Do not use temporary release-command changes for one-off data operations. Use declarative `database.seedCommand` for first seed/bootstrap. Schema migrations belong in container startup or durable declared release configuration; database moves, resets, and other lifecycle operations must be modeled through spec/plan/apply rather than exposed as imperative tools.

## DG-111

Deployment gates must enforce actual release dependencies without making optional backup setup or health a prerequisite for ordinary deployments. Test normal and all-noop direct deployment, generated GitHub and GitLab release paths, and cross-environment repository publication with missing backup evidence. Separately reviewed backup stages must not admit workload or data writes. Carry creation-only authority through provider execution and reject an existing workload before environment or configuration mutation; an earlier observation cannot authorize a later update. Preserve explicit destructive-operation checkpoint safeguards and their exact confirmation boundary. Deployment convergence does not imply recovery readiness; report backup evidence independently.

## DG-112

Dependency edges must represent actual prerequisites. Exercise initial data-resource provisioning while accepted CI workflows still need credential or binding synchronization; removing those actions from a fixture hides bootstrap deadlocks. Keep workload gates and real namespace/database dependencies intact. Follow the real credential and repository-publication planners through to a runnable recovery workflow, including a separate canonical repository environment; a blocked rollout alone does not prove setup can finish.

## DG-113

Classify prerequisite failures separately from missing connections at their source. Plan, apply and deploy must preserve that distinction; only actual connection failures may produce credential setup instructions, including when both kinds are present.

## DG-131

Distinguish failed execution from work that was never attempted. When confirmation is missing or an earlier action fails or blocks progress, report subsequent unattempted actions as skipped or aborted and name the prerequisite or confirmation that stopped them. Reserve failed for actions actually attempted that failed; preserve confirmation-required, pending, or blocked for the action awaiting that condition. Apply this distinction consistently to receipts, structured results, summaries, and human output.

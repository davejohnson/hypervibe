# Connections, credentials, and secret boundaries

Read before changing credential setup, local authentication, identity grants, runtime wiring, secret persistence, or result redaction.

These are normative maintainer rules, complementary to `ARCHITECTURE.md`,
which remains the infrastructure model's source of truth. Load only the sections
relevant to the task. Paths in code spans are relative to the repository root.

Related contracts: [Connections And Secrets](../../ARCHITECTURE.md#connections-and-secrets), [Runtime Secrets](../../ARCHITECTURE.md#runtime-secrets), and [storage runtime identity](../storage-runtime-identity.md).

Rule IDs remain stable for references. These files are for developing Hypervibe;
the distributed user workflow lives in
[`skills/hypervibe`](../../skills/hypervibe/SKILL.md).

## DG-030

Redact command results before they reach any interface. MCP `structuredContent` and CLI `--json` must expose the same safe envelope; prompts, human output, stderr, and validation errors must follow the same secret boundary.

## DG-031

Credential handoffs must bind the approved origin and exact destinations, reject cross-origin redirects and request paths, bound response streaming through the body deadline, and render only validated value-free outcomes; an upstream error or receipt may echo the uploaded credential.

## DG-032

Cached credential expiry does not prove continuing authorization. Reconnect must recover from remote revocation and consumed one-time exchanges; clear only the rejected grant on definite terminal responses, preserve it on uncertain transport failures, and validate revocation receipts before claiming success.

## DG-033

Request externally owned credentials from the current plan's eligible input requirements, not every declared secret. Unknown live state is not proof of absence. Keep invitation approval, private one-time import, and apply approval separate. Persist reviewed intent before sending; reconcile uncertain outcomes against exact historical evidence even after expiry or source changes, never against a pre-existing lookalike. A lost consuming response requires local encrypted recovery or a separately confirmed new invitation, never a second retrieval.

## DG-034

The `hypervibe` CLI is safe to use because it shares Hypervibe state and reconciliation. Direct provider CLIs remain prohibited for infrastructure operations, and MCP agents should use available `hv_*` tools instead of spawning the CLI.

Narrow exception: an explicitly authorized operator may use Railway CLI private SSH in their own terminal for a scoped diagnostic database connection. Follow the [installed recovery guidance](../../skills/hypervibe/references/deployment-and-recovery.md#diagnose-inspect-and-adopt). This permits neither public access creation nor infrastructure, key-registration, credential or data changes. Keep CLI authentication separate from recorded Hypervibe connections and never capture credential-bearing output.

## DG-052

Preserve a live workload's provider-observed runtime identity on updates. When a provider distinguishes control-plane and workload identities, a deploy/admin connection must never seed or become the runtime principal, even for a new resource; use a deterministic least-privilege runtime identity and fail closed when it is unavailable.

## DG-053

Treat provider-generated, non-retrievable credentials as a write-only transaction: validate the exact creation identity, verify all consumers before storing, persist the complete connection set atomically, and best-effort delete the exact new credential on every intervening failure. If the provider client fails before returning the credential to orchestration, that client owns the cleanup.

## DG-054

Generate passwords, tokens, and other secret material only with a cryptographically secure random source; `Math.random()` is never an acceptable secret generator.

## DG-055

Select deployment credentials with the exact repository scope. Repository and organization wildcards may intentionally match, and a verified global connection may intentionally fall back, but a connection scoped to another repository must never be used. The shared environment-task runner passes the project's repository URL through `EnvironmentTaskOptions`; provider adapters interpret it without guessing from an image name or working directory. Without a known repository, only a global credential may match. `seed-registry-scope.api-contract.test.ts` enforces this handoff through the seed and Railway transport boundaries in normal acceptance.

## DG-060

Reusing a control-plane connection never establishes authority to copy its credential into application runtime. Carry connection provenance and the intended hosting principal/scope through shared storage wiring, verify the real workload identity when present, and distinguish confirmed first creation from unknown or missing bound resources. Keep IAM grants explicit and describe their actual scope.

## DG-061

Keep environment-owned CI credentials and database URLs in the CI provider's exact environment scope. Test both apply orders and legacy binding migration with stateful observations across multiple hosting providers; repository-wide secret names cannot prove environment isolation.

## DG-072

Cloud storage must accept the provider-native local credential path (AWS default profile/SSO chain, Google Application Default Credentials, and the Azure default credential chain) as well as explicit automation credentials. A temporary local session may manage or migrate data but must never be copied into a deployed workload as durable authentication; use workload identity or fail with targeted guidance.

## DG-083

Secrets never cross output boundaries. Accept them through `credentialsRef`, encrypted plans, or verified connections; do not print them in tool output, warnings, logs, receipts, specs, or snapshots.

## DG-085

For one-time external handoffs, persist intent before consuming, retain received values encrypted until the local destination is committed, and reconcile a completed write whose receipt failed. Exercise ambiguous responses and post-write persistence failure; never make recovery fetch another copy automatically.

## DG-087

Provider errors can echo request inputs. Scrub exact secret and environment-variable values before persistence or output; pattern-based redaction alone is not sufficient.

## DG-088

Provider delivery diagnostics must keep connection-selection context separate from message provenance. Shared-account credentials do not prove environment attribution. Bound reads before parsing, exclude email contents and recipient addresses from results, apply secret-pattern checks to diagnostic IDs, and reject evidence contradicting the requested filters. Preserve bounded value-free validation stages and field paths so malformed evidence can be diagnosed without exposing rejected values. A missing or expired log record does not prove that no send was attempted.

## DG-089

Redacting a failed provider observation must preserve a closed, locally classified failure category and observation stage through orchestration receipts and their final alert consumer. Never forward raw provider errors or infer mutation outcomes from a failed read. Worker diagnostics are failure detail, never authority for task completion, cleanup or mutation counts. Exercise the producer and emitted consumer together, including ambiguous writes and cleanup failures, through the real serialized transport where applicable.

## DG-093

Generated dotenv placeholders must be commented, idempotent, value-free, and receipt-bearing: never overwrite an existing value, never write before proving each exact private env path is untracked and repository-ignored, never make an ignored template trackable until every assignment is proven empty, reject symlinks and special files, remove group/world access without adding owner permissions, treat blanks as missing, and never copy provider credentials into runtime or environment-specific deploy files. Enforce default private-file permissions in the shared env loader so plan and deploy paths cannot diverge; explicitly selected arbitrary files remain owner-controlled. Refresh Hypervibe-owned guidance when its source contract changes, while leaving owner comments and values intact. Test the composed scaffold-then-load path so a generated empty slot cannot mask a selected base value.

## DG-094

Provider-declared local credential inputs must have one opinionated env slot per credential role, and every such slot must be classified as control-plane-only by the deploy-env boundary. Keep compatibility aliases out of generated placeholder lists.

## DG-101

Provider setup connections are never implicit application runtime secrets. Model runtime credentials under their own secret owner, and preserve existing values when transferring historical ownership. Enabling an integration is not proof that its management credential identifies the application's account; require private runtime input or matching observed hashes for that claim. Cover planning, apply, retirement, and readiness together.

## DG-115

Do not require users to install provider CLIs, OpenTofu, Terraform or Docker for
cloud deployment. Hypervibe may provision its own pinned, integrity-verified,
private OpenTofu runtime and provider plugins; these execute inside the shared
spec/plan/apply, state, approval and audit boundaries. They are not an arbitrary
`PATH` executable or a bypass of a blocked plan. Retain supported SDK/browser
authentication, bootstrap and operational clients with verified scoped connections.
The current npm installation still requires Node.js/npm; keep unproven packaged
installation claims explicit.

The DG-034 operator-managed Railway private SSH exception is not a runtime dependency or automatic fallback. Private-only database automation remains unsupported without a verified connection; it must not create a public TCP proxy to proceed. Preserve exact-identity cleanup of access recorded by earlier operations.

## Managed runtime secrets

Generated application secrets keep a stable value for their accepted generator
and generation, with project, environment and key separation. Freeze the value
in the encrypted plan and send it only to declared consumers; never scaffold it
into dotenv files. A changed root key must block and require recovery of the
original key, not silently rotate accepted values. Replacements require exact
confirmation, and acceptance is durable only after the required consumer checks.

An immutable secret cannot be replaced by confirmation alone. Its first write
requires the target and every declared conflicting key to be confirmed absent;
a partial write may be repaired only with the same accepted value. Changed
policy, conflicting values or unknown observations block. Retirement of a legacy
encryption key requires an explicit rewrap workflow, not ordinary env deletion.

Delegated secrets remain separate from ordinary env values and provider
connections. Resolve explicit private references into the reviewed encrypted
plan; preserve accepted values and report drift until new input is supplied.
Missing required input blocks apply before provider effects. Store acceptance
hashes and provenance locally, never in repository exports; a fresh installation
cannot treat a repository hash as authority to accept or replace a secret.
Declarative `principal` attribution does not grant provider roles or establish an
authenticated ACL. Repository review and actual provider authorization remain
separate boundaries.

Keep inventory read-only and distinguish value acceptance, deployment activation,
old-instance retirement, credential authentication and application operation.
The [credential lifecycle](../credential-lifecycle.md) and
[scoped secret updates](../scoped-secret-updates.md) define the existing review,
retry and rollout contracts. [Owner requests](../cloud-credential-requests.md)
and [one-time import](../cloud-secret-import.md) have separate invitation, import
and apply authority.

## Local credential sources

Project context selects the command's repository; it does not widen a connection's
durable scope. Keep control-plane inputs out of runtime dotenv projection and
preserve the [reserved runtime namespace](../reserved-runtime-env.md).

The existing Stripe Projects credential source is read-only. It may inspect the
active environment's redacted metadata and select declared keys from an existing,
owner-only regular file inside the linked repository. Ambiguous configurations,
symlinks, wrong environments and unknown output block. It must not pull, refresh,
switch environments, mutate services or rotate credentials; the operator performs
those actions explicitly and then renews the verified Hypervibe connection.

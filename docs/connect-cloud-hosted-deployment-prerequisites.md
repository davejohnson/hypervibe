# Hosted deployment dependency cut

This records an execution gap and a proposed implementation boundary. It is not
an implemented execution engine or permission to widen collection-writer access.
Connect Cloud installation and collaborative collection do not complete runtime integration.
Keep Hypervibe #469 and Hypercloud #138 in draft until the full criteria are met.

The shared hosted installation engine already implements hosted execution for Connect Cloud.
A full hosted application reconciler is a separate architecture choice, not automatically
required by that phrase. The existing Hypervibe/CI deployment path can remain the runtime
path if it receives separately authorized transient/keyless deployment access and proves
first deployment, native-reference consumption and recovery for all three providers.
The extraction below is needed only if full hosted application reconciliation is selected.
Keyless deployment authority and the native first-deployment gaps still need resolution
regardless of where application deployment executes.

## Observed execution gap

In Hypercloud, `worker.js` composes `createUnavailableReconciliationEngine()` from
`lib/reconciliationEngine.js`. The reconciliation service preserves an explicit
`engine_unavailable` result and pending plan/apply/deploy/health stages. It does not run
Hypervibe's desired-state loop. A successful collection installation must not change
that result or advertise deployment completion.

The existing reconciliation v1 request allows `safe-staging-only` automatic apply.
`lib/reconciliationProtocol.js` rejects an applied result if it is billable, destructive,
confirmation-required, protected, unverified or outside staging. There is no approved
exact-plan/action envelope for a first billable deployment. Existing workflow identity
verification and immutable source retrieval should be retained, not interpreted as
infrastructure spending or installation approval.

In Hypervibe, `src/hosted.ts` exposes hosted installation, delivery and inspection, but
not a hosted plan/apply/deploy implementation. The current local entry points depend on:

| Existing owner | Dependency to extract | Preserve |
| --- | --- | --- |
| `PlanService` | Five directly constructed repositories, `SpecStore`, and global adapter resolution | Pure diff, provider observations, isolated prerequisites, persisted plan authorization and exact source revision |
| `executePlanApply` / `CommandContext` | Concrete local repositories and several global `adapterFactory` calls | Current action allowlists, exact confirmations, recovery order, backup/readiness guards and receipts |
| `ConvergeExecutor` | Local `RunRepository` default | Saved action journal, observed-state fingerprint and restart/recovery decisions |
| `AdapterFactory` | Local connection lookup, encrypted credential decryption and registry instantiation | Exact repository/app/environment scope and provider capability checks |
| Runtime-access and other invoked services | Their current global adapter resolution and local binding persistence | Shared identity/grant stages; no parallel hosted IAM orchestration |

Wrapping those objects in an ephemeral SQLite database would not establish durable
hosted authority or recovery. Copying current customer administrator credentials into
the local connection model would violate the new-connection authentication requirement.

## Proposed shared ports, before engine implementation

First agree and test these contracts across the existing local path and the three
cloud adapters. Their names below describe responsibilities, not newly shipped APIs.

1. An immutable execution snapshot carries the authorized customer/app/environment,
   frozen repository commit, exact spec revision/hash, persisted native bindings and
   unresolved attempts. Load it from a caller-owned persistence port; planning remains
   read-only until it writes the nonsecret reviewed plan record. Existing repository
   bindings must not silently authorize adoption or replace pending recovery.
2. An asynchronous durable state port stores plans, exact action attempts, native
   bindings and receipts using compare-and-swap revisions. Persist an attempt before
   its provider write. A restart reconciles the same attempt; an uncertain result must
   not allocate a new native operation. The local database remains one adapter and the
   hosted transactional store becomes another implementation of the same contract.
3. A capability resolver creates existing provider adapters for a named action and
   purpose, using transient authentication callbacks. The resolver cannot fall back to
   local credential files, default login chains or a collection-writer connection.
   Runtime readers remain provider-observed or explicitly prepared independent principals.
4. A fresh mutation guard checks the current execution lease, source/app authorization,
   plan digest, exact confirmed action, native resource scope and credential purpose
   immediately before each native write. Checking only before a multi-call adapter
   starts leaves an authorization-change window during its reads. Read-only/recovery
   contexts reject mutations. Noop actions invoke no mutation callback.
5. A versioned hosted approval envelope adds an explicit owner-reviewed branch beside
   the existing safe automatic staging policy. Bind approval to immutable source,
   native identities, observed fingerprint, exact action IDs, plan digest, cost review
   and expiry. A generic workflow dispatch, device grant, collection approval or browser
   sign-in cannot substitute. Source or authorization changes invalidate unstarted work;
   already attempted work retains enough historical evidence for read-only recovery.

Extract the dependencies into existing services and application orchestration. Avoid a
second planner in Hypercloud or provider-specific mutations in its HTTP routes. After
local conformance passes unchanged, expose the shared engine from the packaged library
and compose it in Hypercloud using its durable store and authorization services.

## Distinct deployment trust

The installed writer permissions intentionally cannot deploy workloads, assign runtime
readers or attach billing. A separate reviewed deployment connection is required.
Administrator installation access may be transient browser access and must expire
without retaining administrator refresh tokens. Ongoing deployment uses its own scoped
federated identity; collection disconnection must not revoke unrelated approved access.

| Cloud | Required existing-adapter authentication seam | Remaining authority work |
| --- | --- | --- |
| AWS | Inject an SDK temporary-credential provider from the verified host federation/role assumption path; no default credential-chain fallback | Dedicated reviewed deployment role, exact allowed resources and PassRole targets; preserve separate ECS execution-reader and application task roles |
| Azure | Inject an ARM access-token callback plus independently verified tenant, client and principal metadata; do not decode a resource access token as identity proof | Dedicated deployment UAMI/FIC and scoped control-plane grants; separate reviewed runtime-reader assignments and Key Vault data permissions |
| GCP | Inject scoped short-lived impersonated access tokens into all hosting/runtime/IAM clients; no ADC fallback in hosted execution | Dedicated deployment service account, reviewed roles and exact runtime actAs targets; project creation, billing selection/attachment and service enablement remain separate planned actions |

These are purpose-specific extensions of the agreed host-identity strategy. They are
not evidence that current writer trust already supplies deployment authorization.
GCP Connect Cloud discovery can select an existing accessible project or propose a
separate project-preparation review. New project creation and exact recovery are
implemented; automatic billing attachment remains blocked. Neither project readiness
nor collection trust grants deployment authority.
Azure's independently documented first-create ownership gate also remains unresolved.

## Acceptance sequence

Keep the existing safe-staging protocol tests, then add versioned exact-approval tests
without relaxing that policy. Exercise both persistence implementations with the same
local and hosted plan/apply conformance suite: stale source, changed authority, lease
loss between read and write, two simultaneous applies, restart before/after a write,
lost acknowledgment, native replacement, missing privilege, and mutation-free noop.
Use real provider transports with reconstructed official responses for each adapter;
test Hypercloud against the actual packed Hypervibe artifact.

The final gate is an owner-approved disposable account walkthrough for each cloud:
new customer with no local credentials, separate administrator and contributor,
reviewed installation/deployment trust, synthetic submission, first deployment using
the immutable reference, runtime verification, and removal of collection access while
preserving stored values and independently authorized runtime/deployment access.
Offline evidence and an available engine flag cannot replace these results.

## Smallest executable slice to implement next

A deliberately limited first slice can support one public web service with an immutable
public image and native secret references. Reject unsupported fields and retained state
before planning: databases, caches, buckets, volumes, queues, domains, cron/workers,
release commands, native build/source mutations, repository/CI writes and destruction.
An omitted datastore in the new spec is not permission to ignore an existing datastore
or its backup/recovery requirement. This slice is an implementation milestone; it does
not meet the complete onboarding requirement on its own.

The existing reusable kernel is concrete:

- `diffEnvironment` already accepts desired state, observations and `LocalSnapshot`
  without repository or adapter imports. A strict hosted application entry can supply
  these inputs directly, use `fingerprintObservedState`, and route runtime prerequisites
  through `observeRuntimeAccess` / `planRuntimeAccess` before the workload diff.
- `ConvergeExecutor.execute` needs only plan loading plus `reserveApply`, `addReceipt`
  and `updateStatus` from its run repository. Extract its current execution body into
  an async shared function accepting the validated plan/run and a small async run port.
  Keep the local class as a delegate. Preserve `orderActions`, stale-plan checks,
  confirmations, non-noop dispatch and blocked/pending receipts. The hosted run adapter
  adds transactional lease/revision checks; it does not copy the loop.
- `applyRuntimeAccessAction` already accepts persistence and native drivers. Pass the
  hosted binding CAS callback there, retaining the exact pending attempt and confirmation
  semantics. It must receive a capability resolver and fresh-write guard, not the global
  local `projectRuntimeAccessInput` resolver.
- The remaining workload handler is not yet dependency-free: local service convergence
  calls `executeBootstrap`, then `DeployOrchestrator`, whose run, environment, service and
  audit repositories are concrete. Extract its single-service deploy/readback/binding and
  uncertain-create handling into a shared action handler with injected persistence and
  hosting capability. Have the existing local path delegate to that handler as well.
  Do not recreate its ownership compensation logic in Hypercloud.

There is also a genuine missing image contract. `DeploymentMutationOptions` currently
has no immutable candidate artifact. Azure and ECS intentionally prepare a holding image
and preserve the deployed image; their CI path normally releases the application later.
Cloud Run's environment-derived image path is not a shared reviewed artifact boundary.
Add a shared artifact descriptor bound to the persisted plan: OCI digest, source
provenance when built from a repository, selected service and verification receipt.
An explicitly owner-reviewed synthetic public image can be a separate provenance kind;
never invent a repository-build claim for it. All three providers must apply and verify
that exact digest through their existing native workload clients. Register unsupported
artifact admission explicitly for the other hosting providers.

This narrows the implementation to a shared execution-port extraction, one restricted
hosted planner/application entry, one shared workload action extraction, the artifact
contract, three transient adapter integrations, and Hypercloud's durable store plus
approval protocol/browser composition. It still requires separately reviewed deployment
trust. The Azure first-create proof and new GCP project/billing lifecycle cannot be removed
from the acceptance criteria by restricting the engine's input schema.

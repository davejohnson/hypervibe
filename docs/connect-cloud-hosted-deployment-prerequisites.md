# Hosted deployment dependency cut

The selected implementation uses existing Hypervibe plan/apply and managed CI with
Hypercloud brokering separately authorized temporary credentials. See the current
[deployment contract and provider matrix](connect-cloud-deployment-contract.md).
The extraction proposal below records the alternative full hosted reconciler and
its unresolved dependencies; it is not part of the selected deployment path.
Neither approach permits widening collection-writer access.
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

### Azure transient authentication checkpoint

The Azure adapter now accepts the internal, authenticated broker callback through the
shared transient-provider registry. Its ordinary credential schema still rejects that
shape. ARM and registry token targets are closed; neither requests a Key Vault writer
token. The provider-owned issuer uses the exact reviewed tenant/UAMI client ID and
Google assertion, reads current UAMI client/principal IDs and exact federation trust,
then rechecks host and source authority before a final exchange. ARM access tokens stay
opaque, as required by [Microsoft's access-token contract](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens).
An ARM identity read proves native identity and access, not arbitrary token introspection;
caller provenance additionally relies on the authenticated broker response and the
[native federation exchange](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow).

Transient ARM requests refresh through the callback, bound acquisition and body reads,
reject redirects and unreviewed scopes, and redact exact bearer material echoed in
successful metadata. They cannot mutate installation IAM or retrieve secret values.
Prepared runtime UAMIs use installer identities and ownership markers instead of local
project UUID naming. Explicit shared plan/apply binding independently verifies native
IDs and existing reader grants, including a separate collection resource group. Missing
or replaced identities and revoked grants remain unknown; binding performs no cloud writes.

This is not complete Azure onboarding. New Azure deployment installation is a
digest-bound, zero-write `create_ownership_unverified` plan; it cannot project a ready
receipt. First namespace and workload creation remain blocked. Positive session and
prepared-reader tests use synthetic retained receipts and reconstructed official HTTP
contracts, not a completed installer or live Azure evidence. Initial regressions were
observed failing for missing federation/adapter support, reader scope, token echo and
deadline handling before implementation. Managed CI's broker/registry exchange and
native installation grants require separate acceptance evidence.

### Local deployment and managed CI checkpoint

`hv_cloud_connections purpose="deployment-access"` now pairs a separate exact
repository/environment/branch grant, starts the deployment installation, and stores a
strict nonsecret native receipt separately from the encrypted device grant. The real
command/factory path carries environment scope through plan, apply, observation and
isolated prerequisites, including a first project with no local environment row.
Native sessions are bounded callback results and never enter local bindings or command
output. A revoked or changed selected grant blocks fallback to saved cloud credentials.
Revision/status CAS and final authority checks reject delayed receipts after revocation.
The pending binding also saves its reviewed hosting provider before the first POST.
Status/preview can recover that exact installation and policy after dirty spec edits or
a branch change using repository identity and currently authorized device access. They
do not adopt checkout contents or permit new operations on the changed branch; those
operations and native token callbacks still require the clean, approved source.

`action="propose-release"` saves a policy request ID before POST and recovers a lost
acknowledgment through its exact historical GET. It returns the browser review URL;
it cannot approve the policy. Managed CI receives a stable nonsecret connection binding,
not a policy digest, avoiding a workflow/approval hash dependency cycle. Release approval
is checked by the broker independently from the local device's provisioning grant.

Azure's generated GitHub mode now executes the shared CI proof exchange, reads the exact
applied registry ID, login server and creation timestamp, and performs Microsoft's
[ACR access-token exchange](https://learn.microsoft.com/en-us/rest/api/registry-dataplane/authentication/exchange-aad-access-token-for-acr-refresh-token?view=rest-registry-dataplane-2021-07-01).
The temporary registry password goes only to Docker stdin in a private temporary config
directory with unconditional cleanup. Each ARM request obtains a fresh scoped broker
session. Rollout checks the applied app creation timestamp and the exact runtime UAMI,
preserving native secret references. Missing lifetime bindings block rendering; portable
GitLab broker authentication remains explicitly unsupported, with no copied-key fallback.

Executed-script regressions covered copied-key selection, replaced registry and runtime
identity, echoed exchange errors, and exact-image updates preserving references. Adapter
regressions reproduced changed, omitted and deleted approved reference maps mutating an
existing app, then verified all three reject before provider access. These are synthetic
retained receipts with reconstructed official ARM/ACR transport contracts. Azure native
installation, release-target verification/approved policy, first deployment, and the live
walkthrough remain incomplete; passing these tests does not establish live support.

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

# Disposable Azure conditional-create experiment

This is a test-only saved-plan experiment. It does not enable Azure production
creation, install cloud trust, or constitute the required Connect Cloud live
walkthrough. No cloud writes have been made. The local preparation below produced
an actual `hv_plan` document in a separate journal using `RunRepository` and the
ordinary `ConvergeExecutor`; it did not copy a credential or open the login store.

## Private reviewed scope

The committed runner contains no developer-specific account, session or filesystem
identifiers. Set `HYPERVIBE_AZURE_PROBE_RUN_DIR` to a private absolute directory
whose name starts with `hv-azure-disposable-probe-`. Its `origin.json` contains
only the reviewed existing runtime/store paths, connection/session IDs, tenant,
subscription, source project ID and repository. The strict origin schema rejects
extra fields. This nonsecret configuration must never contain credential values.
Its digest is part of every saved action and the immutable plan digest; changing
it blocks execution, including after an asynchronous token request.

Plan-only mode writes `review.json` with the exact account, native IDs, bodies,
plan/action IDs, digest and cost review. The durable journal is `journal.db` in
that directory. Names are derived by the shared naming policy, not evidence of
native ownership. Existing or historically cleaned groups are never adopted.
These are local review artifacts and must remain outside the repository.
The plan expires under the executor's ordinary 24-hour plan-age gate; a later run
needs a fresh plan and owner review, not an edited approval digest.

The source connection must already be verified for the reviewed repository;
the private review identifies its original login session. A prior `hv_inspect`
does not prove every proposed write permission. The prototype supports an existing
schema-12 login store without copying it into the draft's schema-11 probe journal.
The runner imports only the original runtime's existing login-token service and
connection verification, with separate database and secret-store singletons. It
never imports the historical infrastructure mutation client or creates another
connection. The ordinary refresh lease remains in the original session. Transient
ARM tokens are never written to the new journal, files, stdout or test reports.

## Actions and authority

Each resource has three individually identified actions, in dependency order:

| Resource | Preparation | Same-body control | Conditional experiment | REST API |
| --- | --- | --- | --- | --- |
| Resource group | `probe:group:prepare` | `probe:group:control` | `probe:group:conditional` | `2021-04-01` |
| UAMI | `probe:identity:prepare` | `probe:identity:control` | `probe:identity:conditional` | `2024-11-30` |
| Vault | `probe:vault:prepare` | `probe:vault:control` | `probe:vault:conditional` | `2024-11-01` |

There are at most nine PUTs. Every preparation first requires a successful native
not-found observation. A pre-existing resource, unreadable target or unexpected
shape stops the plan. Because documented PUT is upsert, the owner must explicitly
authorize **synthetic fixture create-or-update at these exact disposable IDs**.
That deliberate experiment authority is separate from, and never establishes,
the production guarantee against overwriting a concurrent independently created
resource. No production create-only flag or installer guard changes.

Each control and conditional action rechecks the retained fixture before writing.
The conditional action adds `If-None-Match: *` to the same body. An unconditional
successful control plus HTTP 412 and unchanged native fixture on readback is the
positive observation. UAMI client/principal/tenant IDs and vault creation time are
retained; resource groups do not expose equivalent immutable lifetime IDs in this
contract, so their result has that evidence limit. Only allowlisted fields and
fingerprints enter receipts. Provider response bodies, arbitrary headers and error
messages are excluded, including successful responses that echo submitted material.
Exact transient credential echoes are rejected even when their text happens to fit
the GUID grammar of a native lifetime or response header.

Required existing authority, limited to the reviewed group and its exact resources:

- `Microsoft.Resources/subscriptions/resourceGroups/read`, `write`, `delete`;
  group creation needs the corresponding subscription authority.
- `Microsoft.Resources/subscriptions/resourceGroups/resources/read` for an empty
  group check before group deletion.
- `Microsoft.ManagedIdentity/userAssignedIdentities/read`, `write`, `delete`.
- `Microsoft.KeyVault/vaults/read`, `write`, `delete`.

The runner does not grant these permissions, register providers, change billing,
create federation, assign roles, read secret values or create placeholder values.
The identity has no planned assignments or FIC. The Standard vault uses RBAC mode,
empty access policies, disabled public data access, seven-day soft delete and
purge protection. Missing permissions, provider registration or policy approval
stops execution; the harness does not perform a provider-CLI workaround.

## Cost, approval and cleanup

Phase A has no Container App, managed environment, registry, image build, private
endpoint, dedicated workload profile, HSM, rotation or secret value. Microsoft
documents [managed identities at no additional cost](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/overview).
The public [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
returned Canada Central Standard Key Vault operations at **USD 0.03 per 10,000**;
1,000 such operations would be USD 0.003. This experiment instead calls ARM
metadata/control-plane APIs, so this is a conservative operation allowance, not a
claim that each proposed ARM call is a billed vault data operation. The retrieved
price evidence is retained in the private owner-review artifact directory.
See [Key Vault pricing](https://azure.microsoft.com/en-us/pricing/details/key-vault/).

Proposed approval: the exact private review plan, **USD 1 operational ceiling and a maximum
one-hour execution window**. This is a stop policy, not an Azure-enforced billing
cap. Approval is not yet given. The runner requires a separate exact confirmation
document covering every action and rechecks it after asynchronous authentication
and native reads immediately before each PUT/DELETE. It never generates approval.
No live `apply` invocation has been made.

Cleanup is a separate saved plan with `destroy` actions ordered vault, identity,
then empty group. It includes only independently completed owned fixtures; a later
pre-write observation failure does not require nonexistent fixtures to be owned.
Any unresolved attempt blocks cleanup so an unknown child cannot be deleted through
its parent. Cleanup can be prepared only from retained exact preparation evidence;
there is no deletion by guessed name or a mere attempted write. Every deletion
requires fresh lifetime/configuration checks and terminal absence before its
dependent action. Group cleanup additionally requires an unpaginated empty native
resource list. That read and the group DELETE are not an atomic child-creation
fence: an independently authorized actor could add a resource between them. The
owner must reserve this exact disposable namespace for the experiment; the check
does not establish production-safe deletion under concurrent unrelated writes.
A resource replacement, unknown write or missing evidence stops
cleanup and retains its journal. The vault remains soft-deleted for seven days;
the runner never purges it or disables purge protection. This retention is explicit
in [Azure's soft-delete contract](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview).

An attempted request is journaled before dispatch. Lost acknowledgment stops all
dependent writes and forbids replay, including on a later invocation. Read-only
recovery can finish a retained acknowledged request, but a missing acknowledgment
cannot become ownership merely because the proposed name and tags now exist.
Cleanup may therefore remain incomplete after an ambiguous initial write; the
report must retain that limitation instead of issuing another upsert or delete.

## Independent evidence and checks

Official REST contracts describe upsert and do not publish the conditional-create
guarantee under test:

- [Resource groups PUT](https://learn.microsoft.com/en-us/rest/api/resources/resource-groups/create-or-update).
- [UAMI PUT](https://learn.microsoft.com/en-us/rest/api/managedidentity/user-assigned-identities/create-or-update?view=rest-managedidentity-2024-11-30).
- [Vault PUT](https://learn.microsoft.com/en-us/rest/api/keyvault/keyvault/vaults/create-or-update?view=rest-keyvault-keyvault-2024-11-01).

The challenged assumption is that an existing generic executor or a successful
same-body PUT supplies durable conditional-create proof. New-feature tests first
failed because the probe lifecycle was absent; intermediate seven-case failures
also exposed durable JSON optional-field normalization. Review regressions then
failed on a GUID-shaped credential echo, changed private origin, partial cleanup
and cancellation during authorization; their fixes pass through the same boundary.
Fourteen offline tests now
exercise the real executor and SQLite plus reconstructed serialized ARM transport:
confirmation absence, retained attempt boundaries, ignored headers, side effect
followed by lost acknowledgment, revocation during reads, pre-existing lookalikes,
changed native principal after 412, stale digest and dependency-ordered cleanup.
Raw response echo canaries and the synthetic bearer are absent from durable output.
These tests run in ordinary `npm test`; the live runner is skipped unless explicitly
selected. The plan-only runner also passed and created the reviewable journal.

Successful live observations would establish only the tested resource/API/header
behavior in this subscription and region. HTTP 200/201 on the conditional request
means the guard was not enforced. HTTP 412 with changed state, other statuses,
missing lifetime evidence or timeout remain unknown. Even three positive results
do not verify ACA's separate API, an atomic two-contender absent-target race, complete
first deployment, runtime reference consumption or collaborative collection.
Those require their own reviewed experiment and walkthrough. Azure remains blocked
for a new customer until those production lifecycle requirements are met.

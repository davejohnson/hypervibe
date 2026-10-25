# Azure Connect Cloud evidence and remaining release gates

This is offline contract evidence, not a completed live rollout. Keep both feature
PRs in draft. No provider account was changed while implementing these checks.

## Installation preparation and native operation recovery

The current reviewed-exclusive namespace contract and native ARM deployment path
are documented in [Azure ARM evidence](connect-cloud-azure-arm.md). This supersedes
the earlier universal atomic-create blocker for new collection setup and writer
migration. It does not claim to prevent an independently authorized concurrent
same-ID upsert. [Prepared ACA first deployment](connect-cloud-azure-prepared.md) now
has separate native installation, shared handoff and emitted workflow evidence.

A transient browser administrator token discovers enabled subscriptions and their
native tenant IDs, chooses an available region, and derives the app/environment
resource group. Discovery does not prove installation authority. Planning checks
native effective ARM permissions separately, including subscription-scoped provider
registration when required. Explicit actions register only Microsoft.ManagedIdentity
and Microsoft.KeyVault, create the isolated writer UAMI and vault, and add the exact
custom role, assignment and Google federated identity credential. New connect and migration
plans review exclusive namespace management and dispatch one target per native ARM
deployment. Existing/unknown targets, missing native provenance and uncertain attempts
remain blocked. Historical blocked actions retain their original guard; confirmations
cannot silently opt an old plan into the new contract. Offline tests do not establish
completed live onboarding. Registration is
subscription-wide and remains on disconnect; Azure may register regions gradually.

The writer's native vault scope permits ARM vault metadata, secret metadata and SET.
It cannot GET secret values. Reviewed names impose a further hosted restriction;
they are not an Azure exact-name IAM guarantee. SET requires a value, so no placeholder
secret is created. For exact historical installations, the Entra exchange and metadata-only Key Vault access are
verified before publishing connection references. Disconnect removes only the exact
owned writer assignment and federation. It retains secrets, runtime grants, writer
UAMI, role definition and subscription registration. Already issued tokens can remain
usable until expiry and native authorization changes can take time to propagate.

An explicit migration targets one existing RBAC vault in the selected tenant,
subscription and resource group. Native vault tags must identify the same customer,
app and environment; a legacy destination reference alone does not establish dedicated
vault ownership. New vaults carry these nonsecret correlation markers alongside
independently retained native deployment evidence. An unmarked, shared
or differently owned legacy vault is blocked without changing its tags or old connection.
Narrow existing-secret migration would require a separate reviewed permission contract.
The reviewed plan pins the vault's native creation timestamp.
The vault action is a noop; existing secret names, versions, SKU, retention, purge
protection and unrelated grants are preserved. Migration needs no vault write
permission. It prepares new writer authorization, verifies an exact recovered writer, and leaves the old
connection active until Hypercloud's explicit verified switch. Existing access-policy
vaults need a separate preservation-safe RBAC transition; that conversion is not
implemented and cannot be represented as completed migration. New writer UAMI creation
now uses the reviewed native deployment path; its live walkthrough remains outstanding.

Official contracts:

- [Subscriptions](https://learn.microsoft.com/en-us/rest/api/resources/subscriptions/list?view=rest-resources-2022-12-01) and [locations](https://learn.microsoft.com/en-us/rest/api/resources/subscriptions/list-locations?view=rest-resources-2022-12-01). Available subscription locations are not proof that every resource provider or subscription policy permits deployment there.
- [Provider registration](https://learn.microsoft.com/en-us/rest/api/resources/providers/register?view=rest-resources-2021-04-01) and [registration behavior](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-providers-and-types#register-resource-provider).
- [Resource-group create or update](https://learn.microsoft.com/en-us/rest/api/resources/resource-groups/create-or-update) also accepts tags through an upsert; observing absence does not establish ownership of a subsequent PUT.
- [UAMI GET](https://learn.microsoft.com/en-us/rest/api/managedidentity/user-assigned-identities/get?view=rest-managedidentity-2024-11-30), [FIC PUT](https://learn.microsoft.com/en-us/rest/api/managedidentity/federated-identity-credentials/create-or-update?view=rest-managedidentity-2024-11-30), [vault PUT](https://learn.microsoft.com/en-us/rest/api/keyvault/keyvault/vaults/create-or-update?view=rest-keyvault-keyvault-2024-11-01), and [role assignment PUT](https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/create?view=rest-authorization-2022-04-01).
- [Google federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-google-cloud), [token exchange](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow), and [federation propagation/concurrency](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-considerations).
- [Vault isolation/RBAC guidance](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide), [native permissions](https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/security), [SET](https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/set-secret/set-secret?view=rest-keyvault-secrets-2025-07-01), and [version metadata](https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secret-versions/get-secret-versions?view=rest-keyvault-secrets-2025-07-01).

## Runtime foundation is a separate release prerequisite

The draft reuses the earlier shared runtime-access ports, observation, saved-plan
frontier, exact confirmations and pending recovery bindings. The prerequisite patch
is limited to those contracts, AWS/GCP runtime identity drivers and native tests,
repo-binding preservation, and small planner/application/adapter wiring changes.
It does not transplant storage adapter implementations, backup workers, or unrelated
local-authentication changes from the original working tree. Review/release this
foundation explicitly; the original working tree remains untouched.

| Registered hosting provider | Runtime identity frontier in this prerequisite | Independent native contract |
| --- | --- | --- |
| cloudrun | Before workload: dedicated service account, immutable UID/etag observation; deployed reader grants remain separately reviewed. | [Cloud Run service identity](https://docs.cloud.google.com/run/docs/configuring/services/service-identity) |
| ecs | Before workload: prepare the exact environment-owned execution-role secret reader policy. The separate application task role and S3 grants still follow the holding workload. Existing workloads preserve their observed execution role. | [ECS secret injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html) |
| azure-container-apps | Before workload: bind administrator-installed UAMIs and exact reader grants. New prepared web installation and emitted first rollout have [offline evidence](connect-cloud-azure-prepared.md); live acceptance remains outstanding. Ordinary local first-create remains disabled. | [Container Apps identities](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity), [secret references](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets) |
| railway | This new native cloud identity frontier is not implemented; existing Railway connection/secret behavior is preserved. | [Railway variables](https://docs.railway.com/integrations/api/manage-variables) |
| fly | This new native cloud identity frontier is not implemented. | [Fly secrets](https://docs.fly.io/apps/secrets) |
| digitalocean | This new native cloud identity frontier is not implemented. | [App Platform environment](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/) |
| vercel | This new native cloud identity frontier is not implemented. | [Vercel environment variables](https://vercel.com/docs/environment-variables) |

Azure reader grants are explicitly vault-wide, matching the vault-per-app/environment
model. Each identity creation or grant is a separate reviewed action. Lost acknowledgments
are recovered by native identity/assignment reads without a second write. Native UAMI
client and principal IDs establish resource lifetime; optional systemData is not required.
Runtime retirement is intentionally blocked pending a separate workload/grant teardown
contract. Collection disconnection never attempts runtime retirement. Existing UAMI-only
apps with ambiguous reader selection remain blocked rather than adopting another identity.
Removing a reference from desired state does not revoke its reader grant: older active
ACA revisions may still use it. Tests retain the native assignment and historical-reader
evidence both on ordinary re-entry and attempted identity retirement. No Azure runtime
reader DELETE is implemented. Creating a new runtime UAMI is hard-blocked below.

Legacy Azure connections retain their explicit authentication path. New deployment
connections use separately approved native Entra federation and broker-issued transient
ARM/ACR access; collection authorization never establishes deployment authority.

## Historical atomic-create gate

This section records the earlier rejected universal atomic-create assumption and its
tests. Those historical plans keep their original restrictions. The new reviewed
exclusive-namespace installer uses the provider's actual upsert semantics and native
provenance; the separate prepared first-deployment path is documented above. A native
conditional-header probe is optional research, not a prerequisite invented for Azure.

The official resource-group PUT, [UAMI PUT](https://learn.microsoft.com/en-us/rest/api/managedidentity/user-assigned-identities/create-or-update?view=rest-managedidentity-2024-11-30)
and [vault PUT](https://learn.microsoft.com/en-us/rest/api/keyvault/keyvault/vaults/create-or-update?view=rest-keyvault-keyvault-2024-11-01)
are also create-or-update operations without a published conditional-create contract.
A concurrent creator can occupy an absent name before our PUT. Re-reading our submitted
tags afterward cannot prove we did not overwrite it. The earlier hosted installer rejected
first group/vault/writer creation with `create_ownership_unverified`; historical actions
retain that guard. The new [collection contract](connect-cloud-azure-arm.md) expressly
reviews the real upsert semantics and requires native operation provenance. The runtime identity driver
rejects first UAMI creation without a write. There is no configuration bypass. Three native
transport regressions observed the previous PUTs before the fix and now prove zero writes.
Observation, exact historical recovery, existing-reader grants and disconnect remain.
Positive historical fixtures do not prove a new customer can finish installation.

A further counterexample exposed preparatory writes before the known creation blocker:
an unregistered subscription and missing group could receive POST/PUT requests even
though the writer could not be safely created. Three isolated-action regressions observed
those requests before the fix. Two real Azure driver → shared plan/apply regressions also
exposed incompatible action-verification semantics. The shared contract now preserves
unverified actions only inside an explicit blocked review, and blocks all mutation dispatch.
Those historical blocked-plan cases and exact historical disconnect passed through that shared
boundary. New collection/migration now have separate positive shared-engine tests. The native fixtures
are reconstructed, not live evidence. Historical registration recovery remains read-only.

The official [ACA PUT contract](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/create-or-update?view=rest-resource-manager-containerapps-2026-01-01)
is create-or-update. It publishes no If-None-Match or other conditional-create guarantee.
A preceding list/GET absence, random name, resource-group tag, or successful HTTP201 cannot
prove that the subsequent PUT did not update a concurrently created app. A precreated UAMI
solves reader-identity ordering, not this separate ownership guarantee. The create-only
capability remains false, and explicit create-only requests fail before any cloud call.

[Managed Applications PUT](https://learn.microsoft.com/en-us/rest/api/managedapplications/applications/create-or-update?view=rest-managedapplications-2019-07-01)
and the [managed-resource-group overview](https://learn.microsoft.com/en-us/azure/azure-resource-manager/managed-applications/overview)
do not establish an atomic existing-group rejection contract. Deny assignments are configurable,
managed-app deletion also deletes its managed group, and another Azure product's namespace
semantics cannot be borrowed as evidence. No alternate provisioning mechanism was invented.

[Azure Policy deployIfNotExists](https://learn.microsoft.com/en-us/azure/governance/policy/concepts/effect-deploy-if-not-exists)
evaluates related resources after a delay and then starts a template deployment.
Its `existenceCondition` is a compliance predicate, not a documented atomic
create precondition. [ARM deployment modes](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deployment-modes)
explicitly update existing resources when template properties differ. We therefore
cannot infer race-safe first creation from that policy. The [Managed Applications
quickstart](https://learn.microsoft.com/en-us/azure/azure-resource-manager/managed-applications/deploy-service-catalog-quickstart)
says deployment creates the managed group but does not specify rejection of a
concurrently existing group. This is a missing guarantee, not proof that every
possible native namespace mechanism is unsupported.

A test-only candidate probe is in
`test/provider-contracts/helpers/azure-create-only-probe.ts`. Its normal-CI synthetic
checks execute one If-None-Match:* PUT on an already owned, bound, no-secret disposable
sentinel with a reviewed immutable image. The injected lifecycle callback rechecks exact
approval immediately before dispatch. The probe accepts only a native 412 plus unchanged
principal, creation timestamp, configuration and revision readback. HTTP200 means the guard
is unsupported; uncertainty never authorizes replay. This test has not run against Azure
and does not enable the product capability.

Before any live probe, prepare a separate disposable-scope spec/plan with actual account,
resource group, app, reader, image digest, costs and cleanup actions. Obtain owner approval
for the exact lifecycle actions, then use the current approved action to supply transient
authentication and `beforeMutation`. Do not create its prerequisite resources through a
provider CLI or an unreviewed helper. Preserve the returned native evidence without tokens
or secret data. A verified header probe is only one prerequisite: the complete first-deploy,
reference consumption, recovery and disconnection walkthrough still must pass.

## Regression record

The observed failures challenged these assumptions:

- Cloud sign-in implies complete onboarding: the initial discovery and namespace tests failed
  with missing discovery/action results. Discovery and explicit registration now pass.
- A different writer can be installed by recreating the vault: migration initially planned a
  create at a new vault name; it now pins the existing vault and performs no container writes.
- A legacy target proves exclusive vault ownership: three native-transport tests initially
  accepted unmarked, other-customer and production vaults for staging writer migration.
  They now reject before any write; the positive migration fixture has exact native ownership.
- The API returns ordered RBAC sets, fixed ARM casing, and UAMI systemData: independently
  reconstructed reordered/case-normalized/omitted responses failed before boundary normalization.
- All readers are system-assigned: real serialized UAMI reference readback failed against the
  hard-coded system identity; readback now verifies the selected reviewed reader.
- Existing environment keys prove native grants, and first workload preparation can proceed
  without exact creation confirmation: shared planning/application tests reproduced both issues.
  The saved runtime-access stage and exact first-create guard now enforce those prerequisites.

Native historical Azure UAMI and reader-assignment fixtures also pass through the shared
`observeRuntimeAccess`, `planRuntimeAccess` and `applyRuntimeAccessAction` boundary,
including retained-coordinate validation, missing confirmation and re-entry. This proves
the adapter's evidence is accepted by the shared frontier; it does not prove live Azure access.

All these suites are included by ordinary `npm test`. Fixtures are reconstructed official
response shapes or explicitly synthetic lifecycle models; none are live recordings. Permission
propagation, customer organization policy, actual cloud authority and runtime consumption remain
live acceptance requirements. Passing tests do not establish the cause of a customer incident.

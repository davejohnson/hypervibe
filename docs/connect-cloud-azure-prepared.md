# Azure prepared hosting: offline contract evidence

The new administrator installation, local namespace/runtime binding, release-policy
target proof and emitted first GitHub release are implemented in the existing shared
installation and spec/plan/apply lifecycle. This is **offline contract evidence**.
No live account installation, Container Apps image pull, Key Vault reference consumption
or disconnect walkthrough has run for this path. Both feature PRs remain drafts.

## Native authority and creation

The administrator reviews exclusive management of one app/environment resource group.
Planning independently verifies the selected tenant/subscription and native effective
permissions, including managed-environment join and subscription deployment observation.
Every target uses its own persisted attempt and exact ARM deployment. A known existing
target or unknown read blocks fresh installation; template success alone is insufficient.
Native deployment correlation, child operation, target resource, explicit Created result,
terminal state and independently observed native lifetime must all agree.

ARM remains an upsert API. An independently authorized administrator can create the same
ID between absence observation and our request, and Azure can overwrite it before our
later operation inspection detects Update. Exclusive namespace management is explicit
administrator authority, not an atomic create guarantee. Missing/changed operation proof
stays unknown/conflicting; it does not authorize replay, adoption or deletion. See
[the shared Azure ARM evidence](connect-cloud-azure-arm.md) for the adversarial case.

Resource-group names/tags have no immutable lifetime. The prepared hosting project proof
therefore pins the managed environment's ARM ID and `systemData.createdAt`, with the
resource group as its observed parent. Registry and app proofs pin their ARM IDs and
creation timestamps. UAMIs pin native client and principal IDs. The original holding
revision and normalized configuration digest remain in the receipt after rollout.

The installer creates a Basic ACR registry, a Consumption managed environment with no
paid logging workspace, and public web holding apps at 0–1 replicas. It installs separate
provision, release, holding and per-workload runtime UAMIs. Provision/release grants are
scoped to the exact apps, registry, managed environment and runtime UAMIs; they cannot
write arbitrary IAM or retrieve Key Vault values. Runtime ACR Pull and vault-wide Key
Vault Secrets User assignments are distinct installation actions. Reviewed vaults must
already be dedicated to the exact customer/app/environment and retain their native
creation timestamp. Existing values and unrelated grants are never rewritten.

The operator must publish the reviewed holding artifact as an anonymous public Artifact
Registry digest and configure that exact image. There is no default image. Bounded
anonymous DockerImage metadata reads verify its exact resource name and URI at review
and before app creation. That proves metadata accessibility, not a successful ACA pull
or the image's source provenance; publication and the disposable walkthrough remain gates.

## First release and existing workloads

The first local project stage verifies and binds the installed namespace without cloud
writes. The isolated prepared-hosting metadata action then verifies the exact apps and
records the committed nonsecret runtime configuration digest. The shared runtime-access
frontier binds the installed runtime reader and freshly observes its reader assignments;
it never repairs IAM using deployment authority. An unreviewed environment override,
changed immutable reference, replaced native resource or revoked reader blocks progress.

Local deploy records an exact holding-revision baseline and defers application rollout.
Generated GitHub CI obtains separate short-lived release authorization, builds the
candidate, verifies exact native lifetimes/identities/grants, then issues one PATCH with
the candidate digest, runtime UAMI, versioned Key Vault references and reviewed runtime
configuration. No separate secret-configuration write precedes that update. A lost
acknowledgment stops the execution; it is never blindly resubmitted.

Adding a UAMI is app-scoped and does not itself create a revision. The confidentiality
boundary therefore does **not** rely on PATCH making identity and revision changes
transactional. Both holding and final reader use `identitySettings.lifecycle: None`:
the platform can use the UAMI for ACR/Key Vault, while container code cannot obtain its
tokens. The old holding revision has no secretRef environment entries. The candidate
revision alone receives the reviewed references. This narrow web/reference path does
not offer application-code managed-identity SDK access for unrelated services.

CI verifies ready revision, original resource lifetime, runtime UID, exact image,
configuration and source markers before success. Shared reconciliation additionally
requires exact managed workflow/run/artifact provenance before clearing pending first
release metadata. A later lookalike holding revision cannot rearm the first-release path.
Normal native observation and historical installation recovery recognize a verified
final rollout while preserving the original creation evidence.

Release-policy enrollment uses actual committed repo bindings and independently reads
the app/registry lifetimes, UAMIs, custom roles, owned assignments and current holding or
application configuration. It uses no infrastructure writes. Runtime grants, secrets,
apps and registry survive hosted-access disconnection; only exact completed hosted
assignments and federation are removed. Issued credentials remain subject to native
expiry and IAM propagation. Ordinary first-create requests still have no atomic-create
capability; the reviewed installer-prepared path is a separate mechanism.

## Independent contracts and regression record

- [Container Apps create/update](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/create-or-update?view=rest-resource-manager-containerapps-2026-01-01) and [managed environments](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/managed-environments/create-or-update?view=rest-resource-manager-containerapps-2026-01-01).
- [Managed identity lifecycle None and app-scoped identity changes](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity), [secret references](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets), and [native container permissions](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers).
- [Scope-aware role-definition GET](https://learn.microsoft.com/en-us/rest/api/authorization/role-definitions/get?view=rest-authorization-2022-04-01), [ACR GET](https://learn.microsoft.com/en-us/rest/api/container-registry/registries/get?view=rest-container-registry-2025-11-01), and [public DockerImage metadata](https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.dockerImages/get).

Normal `npm test` includes the real shared installation engine, native serialized
transport fixtures, adapter/runtime frontier and executed generated workflow scripts.
Fixtures reconstruct published response shapes; none are live recordings. Observed
RED→GREEN counterexamples include missing managed-environment join permission/grants,
omitted reference accepted during initial binding, revoked ACR reader accepted after
binding, later holding revision rearming, blanket first-project blocking, generated CI
rejecting the installed holding principal, ordinary status dropping prepared ownership,
historical recovery rejecting a valid final rollout, and JSON key order changing probe
verification. Uncertain updates, replaced resources, changed holding configuration,
widened native roles, revoked authority, missing anonymous image access and token-echo
errors have negative coverage. Passing offline tests does not establish live support.

The supported prepared topology is public web services with immutable native references
and committed nonsecret environment settings. Worker/cron, release commands, storage,
databases, custom domains, private networking and portable GitLab broker access remain
explicitly outside this initial prepared contract. Dependency security repairs and the
three approved disposable-account walkthroughs remain release prerequisites.

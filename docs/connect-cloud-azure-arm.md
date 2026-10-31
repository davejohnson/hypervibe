# Azure reviewed namespace and native deployment evidence

This is an offline implementation contract. No Azure account was mutated and the
new-customer live walkthrough remains required. The optional create-only header
probe is unchanged and still requires its separate owner approval.

The challenged assumption was that every cloud must provide an atomic create-only
API before onboarding can be implemented. Azure instead documents upsert semantics.
The accepted contract explicitly reviews exclusive management of an app/environment
namespace, serializes Hypervibe's own writes and records Azure's actual operation
evidence. It does **not** promise atomic protection against an independently
authorized actor creating the same resource ID concurrently.

## Authorization and scope

The administrator reviews exact subscription, tenant, region, resource group,
writer UAMI, vault, custom role, federation and assignment. Fresh unrelated existing
resources block the whole plan. Unknown reads do not become absence. New resource
creation uses unique, immutable native deployment names derived from the already
persisted action attempt. Every template contains exactly one reviewed resource;
complete mode, linked templates, deployment scripts and secret values are absent.
Effective permissions are observed separately from browser sign-in, including
subscription deployment/role-definition authority and resource-group target writes.
The shared journal records each attempt before dispatch and rechecks source, host,
actor and current CAS lease after native reads and immediately before dispatch.

The vault is Standard/RBAC with 90-day soft deletion and purge protection. Its
operation pricing is shown in the review. Writer authority is vault-wide metadata
and SET only; target names are an additional hosted restriction. There is no empty
SET. Secrets, runtime grants and infrastructure survive collection disconnection.
Only the exact hosted writer assignment and federated trust are removed; issued
tokens and permission propagation can outlast removal.

Migration pins an existing dedicated RBAC vault's native creation timestamp and
customer/app/environment markers. It creates only new writer trust resources,
preserving all existing values, versions, names, retention and unrelated grants.
The vault never appears in a deployment template. The old writer remains active
until the separately authorized Hypercloud switch. Existing access-policy vaults
and unverified shared-vault ownership remain blocked.

## Native acknowledgment and recovery

The native ARM PUT must acknowledge a new deployment with HTTP201 and an exact
deployment ID, correlationId, native templateHash and systemData.createdAt. The
timestamp must not precede the attempt. These are allowlisted nonsecret receipts;
raw outputs, parameters, errors, operation request/response bodies and echoed
credentials are never persisted. Exact credential echoes are rejected even when
they happen to satisfy a GUID schema.

Recovery reads that exact deployment. Its immutable retained correlation, native
template hash and creation metadata must still match. Completion requires a
succeeded deployment with exactly the reviewed output resource, a complete
unpaginated operation list with exactly one resource operation, and the native
resource provider's successful Create/Created (or 201) receipt. The completed
operation ID and serviceRequestId are pinned for later re-observation. Native
resource configuration and UAMI client/principal IDs or vault creation time are
read separately before dependent writes. Create alone is insufficient because
Azure's provisioningOperation enum does not distinguish an upsert update.

HTTP200/OK is conservatively treated as an unexpected update, and conflicting,
missing or delayed receipts remain unresolved. Native optional fields may be
absent in legitimate responses; such omissions block this admission contract
rather than being invented from submitted values. This is a live compatibility
gate, not proof that all Azure responses provide these fields.

A lost PUT response without a retained native correlation stays unknown, even if
a same-named deployment later exists. Neither a retry nor a process restart may
resubmit it. Native deletion of deployment history can consequently prevent later
recovery. This implementation does not recover ownership from names, copied tags,
matching templates, client timestamps or resource absence alone.

## Remaining race and lifetime limits

An independent actor can create the exact reviewed target after our not-found read
and before ARM dispatches its upsert. Azure can already have overwritten that
resource by the time an unexpected update receipt is detected. The adversarial
test explicitly models this outcome: the installation conflicts, issues no grant
or compensation, and never claims that the overwrite was prevented. Azure
Incremental mode leaves omitted resources intact but can reset omitted properties
on a resource included in its template. Namespace exclusivity is an administrator
authorization premise, not a native lock enforced against all Azure administrators.

Resource groups do not provide an immutable resource UID. The recorded deployment
correlation identifies the native creation operation, not an independently proven
lifetime of a later same-ID replacement group. Namespace checks and operation
history must not be described as a universal resource-group lifetime guarantee.
The collection installer never deletes the group. Runtime/holding workload
preparation is a separate contract and must carry its own native lifetimes.

## Independent evidence and regressions

- [Subscription deployment PUT](https://learn.microsoft.com/en-us/rest/api/resources/deployments/create-or-update-at-subscription-scope?view=rest-resources-2025-04-01) and [resource-group deployment PUT](https://learn.microsoft.com/en-us/rest/api/resources/deployments/create-or-update?view=rest-resources-2025-04-01) define the acknowledgment envelope and 200/201 distinction.
- [Group operations](https://learn.microsoft.com/en-us/rest/api/resources/deployment-operations/list?view=rest-resources-2025-04-01) and [subscription operations](https://learn.microsoft.com/en-us/rest/api/resources/deployment-operations/list-at-subscription-scope?view=rest-resources-2025-04-01) define native target, operation and status evidence. Optional raw response fields do not independently establish target semantics.
- [Deployment naming](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deploy-rest) documents replacement of history and concurrent deployments using the same name. [Incremental mode](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deployment-modes) documents updates and property resets.
- [Extension scope](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/scope-extension-resources) supplies the vault-scoped assignment template contract. [UAMI PUT](https://learn.microsoft.com/en-us/rest/api/managedidentity/user-assigned-identities/create-or-update?view=rest-managedidentity-2024-11-30) distinguishes create and update receipts; it does not publish an atomic-create precondition.

`azure-arm-installation.test.ts` initially failed four tests against the blanket
blocker, then passed the native namespace implementation. A separate regression
observed changed child-operation history being accepted after completion; pinning
the exact serviceRequestId made it fail closed. The suite includes the real shared
durable engine, fresh collection, existing-vault migration, restart after a lost
acknowledgment, authorization revocation, malformed/changed receipts, a GUID-shaped
credential echo, no-write reconciliation and exact trust removal. Existing
historical installation/disconnection cases still pass. All are ordinary Vitest
tests with reconstructed official response shapes and synthetic race models;
none constitutes live interoperability evidence or a proven customer incident.

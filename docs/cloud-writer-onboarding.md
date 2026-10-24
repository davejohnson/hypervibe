# Cloud writer onboarding

This is one-time installation of narrowly scoped writer trust, separate from
empty destination creation, value collection, version pinning and runtime
deployment. It never transfers a local deploy key to hosted Hypervibe. An
administrator's access token is transient; a connection stores only the selected
native writer identity and scoped approval. Delivery continues through the
[destination contract](secret-destination-delivery.md).

Reviewed 2026-10-24. The named matrix distinguishes current code from provider
capability. Offline tests are not live IAM acceptance.

## Coding-agent setup flow

The agent uses the existing verified GCP connection for the selected project.
It does not ask the owner to invent secret resource names or copy cloud keys.
For each environment:

1. Call `hv_cloud_connections` with `purpose: "secret-destinations"`,
   `action: "discover"`, and the environment key. Discovery reads the connected
   Google project and proposes deterministic, separate destination names. It
   preserves existing declarations and returns no credential values.
2. Review the returned `destinationTargets`, write them through `hv_spec`, and
   commit the spec on the intended source branch.
3. Call the same connection command with `action: "start"`. The owner approves
   the displayed browser link for this exact repository, environment and branch;
   `action: "status"` completes the separate setup grant. Existing reporting,
   monitoring and collection grants do not authorize setup.
4. Use `hv_plan({env, scope: "secret-destinations"})` and its confirmed `hv_apply`
   to create only the reviewed empty containers. This prerequisite works before
   an application environment exists and cannot deploy a workload.
5. Call `action: "preview"`, then `action: "prepare"` with the returned
   `previewId` and `adminAuth: "default"` to review exact writer permissions.
   Confirm that preparation using the same preview and `confirm: true`.
   Local administrator authentication stays transient and is not uploaded.
6. Call `action: "connect"` with the same preview and `confirm: true`. The host
   checks the delegated writer and registers each destination. The agent can
   then use `hv_cloud_requests` to authorize collection for that environment.

Before each writer mutation, setup rechecks the hosted approval and source and
freshly observes exact owned container identity. Existing connected destinations
are preserved. Registration uses one destination per bounded request; an unknown
acknowledgment returns a partial result and status inspection, not an automatic
replay or an invitation to collect values. Revoking setup access removes the
device grant; it does not silently remove cloud resources or IAM grants.

This flow requires a released Hypervibe package, a Hypercloud deployment pinned
to that release, the setup database migration, and a verified keyless Google
identity on the host. A local candidate test does not make these commands
available on the deployed service. AWS and Azure automated setup remain
unsupported, as shown below.

| Secret provider | Implemented writer preparation | Keyless ongoing identity | Remaining setup |
| --- | --- | --- | --- |
| GCP Secret Manager | Exact reviewed project/environment IAM preparation, described below; metadata permission-readiness check | Hosted Google service account impersonates the environment writer account | The host must establish its own Google identity; customer admin authorizes exact preparation |
| AWS Secrets Manager | Automatic writer installation unsupported; existing manually prepared role/external-ID connection remains separate | Google-issued OIDC can use native STS web-identity federation; this new onboarding mode is not implemented | Reviewed CloudFormation role/trust installation and new federation bridge required |
| Azure Key Vault | Automatic writer installation unsupported; existing application/client-secret connection remains separate and retains its encrypted client secret | Google-issued OIDC can federate into a user-assigned managed identity; this new onboarding mode is not implemented | Reviewed managed identity/federation/RBAC installation and new assertion exchange required |

## GCP preparation and exact scope

`runGcpSecretWriterPrepare` previews a value-free plan. Confirmation requires its
exact digest, explicit `adminAuth: "default"`, the same repository/environment,
source revision/digest, Google project ID and number, exact hosted service
account, and declared secret IDs. The caller rechecks its hosted setup grant and
current source before each provider mutation. The helper independently verifies
project ID/number through Cloud Resource Manager and verifies existing secret
resource names. Missing containers block; their creation belongs to the separate
`secret-destinations` plan/apply stage.

The reviewed operation enables IAM and IAM Credentials APIs, creates one stable
service account per repository/environment, and installs two owned custom roles:

- Project metadata: only `resourcemanager.projects.get`, bound on the project.
- Secret delivery: only `secretmanager.secrets.get`,
  `secretmanager.versions.list`, and `secretmanager.versions.add`, bound on each
  declared secret separately.
- The exact hosted principal receives `roles/iam.serviceAccountTokenCreator`
  only on that writer service account.

It creates no service-account keys, reads no secret values, grants no version
access/read permission, and creates no secret containers. Other IAM policy
members, conditions and audit settings are preserved with the observed etag.
The generated identity names are deterministic; names alone never prove ownership.
An existing account/custom role requires a durable attempted-creation record and
its exact random-attempt description marker. The account's immutable numeric ID
is then retained. Changed/replaced identities, changed custom role permissions,
missing etags, unknown reads and foreign existing resources block.

Preparation persists non-secret recovery intent before dispatch. Each mutation
is dispatched once and read back. A lost response is reconciled using its exact
native identity, ownership marker and requested policy state. Unresolved writes
are not automatically resent. A definite native rejection permits a separately
confirmed retry after the cause is resolved. A missing bound account/role is not recreated.
Pending added-secret grants remain in the retained scope after interruption;
removing previous scope needs a separately reviewed cleanup. Current pinned
slots may be supplied as `retainedSecretIds`: only previously recorded grants
are preserved, and this never installs new rights for retained-only slots.
Uncertain retained grants still require read-only reconciliation. Cleanup/teardown
of this setup is not implemented here. Successful readback proves the configured
policy state at that time, not absence of other inherited grants or atomicity
against subsequent administrator changes.

The admin needs project metadata and IAM-policy read/write, API get/enable,
service-account create/get/policy read/write, custom-role create/get, and exact
secret metadata/policy read/write permissions. These administrator permissions
are not granted to the writer. Organization policies, IAM propagation, custom
role quotas, VPC Service Controls and API enablement can still block setup.
Preparation has a 30-second deadline; delayed convergence remains recoverable
state instead of a claimed success.

The GCP delivery driver's `verifyWriteAccess` checks native project identity,
secret metadata and the caller's reported `secrets.get`, `versions.list`, and
`versions.add` permissions without writing. Google's `testIamPermissions`
contract explicitly warns it can fail open and is intended for permission-aware
interfaces. This is onboarding readiness evidence, not authorization or proof
that a live write will succeed. Each actual delivery still checks hosted scope
and source immediately before dispatch, and native IAM enforces the write.

Official contracts:
[project identity](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/get),
[service-account creation](https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/create),
[custom-role creation](https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.roles/create),
[custom-role identity and permissions](https://docs.cloud.google.com/iam/docs/reference/rest/v1/roles),
[project IAM policy](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/setIamPolicy),
[secret IAM reads](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/getIamPolicy),
[secret IAM updates](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/setIamPolicy),
[permission readiness semantics](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/testIamPermissions),
[service-account impersonation](https://docs.cloud.google.com/docs/authentication/use-service-account-impersonation),
and [API enablement](https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/enable).

## Host identity and browser bootstrap

A Google service identity attached to Cloud Run can obtain Google-signed ID
tokens with a specified audience without a customer cloud key. A host on another
platform needs an established platform credential/federation mechanism; a
configured service-account email alone does not supply credentials. Railway
workload-token availability was not established by the primary sources reviewed.
Hypercloud's desired production spec selects Cloud Run and staging selects
Railway; this is not verification of actual hosting.

For GCP, registered web OAuth can obtain an online-only, short-lived user token
for the reviewed setup. Consent does not grant IAM powers that the user lacks.
Registered redirects, provider-specific single-use state, source/account binding,
and the admin's existing permissions are prerequisites. Automatic hosted Google
OAuth bootstrap is not part of this increment; explicit local admin ADC remains
the implemented preparation route. It never uploads the local deploy identity.
[Google web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Google ID tokens](https://docs.cloud.google.com/docs/authentication/get-id-token).

AWS provides a console quick-create CloudFormation link for reviewed role/trust
installation; ordinary OAuth consent is not IAM administration. Google is a
built-in AWS identity provider. A future bridge can use
`AssumeRoleWithWebIdentity` without AWS host access keys, pinning the Google
numeric service-account subject and exact audience. AWS maps Google `azp` to
`accounts.google.com:aud` when present and the token `aud` to
`accounts.google.com:oaud`; this differs from the existing AssumeRole/external-ID
bridge. Temporary role sessions can retain an exact-secret session policy.
[CloudFormation onboarding](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stacks-quick-create-links.html),
[STS exchange](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html),
[claim mapping](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html).

Azure explicitly supports a user-assigned managed identity trusting
`https://accounts.google.com`, the Google account's numeric subject and the
configured audience (normally `api://AzureADTokenExchange`). A future connection
can exchange that assertion instead of retaining a customer client secret.
The customer must create the identity/federated credential and grant separate
vault control-plane metadata and narrow secret data-plane access. OAuth admin
consent does not itself grant Azure RBAC. Identity creation and role assignment
require distinct permissions; a reviewed ARM deployment can keep setup in the
customer's portal. Do not substitute the broader Secrets Officer role for an
exact metadata/set-only custom role without disclosing its extra powers.
[Google-to-Azure federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-user-assigned-managed-identity),
[assertion exchange](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow),
[Key Vault RBAC](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide).

## Regression evidence

Normal `npm test` discovers `gcp-secret-writer-prepare.test.ts` (actual serialized
REST and SQLite recovery) and `gcp-writer-access.test.ts` (actual serialized
permission checks). New functionality failed before implementation. Additional
concrete counterexamples showed a bound missing account being recreated, an
interrupted expanded grant being forgotten, and a creation acknowledgment's
immutable identity disagreeing with readback; these failed before their fixes.
Coverage includes two actual environment preparations, noop mutation freedom,
foreign ownership, immutable identity replacement, modified custom roles,
source/review mismatch, current-authority rejection, lost creation/IAM responses,
no automatic unresolved-create replay, preserved conditional policies, and no
admin token in persisted SQLite state or returned errors.

All provider responses are reconstructed synthetic fixtures; no live cloud
operations, actual customer IAM acceptance, OAuth consent or successful secret
write was performed for this evidence.

## Release readiness (2026-10-24)

This feature is not release-ready while the dependency audit reports high
findings. Compatible repairs updated Vitest/coverage to 4.1.12, Vite to 8.3.5,
body-parser to 2.4.0 and fast-uri to 3.1.9. A fresh
`npm ci --ignore-scripts --no-audit`, actual in-memory SQLite connection and
`npx tsc --noEmit` passed. The normal full suite with `--maxWorkers=2` passed
6,148 tests in 399 files, with the existing three skipped files, five skipped
tests and one todo; no exclusions or new skips were introduced. Final setup
command regressions passed 29/29. The writer/access/provider-matrix suites passed
27/27 on that fresh installation. Hypercloud's normal package import passed
96 affected HTTP/PostgreSQL/Chromium cases and 69 focused unit cases against the
packed development candidate, with no source override. These counts overlap
other focused evidence and must not be added together.

The audit fell from nine affected packages (five high,
four moderate) to three high packages: `zod`, `@azure/msal-node`, and its parent
`@azure/identity`. No audit suppression, dependency override or downgrade was
applied.

- **Zod requires a real v4 migration.** The collection-size fix is in 4.6.6's
  v4 implementation. Testing the published 4.6.6 and 4.6.7 packages with an array bounded to
  two elements and four invalid inputs showed `zod/v3` still parsed all four
  elements and produced five issues; `zod/v4` parsed no elements and produced
  one issue. Merely changing the package version while retaining `/v3` would
  hide the audit finding without fixing that behavior. A temporary compiler
  feasibility check against v4 produced 301 errors across 65 files, including
  44 one-argument record constructors and cascading type errors. The provider
  schema introspection, CLI/MCP schema handling, default/record semantics and
  validation-error contracts need deliberate migration and regression checks.
  [Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
  [maintainer fix](https://github.com/colinhacks/zod/commit/a0ebf97),
  [migration guide](https://zod.dev/v4/changelog).
- **Azure lacks a supported dependency-only repair identified in this review.**
  MSAL's authorization-code issue affects versions from 5.0.0-beta.0 through
  versions below 7.1.0. Identity 4.13.2 uses MSAL 5; current stable Identity
  4.14.0 still requires MSAL 6. Hypervibe uses `DefaultAzureCredential`, not
  `AuthorizationCodeCredential` or caller-supplied authorization-code options;
  this limits the demonstrated exposure but does not clear the release audit.
  The audit-suggested Identity 4.13.0 downgrade would remove 4.13.2's safer
  structured execution for developer credentials used by the default chain.
  Keep the current SDK pending a supported Identity release or a separately
  reviewed replacement of its authentication path; do not force MSAL 7 into an
  unsupported dependency range.
  [Maintainer advisory](https://github.com/AzureAD/microsoft-authentication-library-for-js/security/advisories/GHSA-xcx6-jx8p-x3h5),
  [Identity release history](https://github.com/Azure/azure-sdk-for-js/blob/main/sdk/identity/identity/CHANGELOG.md).

Package installation, compilation and synthetic provider tests do not establish
live cloud compatibility, deployed host identity or successful customer setup.

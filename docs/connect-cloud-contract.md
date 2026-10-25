# Hosted Connect Cloud contract

This extends draft #469 and Hypercloud #138. It is not evidence of a deployed
feature or live provider compatibility. The named native providers are AWS,
Azure and GCP; the other secret-manager integrations retain their existing
explicit connection contracts and are not hosted installation providers.

## Customer outcome and authority

An authorized app member starts setup for one customer, application,
environment, source branch/revision/digest and set of declared secret keys.
The browser selects a cloud and native scope. The developer can invite a
different cloud administrator through an expiring, email-verified installer
invitation. Installer proofs never authorize secret submission or collection
management. Cloud sign-in identifies a principal; native permission checks and
provider-enforced installation establish its actual cloud authority separately.

The administrator reviews the exact native account/project/subscription,
resources, host identity, writer permissions, retention behavior and costs.
Approval binds the immutable installation plan and its exact action IDs.
Installation does not deploy application code or grant runtime reader access.
The agent receives only installed destinations and a reviewed spec patch.
Collection stays unavailable until that exact patch and unchanged key ownership
are verified in the approved repository branch. Accepting that transition binds
the newly observed source revision/digest; it never silently changes the source.

Setup-device access, installer approval, deployment authority, collection
management, recipient submission and runtime reading are separate capabilities.
New connection records contain no customer keys, client secrets, private keys,
administrator refresh tokens or submitted application values. Existing
connections remain explicitly legacy until a reviewed keyless replacement has
been verified; replacing their authorization is a separate migration action.

[`mode=connect-existing`](connect-cloud-existing-destinations.md) separately
authorizes the first hosted writer for committed existing destinations. It needs
no old writer credentials and never bypasses prior-writer recovery or Azure's
dedicated-vault checks. `mode=migrate` retains the explicit previous-writer
authorization and switch contract.

`mode=migrate` binds the exact existing destinations. It never creates a
replacement secret, reads its value, moves a version or edits the committed
reference. Google pins the existing container's `createTime` before review;
AWS pins its full lifetime ARN and verifies metadata after console installation.
Azure requires independently verified dedicated vault ownership before granting
vault-wide SET. The host switches writers only after installation verification
and a separate acceptance of the unchanged source. It preserves uncertain
historical submissions and clears only the superseded legacy writer credential.

## Common host identity

Use a dedicated Hypervibe-owned Cloud Run service account per hosted environment.
Verify its project, email and immutable numeric identity through its native
metadata and Google-signed token. A configured email or previously cached
verification is insufficient. Every new token path must use that verified
identity; user refresh credentials, key files and ambient AWS credentials are
not fallback mechanisms. Railway staging currently has no verified equivalent
identity and must remain unavailable until the operator provisions an approved
hosting identity. That is an explicit release prerequisite.

| Cloud | Administrator installation | Ongoing writer identity | Prepared resources |
| --- | --- | --- | --- |
| AWS | Reviewed CloudFormation console installation | Google ID token exchanged through STS web identity for a dedicated IAM role | Empty Secrets Manager containers and owned role/policies |
| Azure | Entra browser authorization and reviewed exclusive app/environment namespace; [ARM deployment and native resource evidence](connect-cloud-azure-arm.md) govern installation. Offline acceptance only; live walkthrough outstanding. | Google ID token exchanged for the exact verified writer UAMI; newly prepared identities require retained native deployment and lifetime proof | Dedicated RBAC vault, writer UAMI and reviewed names; no empty SET. ARM remains upsert, with no atomic exclusion of independently authorized concurrent writes. Historical blocked plans retain their restrictions. |
| GCP | Google online browser authorization and reviewed resource/IAM installation | Short-lived impersonation of the dedicated customer writer service account | Empty Secret Manager containers, writer account and owned scoped permissions |

AWS Google claim mapping pins `sub`, maps Google's `azp` to
`accounts.google.com:aud`, and pins the connection-specific actual audience via
`accounts.google.com:oaud`. Azure pins issuer `https://accounts.google.com`,
numeric subject and `api://AzureADTokenExchange`. GCP grants only the required
impersonation permission on the exact writer account. Tokens are transient and
their actual expiration is respected. Sign-in alone does not prove that any
exchange or secret write succeeds.

## Shared lifecycle and native differences

The hosted library takes a strict nonsecret intent, transient authentication
callbacks and a compare-and-swap recovery store. It does not open local SQLite,
read a developer's credential chain, store tokens or contact contributors.
Provider drivers supply discovery, plans, native identity/ownership validation,
one-action execution and read-only reconciliation. The shared engine binds
scope, source, host identity, plan digest and exact confirmations, rechecks
current host authorization before dispatch, and persists an attempt before a
provider mutation. Noop causes zero mutations. An unresolved write can only be
observed; it cannot be retried as a new create. Definite no-effect rejections
require a separately confirmed retry. Store failure stops subsequent actions.

Actions describe actual prerequisites. Resources and reviewed secret targets
are distinct: Azure has no native secret until a contributor supplies its
value. Its writer has vault-scoped `readMetadata/action` and `setSecret/action`
and separate vault ARM read permission. The isolated vault is the native scope;
the reviewed key list is an additional host restriction, not an exact-name IAM
guarantee. Existing values and unrelated policy members remain preserved.

AWS quick-create links support an S3 template URL, stack name and documented
template parameters, not an OAuth callback or client request token. The
published immutable template and its digest are release prerequisites. Console
parameters are editable, so activation verifies the exact account, StackId,
template, resources, RoleId and trust/policies. Both DeletionPolicy and
UpdateReplacePolicy retain secrets, including rollback and disconnect paths.
The generated template supports up to 50 reviewed targets to remain within
native inline-role policy limits. Its exact bytes must be published under the
digest filename and an immutable S3 object version; setup checks the content
before presenting the console link. New AWS account discovery is unavailable
without existing customer authority: the administrator supplies/selects the
nonsecret account number, confirms it in the AWS console, and activation checks
the actual STS account independently.

AWS installs a separate disconnection role with a separate audience. Its only
write permission updates trust on the two exact owned roles; it has no secret
read/write or deployment access. A separately approved cleanup removes writer
trust and then its own trust, using the existing short-lived session to verify
the result. Sessions are never persisted. A restart after an unacknowledged
final removal can therefore leave cleanup verification pending. IAM trust
updates have no etag: observed unrelated statements are preserved, but native
IAM cannot atomically protect concurrent out-of-band trust edits.

GCP IAM writes preserve unrelated entries and use native etags. Azure role
assignments retain their exact IDs, scope, principal, role and ownership;
federated-credential writes are sequential. Completion requires native terminal
evidence and exact identity readback. Unknown reads, replaced resources and
unowned lookalikes block rather than becoming absence or automatic adoption.

## Collection, runtime and disconnection

The existing collection service owns app membership, recipient email proof,
expiry, source revalidation, durable attempt claiming and receipt publication.
Hypercloud handles plaintext transiently during the synchronous submission and
delivery request. Values never enter durable queues, browser storage, logs,
AI messages, plans or provider-error output. AWS uses its native version-token
correlation. Azure SET has no idempotency token; exact attempt tags and version
metadata may reconcile a lost receipt. GCP AddVersion has neither request ID nor
version attempt tag: a lost receipt remains unknown and never permits blind
resubmission. Historical uncertain attempts remain fenced after cancellation,
expiry, source changes and device revocation.

Deployment installs immutable references under separately authorized readers:
Cloud Run service accounts, ECS **task execution roles** for native environment
secret injection, and Azure Container Apps managed identities. Azure's
[prepared hosting lifecycle](connect-cloud-azure-prepared.md) installs the reader
UAMI and holding app under separately reviewed namespace authority, then binds
their verified native identities before the first managed release adds immutable
Key Vault references. The app-scoped identity settings prevent holding and
application code from obtaining UAMI tokens in this narrow reference-only path.
Ordinary CreateOrUpdate remains an upsert API; its create-only capability flag is
unchanged. The reviewed namespace contract does not prevent an independently
authorized concurrent overwrite. Historical blocked plans retain their rules;
read-only recovery and exact writer disconnection remain available. Native
installation, first image pull/reference consumption and disconnection still need
the approved Azure live walkthrough. The earlier
[conditional-header probe](connect-cloud-azure-disposable-probe.md) established
neither atomic creation nor that end-to-end acceptance.

The shared hosted installation engine is distinct from a full hosted application
deployment engine. Hypercloud currently composes `createUnavailableReconciliationEngine`
for the latter; its existing safe-staging-only protocol cannot authorize billable
first deployment. A full hosted application reconciler is a separate architecture
choice. The existing Hypervibe/CI runtime path may remain if separately authorized
transient/keyless deployment access and all native first-deployment criteria are
verified. Collection-writer credentials cannot substitute for deployment trust.
See the [execution dependency analysis](connect-cloud-hosted-deployment-prerequisites.md)
for the conditional extraction if hosted application reconciliation is selected.

Google scope discovery supports an existing active project or a separately reviewed
project-preparation stage. The latter creates and recovers the exact project, then
requires verified billing before a new collection review. New setup uses a versioned,
explicitly reviewed [initial billing assignment](connect-cloud-gcp-billing-assignment.md)
to the exact newly created project. The native PUT is not conditional: a pre-observed
different account blocks, but administrators must coordinate changes during setup.
Old unversioned plans remain blocked. Offline tests do not establish live onboarding.

Device revocation, request cancellation and hosted-trust removal are different
operations. Disconnect locally stops new submissions first, then uses a reviewed
administrator-authorized plan to remove only owned federation/impersonation and
writer grants. Preserve secrets, their versions and separately authorized runtime
readers. Report exact incomplete cleanup and outstanding token expiry/permission
propagation; removal of trust does not instantly invalidate issued credentials.

## Independent evidence and acceptance

The challenged assumption is that an existing delivery driver plus a sign-in
screen establishes new-customer cloud installation. Counterexamples include a
developer without cloud authority, an admin in another account, a host without
customer-cloud credentials, Azure's value-required SET, an edited CloudFormation
template, and a first workload with no reader identity.

Official contracts reviewed before adapter work:

- [AWS console installation](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stacks-quick-create-links.html),
  [Google federation](https://aws.amazon.com/blogs/security/access-aws-using-a-google-cloud-platform-native-workload-identity/),
  [STS web identity](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html),
  [secret retention](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html),
  [ECS reader role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html).
- [Azure external federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-google-cloud),
  [vault isolation](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide),
  [published secret permissions](https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/security),
  [value-required SET](https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/set-secret/set-secret?view=rest-keyvault-secrets-2025-07-01),
  [first-deployment identity](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets),
  [CreateOrUpdate](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/create-or-update?view=rest-resource-manager-containerapps-2025-07-01).
- [Google online OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
  [host service identity](https://docs.cloud.google.com/run/docs/securing/service-identity),
  [impersonation](https://docs.cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken),
  [non-idempotent AddVersion](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/addVersion).

Normal CI must cover the named provider roster, fresh customers with no local
credentials, separate developer/admin/contributor identities, tenant/environment
isolation, permission changes, partial installation, restarts, lost receipts,
no blind retries, preservation and disconnect. Hypercloud tests use the actual
packed Hypervibe library, not source-module substitutions. Provider tests mock
only serialized transport and label reconstructed fixtures. Browser tests cover
desktop/mobile and an independent clarity review.

Dependency repairs, an approved package release/exact consumer pin, verified
host identity, OAuth registrations/redirects, AWS template publication and three
approved disposable-account walkthroughs remain explicit release gates. Both
PRs remain drafts until all agreed criteria are met. No merge, publication or
deployment is authorized by this design document.

Dependency review at 2026-10-25 07:39 UTC confirmed the unresolved Azure
Identity/MSAL release gate. The lock selects Identity 4.13.2 and MSAL Node 5.5.0; Microsoft's
[advisory](https://github.com/AzureAD/microsoft-authentication-library-for-js/security/advisories/GHSA-xcx6-jx8p-x3h5)
identifies MSAL 7.1.0 as the patched floor. Published Identity 4.14.0 and
4.15.0-beta.1 still require MSAL 6. The public npm registry contained 810 Identity
versions; none declared a range accepting MSAL 7.1.0 or later. An isolated,
script-free lockfile resolution of Identity 4.14.0 selected MSAL 6.0.1;
`npm audit --omit=dev` exited 1 with the same two high findings (the MSAL advisory
and its Identity dependency), matching the current application audit. These are
package-resolution observations, not a reproduced application exploit. Microsoft's
repository advisory labels severity moderate, while npm's advisory feed labels
it high; both give the same affected range and patched floor.

The [upstream Identity upgrade issue](https://github.com/Azure/azure-sdk-for-js/issues/40441)
remained open after maintainer acknowledgment. The official
[security patch](https://github.com/AzureAD/microsoft-authentication-library-for-js/pull/8901)
is merged, but published MSAL 5.x and 6.x end at 5.6.0 and 6.0.1 respectively,
both inside the advisory's affected range. Updating only Identity therefore
does not repair this gate. An override to MSAL 7 crosses the SDK's declared
compatibility range and [documented interactive-authentication changes](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/v7-migration.md).
The audit's suggested downgrade to Identity 4.13.0 would also discard later
structured-process credential execution and dependency fixes, so it is not an
accepted repair. Package manifests and the lockfile remain unchanged.

The smallest supported repair is an upstream Identity release accepting patched
MSAL. A maintained backport would instead require a separately reviewed artifact,
provenance, upstream patch regression, SDK credential-chain compatibility checks,
and an explicit maintenance owner; none is currently established. Hypervibe uses DefaultAzureCredential;
the absence of a direct authorization-code call limits demonstrated reachability
but does not clear the audit finding. See the [Identity changelog](https://github.com/Azure/azure-sdk-for-js/blob/main/sdk/identity/identity/CHANGELOG.md)
and [MSAL changelog](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/CHANGELOG.md).

Hosted operator configuration pins the native service account email,
`SECRET_DELIVERY_GCP_HOST_SUBJECT` and
`SECRET_DELIVERY_GCP_HOST_PROJECT_NUMBER`; metadata and Google JWT verification
must match all three. `SECRET_DELIVERY_AWS_TEMPLATE_URL` and
`SECRET_DELIVERY_AWS_DEPLOYMENT_TEMPLATE_URL` select the reviewed collection and
deployment template versions. Blank values leave the corresponding new connection
unavailable; the existing Railway staging declaration supplies no native Cloud Run
identity.

The supported publication strategy is a nonsecret object in a versioned S3 bucket,
using `https://<dotless-bucket>.s3.<region>.amazonaws.com/<sha256>.json?versionId=<URL-encoded-version>`
(an object-key prefix is allowed; the complete template URL must fit the console's
1,024-character limit). Configure exactly one nonempty version ID, never
the overwriteable literal `null` version. The publisher must approve version-specific
read access usable by Hypercloud and CloudFormation; neither driver uploads templates
or falls back to customer keys. The hosted verifier requires the exact native
`x-amz-version-id`, final response URL and generated SHA-256, rejects redirects, and
bounds body reads to 15 seconds and 1 MiB. Standard HTTPS wildcard certificates do not
support dotted bucket names. Arbitrary HTTPS hosts, S3 website endpoints, presigned
URLs and Systems Manager document URLs are outside this chosen publication strategy.
CloudFormation limits inline `TemplateBody` to 51,200 bytes; these generated templates
are larger, so inline submission is not a fallback. See the official
[CreateStack contract](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_CreateStack.html),
[console template URL and version contract](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stack.html),
[S3 HTTPS host rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html),
[null-version overwrite behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/AddingObjectstoVersionSuspendedBuckets.html),
and [version-specific GetObject contract](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).


### AWS runtime reader acceptance and native limits

The ECS runtime frontier verifies the exact execution role (including its native
RoleId), secret ARN, creation time and immutable version before planning a
service-specific inline reader policy. It runs after the project bootstrap and
before the first workload. Application task-role creation and S3 grants remain
separate. Existing execution roles and unrelated policies are preserved; the
reader policy is retired only after the consuming task no longer references its
secrets. New connections use the default Secrets Manager KMS key. Existing
version KMS key ARNs may receive narrowly scoped decrypt permission with
ViaService and SecretARN encryption-context conditions; unresolved key aliases
or incomplete version metadata block instead of inventing authority.

Independent contracts: [ECS execution-role permissions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html),
[IAM inline policy writes](https://docs.aws.amazon.com/IAM/latest/APIReference/API_PutRolePolicy.html),
[secret version metadata](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_ListSecretVersionIds.html).
IAM does not expose an etag or conditional PutRolePolicy. The implementation
verifies its dedicated policy and immutable role immediately before one write,
then re-observes the role and attempt-tagged policy. It preserves known external
edits but cannot claim atomic exclusion of concurrent external IAM changes.
Uncertain writes remain pending for read-only recovery and are never replayed.

The counterexample was a project-bound first deployment with an immutable
reference and no service: the old after-workload gate omitted the required
execution-reader grant. Four new wire/shared-frontier regressions failed before
implementation. Native transport tests now cover first deployment, distinct
application/execution roles, mixed S3 and secret planning, insufficient access,
replacement roles/secrets, absent versions, lost acknowledgments, preserved
policies, conditional KMS access and consumer-first cleanup. A second regression
proved existing primary-container deployments replaced the execution role with
a generated name; the update now preserves the observed identity. The shared
plan/apply test persists the reader frontier and observes a mutation-free noop.
These are reconstructed offline native contracts, not disposable-account or
live ECS deployment evidence. All AWS, Azure and GCP live walkthroughs remain
release prerequisites.


ECS permission retirement additionally checks every active Express configuration
and bounded `ListTasks`/`DescribeTasks` inventories before changing IAM, including
tasks with desired status RUNNING whose last status is still PENDING. The same
read-only check runs immediately before the native write. Three regressions
first failed because the old configuration, pending task, and omitted inventory
were treated as safe removal; they now preserve access or report unknown.
See [Express active configurations](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ECSExpressGatewayService.html)
and [task status filtering](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ListTasks.html).

The device client archives an exact cancelled/disconnected connection only on an
explicit new `connect` request, after validating the new source and selected
keys. Status and device sign-in do not start another installation. Previous
nonsecret installation and acceptance records survive device revocation and
re-pairing; a lost response for the new UUID is recovered without another POST.
Two command-boundary regressions failed on the permanently occupied old slot
before this transition was implemented. Reusing retained native destinations
requires the server's separately reviewed writer-migration path.

GCP fresh-project creation now has a separate [scope preparation stage](connect-cloud-scope-preparation.md).
Its first `scope-ready` result proves project creation only. A second linked
scope review shows the observed parent and selected billing account before a
fresh collection review. New versioned plans separately authorize the native
initial assignment with its explicit concurrent-change limitation; old plans
remain blocked because their link-only contract cannot be established. No
temporary IAM grants are created by the new path. Exact historical temporary
grants retain a separately reviewed cleanup path.
AWS account creation and Azure subscription creation remain unsupported scope
stages. No live support claim or release gate is changed by this offline implementation.

## Agent onboarding guidance regression

The challenged assumption was that exposing Connect Cloud as a tool was enough
to direct a new customer into it. The independent requirement is onboarding
without local cloud credentials or a manually prepared writer. A concrete
counterexample was the actual MCP initialization response recommending GCP
bootstrap, which creates a deployment service-account key, while connection
discovery led with credential-file setup and even suggested chat entry.

Three regressions first failed against the actual MCP initialization instructions,
`tools/list` metadata and empty `hv_connections` response. They now pass with
the implemented AWS/Azure/GCP browser route as the default, explicit legacy-key
wording and private references for credentials a user already controls. The
legacy operation and credential input behavior remain unchanged. Hosted setup
unavailability is a prerequisite to report, never permission for a key fallback.
Review added an initialization regression for two further counterexamples:
existing-target/migration acceptance must preserve its committed references, and
legacy preview may infer a project ID although confirmation requires the exact
returned ID. That regression failed before those instruction corrections; the
guidance now follows the returned continuation rather than requiring a patch or
an extra project-ID question in every mode.

These checks run in ordinary `npm test` discovery. Both the committed acceptance
workflow and desired required-check configuration include that path; repository
files do not establish live branch-protection enforcement. This is instruction
delivery evidence, not proof of browser authorization, native installation or
end-to-end cloud compatibility. The existing live walkthrough gates remain open.

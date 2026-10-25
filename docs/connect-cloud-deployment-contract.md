# Connect Cloud deployment authority

The selected execution path is Hypervibe's existing local plan/apply and managed CI.
Hypercloud verifies app/device or CI authority and brokers short-lived credentials; it
is not a second application planner. Collection, deployment provisioning, CI release,
and runtime reading use separate principals. The drafts remain incomplete until the
provider lifecycle and disposable-account walkthroughs pass.

## Shared contract

A deployment installation uses the existing reviewed installation lifecycle with
`purpose: deployment`, `stage: deployment`, and `keys: []`. Its source-bound topology
names the hosting provider, region, workloads, and each workload's immutable secret
references. Uncollected secrets have no usable version and block this review. Database,
storage, and arbitrary IAM administration are outside this initial authority contract;
their presence must not cause deployment roles to gain broad IAM rights.

The value-free connection records the exact customer/app/environment, immutable source,
installation ID and plan digest, native cloud scope, verified Hypercloud host identity,
distinct provision/release principals, and separately installed runtime identities.
Runtime identities retain their native lifetime IDs and original ownership digest.
Local environment UUIDs cannot rename or substitute those native identities. Existing
bindings remain authoritative; any new binding needs an explicit verified lifecycle
step. Topology or native placement changes require another administrator review.

Registry `transientAuthentication` declarations are explicit. An undeclared capability
returns unsupported instead of using the legacy credential factory. Callback results
are strictly checked for identity, required session material and expiry; callback errors
are reduced to closed, value-free codes. GCP has one fixed cloud-platform token callback.
Azure has closed resource-manager/container-registry targets, not arbitrary scope strings.
AWS requires temporary access key, secret key, session token and expiry together.

The broker rechecks current authorization and host identity after provider observations,
immediately before issuance, and honors cancellation and a bounded deadline. Token
responses are sensitive internal transport data: they never enter installation records,
plans, command envelopes, log messages, queues, or browser storage. The authenticated
broker response must bind origin, device or observed CI identity, purpose, app/environment
and exact receipt. Receipt possession alone does not authorize a session.

## Provider contract and evidence matrix

| Cloud | Administrator installation | Ongoing access and native identity proof | Runtime and initial blockers |
| --- | --- | --- | --- |
| AWS / ECS | Reviewed, immutable CloudFormation template creates separate provision/release roles, exact PassRole targets and runtime reader roles. Console-edited parameters are untrusted until native stack/template/role verification. | Google host ID token uses purpose-specific audience; STS web-identity returns a 900-second session. Signed GetCallerIdentity independently checks account, assumed-role ARN and immutable role ID. Native roles/trust/policies are re-observed before broker issuance. | ECS execution role reads exact Secrets Manager containers; application task role remains separate. Runtime roles must exist before Express creation. Provision must not create or attach arbitrary IAM roles. Template publication and live verification remain release gates. |
| GCP / Cloud Run | The contract requires transient browser installation of separate provision/release service accounts, precreated runtime accounts, narrow actAs and reviewed secret-reader grants. Native scoped deployment installation remains blocked: parent-authorized creates and Cloud Run update permissions cannot be described as verified exact-name grants. | Dedicated Hypercloud host impersonates the exact customer account UID. Fixed OAuth scope does not downscope IAM. Provider checks service-account/project lifetime and official token-info identity where applicable. | Runtime accounts read exact containers, while workload references pin immutable versions. Fresh project creation has a separate review; automatic fresh billing remains explicitly blocked pending preservation-safe native semantics. Auth callbacks and emitted CI do not establish a complete new-customer installation. |
| Azure / Container Apps | Reviewed resource/UAMI/federated-credential/custom-role installation. Existing create-ownership gaps block fresh installation before any writes. | Google assertion is exchanged at the exact Entra tenant/client for a closed ARM or ACR target. Opaque resource tokens are not decoded as caller proof; verified native UAMI/FIC identity, OAuth issuance and authenticated broker response bind the principal. | Precreated runtime UAMI avoids the first-container system-identity cycle. Its Key Vault and ACR access is installed separately. Ongoing provision/release identities cannot write arbitrary RBAC or fetch Key Vault values. Native atomic first-create ownership remains a blocker. |

Official evidence: [STS web identity](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html),
[STS caller identity](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html),
[ECS operation/resource permissions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html),
[ECS Express runtime role requirements](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html),
[Cloud Run deployment permissions](https://docs.cloud.google.com/run/docs/deploying),
[Google service-account deployment guidance](https://docs.cloud.google.com/iam/docs/best-practices-for-using-service-accounts-in-deployment-pipelines),
[Azure container roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers),
[Azure secret management](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets), and
[ACR Entra-token exchange](https://learn.microsoft.com/en-us/rest/api/registry-dataplane/authentication/exchange-aad-access-token-for-acr-refresh-token?view=rest-registry-dataplane-2021-07-01).

A deployer can run application code under its reviewed runtime identity; excluding
secret-manager read calls from the deployment role does not make an authorized deployer
incapable of accessing those values through application code. Bearer sessions are bounded
by native IAM and expiry, not cryptographically by local plan/action IDs. Local plan/apply
still enforces exact actions. Removing hosted trust prevents future minting; already
issued credentials may remain usable until expiry.

## Proposed GCP resource preparation — not implemented

Prefer preparing the exact hosting resources inside the initial reviewed installation
graph. This avoids giving ongoing deployment principals project-wide creation rights
or requiring the administrator to return solely to grant access after first apply.
The administrator's transient authority performs the approved dependency graph;
Hypercloud still does not become an application build/deployment reconciler.

| Boundary | Proposed contract | Current evidence or remaining prerequisite |
| --- | --- | --- |
| Project scope | Explicit app/environment mapping, native project number/createTime and original ownership evidence. A dedicated project is an isolation choice, not the definition of a Hypervibe environment. | Existing project-preparation journal can supply exact scope. Fresh automatic billing remains blocked; pending-deletion projects are unusable. |
| Hosting preparation | Create the reviewed registry and private, digest-pinned holding services/jobs; observe operation completion, resource UID/createTime, ownership and configuration before dependent IAM writes. | Cloud Run service/job creation authorizes on the parent. Hosting preparation in the installer and its shared prepared-resource receipt are not implemented. |
| Holding runtime | Use a separately identified holding service account with no application secret permissions or values. Jobs have no executions/triggers; holding workers remain inactive until the reviewed rollout enables their normal CPU/floor. | Requires an operator-published, reviewed immutable image and verified pull access. No hidden customer Cloud Build, mutable public sample tag, or claim of zero startup cost. |
| Ongoing grants | Grant provision/release access on exact prepared services/jobs and registry; actAs only on reviewed runtime identities. Install desired public access as an explicit dependent setup action. | Cloud Run and Artifact Registry support resource IAM. Preserve unrelated policy entries with native etags. Public access requires run.services.setIamPolicy; the ongoing deployment role must not acquire it implicitly. |
| Hypervibe handoff | Receipt pins installation/plan/source/scope, workload and registry lifetimes, holding image/configuration/identity, and final runtime identity. Plan an explicit metadata binding before first application rollout. | Requires a shared frontier and provider conformance tests. Receipt possession is not adoption authority; fresh native proof and exact source authorization remain required. |
| First rollout | Update only the verified prepared resource. The one approved identity transition is holding SA → recorded application SA. Preserve existing workloads' observed identities and immutable secret references otherwise. | Requires first-deployment, restart, stale receipt, changed image/SA, missing binding and mutation-free noop coverage. CI cannot create a missing replacement. |

Official contracts: [service creation](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/create),
[job creation](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/create),
[resource IAM and public access](https://docs.cloud.google.com/run/docs/securing/managing-access),
[service policy replacement/etag](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/setIamPolicy),
[repository policy](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories/setIamPolicy),
and [runtime identity permissions](https://docs.cloud.google.com/run/docs/configuring/services/service-identity).
Google documents [digest-pinned images and per-service deployment roles](https://docs.cloud.google.com/run/docs/deploying).
Inherited allow policies can broaden effective authority; installed bindings alone do
not prove its absence. Inspection must account for readable parent policies and report
unknown scope, following [Google's inheritance contract](https://docs.cloud.google.com/iam/docs/resource-hierarchy-access-control).

The alternative is a reviewed dedicated project with explicitly project-scoped provision
authority, followed by a separately reviewed exact-resource release/public-access grant
after first apply. It is feasible in principle but requires an explicit provision-ready
versus release-ready lifecycle. Neither alternative is implemented by the current GCP
authentication callback or CI emitter. AWS's existing CloudFormation path is unchanged;
Azure remains blocked on native create ownership. A shared preparation capability must
declare all three providers implemented/unsupported explicitly before any promotion.

## Managed CI

CI uses the separate release principal and may update only resources a reviewed apply
already created and bound. First infrastructure preparation remains Hypervibe plan/apply.
The broker verifies signed CI claims against independently stored repository identity,
subject configuration, environment/ref/workflow policy and a freshly observed native run.
Run ID, attempt, commit and workflow implementation must not come solely from request
fields. GitHub legacy and immutable subjects need exact case-sensitive matching; a
branch-only GitLab subject does not prove environment isolation. See the official
[GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc) and
[GitLab token claims](https://docs.gitlab.com/ci/secrets/id_token_authentication/).

The implemented broker protocol currently accepts GitHub Actions. The emitted program
requests `id-token: write`, selects the exact app/environment connection, and uses audience
`<approved-origin>/api/v1/deployment-sessions`. It reads the committed specification at the
workflow SHA through the [GitHub Contents API](https://docs.github.com/en/rest/repos/contents#get-repository-content)
and sends its exact-byte digest to the release-only endpoint. A dispatched application
candidate may differ from that workflow SHA. Owner approval occurs after the managed
workflow is published; the server selects its active approved policy. Embedding a policy
digest in the program that the policy itself hashes would create an approval cycle.

The new mode does not copy static cloud credentials into CI. Provider callbacks obtain
short-lived release sessions and verify their exact principal and expiry. The broker
response is bounded through body completion, redirects are rejected, errors use fixed
value-free messages, and credentials are never action outputs. Registry authentication
uses Docker stdin and a temporary job-local configuration removed by an `always()` step.
That configuration necessarily holds transient registry authorization while the job runs.
AWS [ECR authorization](https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_GetAuthorizationToken.html)
can last 12 hours; removal of hosted role trust must not be described as immediate
revocation of every previously issued registry token. GCP uses its
[documented OAuth Docker login](https://docs.cloud.google.com/artifact-registry/docs/docker/authentication#token).
Interrupted runners can prevent cleanup; native expiry remains the final limit.

GCP new-mode rendering requires explicitly applied registry name/createTime and workload
UIDs; Azure requires its registry ARM ID/login server/create time and app lifetime IDs.
There is no default-registry adoption. GitLab portable rendering rejects the new mode
explicitly until its broker identity verification is implemented; it never falls back
to saved customer keys. Legacy connections retain their existing explicit path.
The new connection is already a semantic workflow input; adding it selects a new program
without incrementing every legacy provider's renderer revision. Legacy emitter results
are pinned against committed `7fcb852`, including whitespace. Existing AWS/Azure input
hashes and GCP revision 2 remain unchanged.

## Regression evidence and remaining gates

The AWS publication audit disproved the initial suspicion that arbitrary HTTPS hosts
were accepted: both drivers already rejected them and S3 website endpoints. The real
counterexamples were overwriteable `versionId=null`, duplicate version parameters,
dotted HTTPS bucket names, and responses lacking the requested native version or URL.
Twelve reconstructed HTTP cases failed through the actual collection/deployment drivers
before their shared verifier; two additional cases failed against the console's
1,024-character URL limit. All now pass, together with exact byte hashing, encoded
opaque versions, redirect rejection, bounded streaming and native installation recovery.
The [S3/CloudFormation publication contract](connect-cloud-contract.md) records official
sources and required operator configuration. These tests do not prove published object
access or a successful live console installation; both remain release prerequisites.

The shared boundary's original assumption was that a source hash and generic connection
were enough to select deployment access. Counterexamples include a collection principal,
a release principal substituted for provision, missing topology, a same-name replacement
native identity, expired sessions, and revocation while native observations are in flight.
The new tests first failed for absent shared session/registry functionality and for the
accepted missing topology. Shared lifecycle, token-boundary and cancellation regressions
now pass in normal Vitest discovery. They use explicitly synthetic provider semantics;
native adapters additionally require reconstructed official serialized transport tests.

Additional observed regressions include a normalized logical name colliding with an
explicit hashed name (`Web` and `web-29751047`), AWS access-denied/service-failure responses
being mislabeled as replaced identities, and a replaced execution RoleID being accepted
during release enrollment. Those tests failed before their guards and now pass. Official
[IAM errors](https://docs.aws.amazon.com/IAM/latest/APIReference/CommonErrors.html),
[GetRole identity](https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetRole.html),
[ECR creation timestamps](https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_Repository.html),
and [EC2 creation/tag authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html)
define the reconstructed native expectations. Emitted AWS login runs through the real
ECR SDK with a reconstructed HTTP transport; emitted GCP login exercises serialized REST
responses, lifetime replacement, password stdin and absence of token outputs. Broker
tests exercise closed response shapes, expiry, body deadlines, redirects, source mismatch
and safe failures. These are offline contract tests, not evidence of successful cloud CI.

The full acceptance run exposed an unintended legacy workflow migration after global
provider revision bumps. Direct comparison with `7fcb852` also found whitespace drift
in all three legacy emitters and an extra GCP environment guard introduced by factoring.
Those differences were removed; the existing input-hash regression and new pinned
legacy-output regressions now pass alongside executed broker/legacy workflow tests.
Golden outputs are generated under the normal Vitest transform because emitted helpers
include function source; compiled JavaScript and test transforms are not interchangeable
golden-output generators.

Cloud Run's first service receipt previously discarded its server-assigned UID, so the
next installed-runtime observation could not distinguish the original workload from a
replacement. Two failing serialized-transport cases now require retaining that UID and
rejecting a missing UID. Further observed failures allowed changed or omitted approved
secret references, deletion of an approved key, or a same-name replacement to reach a
provider write. Both deployment and environment updates now reject those changes before
mutation. Existing service updates carry the observed native etag, reject missing etags,
and do not replay a conflict. The independent contract is the Cloud Run v2
[Service UID and etag definition](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services).
The affected adapter, installed-runtime and legacy-runtime suites pass together (141
tests). These fixtures use reconstructed metadata and synthetic retained installation
receipts; they do not establish a working native GCP deployment installer.

No offline result proves live trust, available billing, RBAC propagation, first deployment,
or CI release compatibility. Each provider still needs the approved no-local-credentials
walkthrough: separate developer/admin/contributor, connect, synthetic secret submission,
first deployment with immutable references, repeat update/recovery, then collection
disconnection preserving the separately authorized deployment/runtime access. Legacy
static connections remain usable only through their explicit existing path; new keyless
connections never fall back to them.

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
| GCP / Cloud Run | Transient administrator installs exact registry and inactive holding web/worker services, distinct provision/release/holding/runtime accounts, and separately reviewed resource IAM. Initial native path requires a project without an organization parent and an operator-configured public digest image. | Dedicated Hypercloud host re-observes native lifetimes and installed permissions, then impersonates the exact provision/release account UID for 900 seconds. Fixed cloud-platform OAuth scope does not downscope IAM. | Shared prepared-binding frontier and first-rollout transition have offline transport/lifecycle evidence; they are not live acceptance. Runtime readers retain exact containers and immutable versions. Cron/release commands, broader storage topology, ancestor/group authority and the approved live walkthrough remain explicit limits. Initial billing has a separate versioned review with documented native non-atomic semantics. |
| Azure / Container Apps | Reviewed exclusive app/environment namespace, native ARM deployment provenance, distinct UAMIs/custom roles and no-secret holding apps. Native upsert concurrency limits are explicit; existing/unknown targets and uncertain provenance block. | Google assertion is exchanged at the exact Entra tenant/client for a closed ARM or ACR target. Opaque resource tokens are not decoded as caller proof; verified native UAMI/FIC identity, OAuth issuance and authenticated broker response bind the principal. | Installed reader UAMIs and separate Key Vault/ACR grants feed the shared prepared-binding frontier and one candidate-image/reference rollout. Identity lifecycle None keeps the platform reader unavailable to holding container code. [Offline native/emitted evidence](connect-cloud-azure-prepared.md) is implemented; operator image publication, live runtime consumption and the approved walkthrough remain gates. |

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

## GCP prepared deployment

The native installer prepares exact hosting resources inside the reviewed installation
graph using transient administrator authority. Ongoing deployment principals receive
resource-scoped updates and registry access, plus narrowly enumerated project reads;
they receive no project-wide create or IAM-write grant. Hypercloud brokers credentials
and installation; ordinary application reconciliation remains Hypervibe plan/apply and
managed CI.

| Boundary | Implemented behavior | Remaining limit |
| --- | --- | --- |
| Project scope | Pin native project number and createTime; inspect project IAM and effective permissions of directly matching custom roles. | Initial path supports projects without an organization parent. Unknown group/principal-set authority blocks. Newly created projects use separately reviewed initial billing assignment; old unversioned billing plans remain blocked. |
| Native preparation | Separate reviewed POST actions create custom roles, provision/release/holding/runtime accounts, registry and inactive web/worker services; observe native ownership and lifetime before dependent grants. | Operator must publish and configure a reviewed public digest image; no image is supplied by default. Cron, release commands, databases, storage and queues are explicitly unsupported in this initial deployment topology. |
| Secret authority | Review pins existing secret-container createTime and immutable versions before any writes; exact runtime reader grants preserve values and unrelated policy entries. | No secret values are fetched; secret collection remains separately authorized. |
| Hosted proof | Independently read installed resources and policies with the actual hosted identity before publishing the connection. Provision and release mint by immutable native SA UID, validate token identity and expiration, and recheck caller authority. | Native permissions, propagation and token acceptance still need the approved disposable-account walkthrough. |
| Hypervibe handoff | Optional prepared receipt pins project/registry/workload lifetimes, original holding generation/revision/configuration and final runtime identity. An explicit local metadata action records verified bindings. | Receipt possession does not authorize adoption; current native proof, exact source and existing recovery vetoes still apply. |
| First rollout | Exact holding image and identity transition together to the candidate image and final runtime account. Original generation/revision prevents replay after rollout. Pending markers retire only with independent managed-CI release provenance and matching native image/configuration against the prior reviewed digest. | Missing release evidence keeps pending; holding readiness is never application convergence. |
| Disconnect | Remove only exact recorded hosted grants with native identity and IAM etag proof. | Secrets, registry/workloads, public access and separately authorized runtime readers are preserved; existing issued credentials have native expiry limits. |

See [GCP evidence and remaining gates](connect-cloud-gcp-deployment-evidence.md).
The shared [prepared-hosting contract](connect-cloud-prepared-hosting.md) records the
named provider matrix. AWS's existing absent-preparation path remains unchanged.

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
receipts. The later native installer evidence is recorded separately; neither suite establishes live compatibility.

The integration with main `3bfe9b98d5d262741de01ef4d6cb8e0c5a0703a1` preserves
its credential deployment receipts, exact active ECS configuration selection, and native
identity/drain evidence. The earlier `7fcb852` legacy byte baseline above is historical:
all three legacy emitters now match an independently executed, unmodified archive of the
new main under the same Vitest transform (including main's renderer revisions).

Two merge assumptions were falsified at real boundaries before runtime fixes:

- A hosted ECS adapter has no local keys. Registry rotation nevertheless called the real
  secret-manager connection boundary with undefined keys in both update and reconciliation,
  which admits the machine's default credential chain. The user-required separation of
  deployment and secret management authority forbids that fallback. The observed failing
  regression now passes with explicit hosted denial before secret-store connection; existing
  local registry rotation retains its separately authorized path.
- Azure's prepared branch skipped the new credential rollout receipt. Executing its generated
  script against independently authored native responses returned an empty receipt for both
  first deployment and a same-image credential operation (two observed failures). It now
  verifies the operation-specific native revision and emits that exact deployment ID. A lost
  acknowledgment produces no receipt in that execution; subsequent readback recovers the
  accepted revision with no second write. This follows main's rotation evidence contract and
  Azure's revision/readback contract cited in [prepared hosting evidence](connect-cloud-azure-prepared.md).

The focused AWS/Azure, credential lifecycle, prepared release and legacy compatibility
regressions pass together (166 tests in 16 files) after a clean dependency install. They
remain in ordinary `npm test` discovery and the committed acceptance workflow. They validate application/SDK/emitted-program behavior against reconstructed transport;
none establishes live federation or a successful cloud deployment.

No offline result proves live trust, available billing, RBAC propagation, first deployment,
or CI release compatibility. Each provider still needs the approved no-local-credentials
walkthrough: separate developer/admin/contributor, connect, synthetic secret submission,
first deployment with immutable references, repeat update/recovery, then collection
disconnection preserving the separately authorized deployment/runtime access. Legacy
static connections remain usable only through their explicit existing path; new keyless
connections never fall back to them.

# Explicit local cloud authentication

This reconciliation retains the preserved AWS/Azure native authentication work
alongside the newer Connect Cloud browser installation and deployment contracts.
Local authentication requires an explicit `authMode: "default"` connection.
It does not become a fallback for unavailable hosted setup, install cloud CLIs,
generate keys, or authorize infrastructure changes outside spec → plan → apply.

## Reviewed provider boundary

| Registered paths | Native contract and retained implementation | Limits |
| --- | --- | --- |
| AWS `ecs`, `rds`, `elasticache`, `s3` | The [Node.js credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html) resolves the explicitly selected profile or default chain. [GetCallerIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html) independently supplies account and ARN. Refreshed credentials must match the pinned account before provider requests; target-region changes retain that identity. | Local profile, SSO and session values remain in memory. Default/session credentials are rejected for unattended credential projection. Account identity does not prove permissions or pin one IAM principal within that account. |
| Azure `azure-container-apps`, `azure-postgres`, `azure-managed-redis`, `azureblob` | [DefaultAzureCredential](https://learn.microsoft.com/en-us/javascript/api/@azure/identity/defaultazurecredential) acquires local tokens. Subscription [List](https://learn.microsoft.com/en-us/rest/api/resources/subscriptions/list?view=rest-resources-2022-12-01) and [Get](https://learn.microsoft.com/en-us/rest/api/resources/subscriptions/get?view=rest-resources-2022-12-01) establish an enabled subscription and tenant. Complete bounded pagination must expose one unambiguous subscription unless explicitly selected. Subsequent reads retain that scope; expiring tokens refresh. | Missing or contradictory identity evidence blocks. Native tokens are not persisted. Local mode cannot establish the distinct deploy client needed by Container Apps runtime-identity reconciliation and returns an explicit Connect Cloud/service-principal prerequisite. Existing hosted UAMI verification is unchanged. |
| GCP `cloudrun`, `cloudsql`, `gcs` | Existing [local ADC work](gcp-local-default-auth.md) and storage authentication remain separate provider-owned paths. | Existing ADC authentication and federation remain. GCS and Cloud Run now reject local/default credentials before unattended CI/backup projection, preserving valid explicit automation and federation paths. |
| Other registered hosting, database, cache and storage providers | Existing provider-specific credentials and capabilities remain in effect. | No AWS/Azure default-chain fallback is introduced for another provider or account. |

The shared optional `verifiedIdentityKeys` contract permits only provider-declared,
non-secret schema fields. After successful verification, the encrypted selected
connection gains those fields without replacing an existing account/profile/tenant
selection. Invalid, undeclared, credential-shaped or schema-stripped fields fail
before persistence. Failed verification never reads the descriptor. Current exact
value redaction, hosted federation, and runtime credential separation remain intact.
GitLab portable CI variable selection also honors the provider's automation
admission decision at both plan and apply, before any variable write. The restored
transport regression first failed because a revoked admission decision still
produced a plan; it then passed with both stages blocked and zero variable writes.

Repository selection also retains the complete nested namespace. For
`gitlab.example.com/studio/team/app`, `team/app` is a different repository and
cannot authorize its credential. Exact host/full-path, full-path legacy, intentional
wildcard and global precedence are preserved.

## Assumptions and executed evidence

The challenged assumptions were that direct cloud connections require copied
keys, that the first subscription page or an HTTP success proves the selected
Azure scope, that a successfully verified account need not be retained, and that
the last two repository path segments are a safe legacy alias. Independent
requirements are DG-055/DG-072, the architecture's exact identity/secret boundaries,
and the official contracts linked above. Concrete counterexamples are a valid
local profile, two enabled Azure subscriptions split across pages, a changed
tenant/account after authentication, and two nested repositories sharing the same
last two path segments.

Observed before runtime changes: AWS native tests failed 27 of 28, Azure native
tests failed 12 of 16, encrypted identity tests failed 6 of 7, registry identity
metadata tests failed 8, and repository-scope regressions failed 3. These checks
passed after the targeted ports. A later Azure blocker test also failed before
the specific missing-deploy-principal explanation replaced the generic reason.

AWS tests execute the real SDK credential resolver, signing and serialization
against a local synthetic HTTP fixture. Azure tests execute the real adapters and
serialized ARM transport with stubbed token acquisition and reconstructed Microsoft
responses. Shared identity/scope tests use real SQLite and encrypted persistence
with a synthetic adapter. Additional checks preserve existing Azure hosting,
database, storage, federation, dependency compatibility, connection redaction and
form behavior. `npm run typecheck` passed. These are offline behavioral contracts,
not pinned-schema certification or evidence of live provider compatibility.

The tests run in ordinary `npm test`; both the committed
`.github/workflows/hypervibe-acceptance.yml` and desired `.hypervibe/spec.json`
required acceptance configuration include it. Repository configuration does not
prove live branch-protection enforcement. No live authentication, login, cloud
mutation, release, publication or customer-incident root cause was established.

## Login refresh without an ambient region

A later read-only check on 2026-10-28 found a native AWS console-login profile
containing `login_session` but no region. The packaged SDK could use its cached
short-lived credentials, then failed to refresh after expiry because no region
was available. Supplying the already selected region let the official SDK refresh
and independently verify the same account; no new browser consent or profile
edit was necessary. This disproves the assumption that cached-token success
establishes that the credential chain can refresh under the same process inputs.

The [AWS login provider contract](https://docs.aws.amazon.com/sdkref/latest/guide/feature-login-credentials.html)
describes automatic renewal. The installed, lockfile-pinned SDK's public
`AwsIdentityProperties.callerClientConfig.region` context and
[LoginCredentialsFetcher](https://github.com/aws/aws-sdk-js-v3/blob/main/packages-internal/credential-provider-login/src/LoginCredentialsFetcher.ts)
establish the region handoff: an explicit login-profile region takes precedence,
then the caller region, then the ambient region. Passing an inner `clientConfig`
override would change that precedence and is deliberately avoided.

Hypervibe now passes the selected region when invoking all three local AWS
credential-chain paths: shared ECS/RDS/ElastiCache/S3 authentication, operator
template publication, and existing Secrets Manager connection setup. The profile,
SSO configuration, native account checks, temporary-session restrictions and
hosted role boundaries are unchanged. This does not add ongoing renewal to the
legacy secret manager's already connected credential snapshot.

Four regressions failed before runtime correction while three explicit-profile
controls passed. Tests use an isolated synthetic expired login cache and execute
the real SDK chain, DPoP generation, serialized Signin refresh, cache update and
STS verification with only transport replaced. They cover missing ambient region,
explicit profile-region precedence and a changed account after refresh. All seven
pass after correction; the focused eight-file group passes 98 tests and normal
typechecking passes. These tests run in ordinary `npm test`. The native observation
proves refresh and account identity only, not cloud write authority or publication.

## Preserved work that was superseded

The original `aws-connection-bootstrap`, `azure-connection-bootstrap`, generic
`cloud-connection-bootstrap` and automatic `cloud-local-setup` implementations,
their tests, and their guidance remain in the immutable reconciliation archive.
They are superseded by the separately reviewed browser installation authority in
[Connect Cloud](connect-cloud-contract.md). They are not restored by native login
support. The old GCP `ensureCustomRole` helper/test likewise belonged to automatic
legacy setup; new runtime authority belongs to the reviewed installer. Existing
explicit legacy GCP bootstrap is retained without this additional role creation.

Installer/CLI integration and provider credential validation already present in
the frozen base were preserved. Newer Zod 4 contracts, exact secret redaction,
Connect Cloud onboarding, and native installation/recovery protections take
precedence over obsolete versions in the archive. Storage grants, queues and
managed recovery are covered by the complementary [storage evidence](storage-runtime-access-evidence.md).

## Retained lifecycle safeguards

The reconciliation also preserves the local scope-change and stage-isolation
regressions. The independent contract is the architecture requirement that
accepted runtime identities and recovery state cannot be silently rebound, and
that each saved stage authorizes only its own actions and dependencies.

Seven hosting-transition cases failed before restoring reserved runtime binding
keys and the guard covering provider, project, environment and recreated scopes.
The queue prerequisite test failed when a later CI credential update became a
prerequisite of an isolated runtime-access stage. The composed planner persists
through SQLite and now preserves the queue-only stage without secret inputs.
The focused planner, hosting transition and runtime lifecycle group passed all
113 checks. These tests establish local authority and recovery behavior, not live
provider compatibility. The preserved S3 test also covers sessions whose provider
omits expiration metadata: local credentials still cannot become runtime keys.

Runtime permission observations also participate in saved-plan drift detection
when no filesystem volume exists. Six cases (changed principal, grant or invalid
state with absent/empty volumes) previously allowed a stale plan to execute.
The corrected fingerprint rejects all six at the executor boundary; all 57
executor checks pass. This restores the preserved behavior while retaining newer
cloud and secret-destination authority stages.

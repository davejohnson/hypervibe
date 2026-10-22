# Project credential rotation: provider evidence

Reviewed **2026-10-21**. This is a contract review with a narrowly implemented
Supabase database password path, not a claim
that Hypervibe can rotate every credential, and not evidence of a live rotation.
No provider writes or live credential tests were performed for this review.
Except where implementation is explicitly identified, native features below are
candidates for future adapters; documentation does not establish implemented,
authorized or live-verified automation.

## Scope and existing implementation

A project-wide inventory must distinguish application-generated secrets,
externally issued API keys, database/cache users, storage access credentials,
webhook/signing keys, CI copies, Hypervibe connections, and credentials used to
read a secret manager. One credential can have several consumers and can be shared
across projects. Its issuer and native identity determine the rotation operation;
an environment-variable name does not.

The named roster comes from [application provider registration](../src/application/providers.ts),
[CI registration](../src/application/devops-providers.ts) and the
[lifecycle matrix](../test/provider-conformance/provider-matrix.ts). Registration
does not imply that credential rotation is implemented.

Current boundaries:

- [Generated application secrets](../ARCHITECTURE.md#runtime-secrets)
  use an explicit generation and confirmation for replacement. An immutable
  encryption-key slot requires a separate rewrap/migration workflow; changing
  its value can make stored data unreadable. Generation is not an application
  contract for overlapping session/JWT keys or invalidating old sessions.
- [Scoped delegated-secret updates](scoped-secret-updates.md) install explicitly
  supplied replacement values in one existing managed-CI environment. Only
  Railway currently admits the no-rollout operation, at ready-for-live status.
  Installation neither issues nor revokes the external credential. Deployment
  and successful application use are separate evidence.
- The shared [hosting](../src/domain/ports/provider.port.ts),
  [database](../src/domain/ports/database.port.ts) and
  [storage](../src/domain/ports/storage.port.ts) ports have no project credential
  rotation transaction. Initial credential creation, runtime wiring and database
  restore helpers do not provide that transaction.
- The [database password capability](../src/domain/ports/database-password-rotation.port.ts)
  now supports one exact issuer replacement plus fresh direct/pooler authentication
  evidence through `hv_plan scope="database-rotation"`. Supabase implements this
  narrow path under maintenance; separate dependent actions install the runtime
  configuration. It does not close the project-wide campaign or prove application
  use and existing-session revocation. See the [eight-provider matrix](database-password-rotation.md).
- [Secret-manager adapters](../src/domain/ports/secretmanager.port.ts) expose
  connect, verify, get and list. They do not expose source-secret writes,
  credential issuance, renewal or revocation.

Every row below therefore has **no implemented end-to-end Hypervibe rotation**
unless a narrower operation is expressly identified. “Unknown” means this
review did not establish that native contract; it must remain blocked rather
than inferred from a related API or a passing mock.

## Hosting, cloud identities and control-plane connections

| Registered providers / credential | Native issuance, overlap and invalidation | Constraints and recovery boundary |
| --- | --- | --- |
| railway: account, workspace or project token | Dashboard issuance; project tokens bind one project environment, workspace and account tokens have broader scopes. Native automated replacement/revoke and overlap receipts were not established here. [Railway authentication](https://docs.railway.com/integrations/api) | Preserve token type, native scope and authentication header. Updating RAILWAY_API_TOKEN in CI does not revoke the prior token or prove that all consumers changed. OAuth refresh/client-secret operations are different credential families. |
| cloudrun, cloudsql, memorystore, gcs: Google service-account key | Create another key, replace consumers, disable old key, monitor, then delete. Private material is returned on creation; key creation may be blocked by organization policy. [Rotation](https://docs.cloud.google.com/iam/docs/key-rotation), [creation](https://docs.cloud.google.com/iam/docs/keys-create-delete) | Requires IAM authority for the exact service account. Disable and deletion are separate recovery boundaries. Workload identity/ADC access-token refresh is not persistent-key rotation; existing token/session invalidation needs separate evidence. No key-management rotation adapter. |
| ecs, rds, elasticache, s3; aws-secrets source: AWS IAM access key | At most two keys per IAM user; create a second while first remains active, change consumers, deactivate old, verify, then delete. Secret available only on creation. [Keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html), [rotation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id-credentials-access-keys-update.html) | Need an available key slot and authorized IAM principal. A lost creation response cannot be recovered by reading the secret again. IAM roles/STS are a separate temporary-credential contract; revoking a long-term key is not evidence that every derived session ended. |
| azure-container-apps, azure-postgres, azure-managed-redis, azureblob: Entra application/service-principal client secret | Graph can add a password credential and remove a specific keyId; addition permits migration before removal. Secret text cannot be retrieved later. [Application add](https://learn.microsoft.com/en-us/graph/api/application-addpassword), [remove](https://learn.microsoft.com/en-us/graph/api/application-removepassword), [service-principal add](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-addpassword) | Exact tenant, application versus service-principal object, keyId and Graph permissions matter. Azure resource-management access does not establish Graph credential-management authority. Token invalidation/propagation after removal remains unverified here. |
| fly: deploy/org access token | Native app/org-scoped token creation, listing and exact-token revocation are documented. [Fly tokens](https://docs.fly.io/security/tokens) | Scope, token type, expiry and delegation differ. API serialization, overlap and ambiguous issuance/revocation recovery are not covered by a Hypervibe rotation adapter. |
| vercel: access token | Native token management and an exact-token deletion endpoint exist. [Authentication](https://vercel.com/docs/rest-api), [delete](https://vercel.com/docs/rest-api/authentication/delete-an-authentication-token) | Issuance authority, overlap and lost-response recovery are unverified in this review. Preserve team/account scope; do not substitute an integration/OAuth token contract. |
| digitalocean: API token | Native credential rotation protocol is **unreviewed** here. OAuth revocation is documented but does not prove personal-access-token rotation semantics. [OAuth API](https://docs.digitalocean.com/reference/api/oauth/) | Treat PAT issuance, expiry, overlap and revocation as unknown until their specific contract is reviewed. Existing app deployment and database clients do not implement rotation. |

The hosting secret-write contract remains the separately reviewed
[seven-provider matrix](scoped-secret-updates.md#provider-review): Railway,
Cloud Run, ECS Express, Azure Container Apps, Fly, DigitalOcean and Vercel.
Do not infer no-rollout support from a general deployment capability. Cloud Run
environment changes create revisions; native staged secrets on another provider
do not establish observation or retry support in its current adapter.

## Databases and caches

Changing an application's connection URL does not change a database role.
Likewise, changing a container initialization password variable does not prove
that an existing database changed its authentication state. The generic
PostgreSQL contract supports changing a role password, but does not by itself
establish provider operation completion, connection-pool behavior, a second
valid password or revocation of established sessions. [PostgreSQL ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html)

| Registered database provider | Native operation reviewed | Overlap, outage and recovery limits |
| --- | --- | --- |
| railway PostgreSQL | Database-view Regenerate synchronizes PostgreSQL authentication and provider password variables. [Database view](https://docs.railway.com/databases/database-view) | Hypervibe's pinned official CLI SDL has no documented password-regeneration mutation. The adapter remains unsupported; variable edits and independent ALTER USER are not a replacement for synchronized native rotation. |
| cloudsql PostgreSQL | Cloud SQL user create/update/delete APIs identify project, instance and user. [Users](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/users) | Password update and a completed provider operation need fresh authentication evidence. The shared API schema contains dual-password fields; this review did not establish dual-password behavior for PostgreSQL. Do not import the MySQL recipe. |
| rds PostgreSQL | AWS Secrets Manager documents single-user and alternating-user strategies. Alternating users need another privileged credential and matching grants. [Rotation strategies](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotation-strategy.html) | Alternating users change principal identity; they are not two passwords on the existing role. Lambda/network/secret prerequisites and grants are additional desired resources, not hidden helper work. No such rotation workflow is implemented here. |
| supabase PostgreSQL | Native PATCH database/password, with project and direct/pooler endpoint reads. [Management API](https://supabase.com/docs/reference/api/v1-update-database-password), [authentication after rotation](https://supabase.com/docs/guides/troubleshooting/fatal-password-authentication-failed) | Implemented through isolated database-rotation spec/plan/apply with encrypted recovery and exact consumer installation during maintenance. Fresh new/old authentication must agree at every bound endpoint; unknown outcomes never trigger an automatic reset retry. Database password, PAT, API keys and JWT keys are distinct. No live validation, same-role overlap, application-use or established-session proof is claimed. |
| neon PostgreSQL | Console/API reset is branch-scoped; old password stops working on the next connection. SQL can set an explicit value. [Roles and password reset](https://neon.com/docs/manage/roles) | Each affected branch and consumer must be accounted for. Reset has no demonstrated same-role overlap. Role deletion has ownership constraints; do not delete data or owning roles as credential cleanup. |
| azure-postgres | Flexible Server administrator password update is documented. [Manage server](https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/how-to-manage-server-cli) | Administrator reset is distinct from least-privilege application-role rotation. Same-role overlap, propagation, pool/session revocation and ambiguous-write recovery were not established here. |
| digitalocean PostgreSQL | Native create/delete users and reset password; new users need appropriate grants. Reset can break dependent services. [Database users](https://docs.digitalocean.com/products/databases/postgresql/how-to/manage-users-and-databases/) | Exact cluster/user identity required. Separate-user overlap needs reviewed grants and ownership, not a copied username. No rotation adapter or live proof. |
| fly PostgreSQL | Current database rotation protocol **unreviewed**. | Establish whether the bound resource is managed or self-hosted PostgreSQL before selecting a native operation. A Fly hosting token or Machine secret write is not database-role rotation. |
| database (external connection adapter) | Connects to an already supplied database; PostgreSQL role changes are engine operations. | The connection does not establish ownership or authority to rotate a provider-managed role. Provider/engine and consumer inventory can remain unknown. |

| Registered cache provider | Native operation reviewed | Overlap, outage and recovery limits |
| --- | --- | --- |
| elasticache | Hypervibe uses serverless Valkey with RBAC. ElastiCache users allow up to two passwords; modifications preserve existing connections. [RBAC](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Clusters.RBAC.html), [CreateUser](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_CreateUser.html) | Can model candidate plus prior password only after reviewing ModifyUser and completion. The separate AUTH ROTATE/SET recipe is for node-based clusters, not serverless. Old-password rejection on a new connection does not terminate existing connections. [AUTH limits](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth.html) |
| memorystore (Redis) | AUTH string rotation requires disabling then re-enabling AUTH. Established authenticated connections can remain valid for their lifetime. [Redis AUTH](https://docs.cloud.google.com/memorystore/docs/redis/about-redis-auth) | No generic two-password cutover. Disabling authentication has a security consequence and requires explicit review. Do not substitute a Memorystore Cluster IAM contract for this Redis resource. |
| azure-managed-redis | Native primary/secondary access keys permit moving clients before regenerating the old slot. [Managed Redis operational guidance](https://learn.microsoft.com/en-us/azure/well-architected/service-guides/azure-managed-redis) | Review exact Managed Redis ARM identity/API, key slot, completion and existing connections before implementation. This is not evidence for the older Azure Cache for Redis resource. |
| railway Redis | **Unreviewed** server-authentication change/recovery contract. | Changing REDIS_PASSWORD or a consumer URL alone is insufficient evidence. Need exact deployed engine/configuration, persistence, restart and old/new authentication semantics. |
| digitalocean Valkey | **Unreviewed** cache-password rotation contract. | PostgreSQL user-management/reset documentation is not evidence for Valkey. Do not infer it from the shared database API shape. |

Queues registered through cloudrun (Pub/Sub) and railway (PostgreSQL-backed)
inherit the applicable runtime identity/database authentication concern; this
roster does not contain an independently implemented SQS credential lifecycle.

## Object storage

| Registered provider | Native contract / current credential mode | Rotation boundary |
| --- | --- | --- |
| railway | Bucket credential reset invalidates the existing credentials and generates replacements. [Bucket credentials](https://docs.railway.com/cli/bucket) | No overlap established. Exact bucket/project/environment correlation, private capture, reconnect and ambiguous-reset recovery need implementation. Reading CLI docs does not authorize bypassing spec/plan/apply with the provider CLI. |
| s3 | IAM credentials follow the AWS row above; S3 buckets do not have an independent generic password. Current storage code resolves explicit/default-chain credentials and rejects copying expiring sessions into runtime. [Adapter](../src/adapters/providers/aws/s3.adapter.ts) | Inventory the actual role/user and all consumers. Workload identity is a separate capability whose exact host/storage wiring must be established; do not rotate a shared control-plane key as if it were bucket-scoped. |
| gcs | Current adapter uses the exact Cloud Run workload identity where available; cross-cloud access can use an explicitly selected service-account JSON. [Adapter](../src/adapters/providers/gcp/gcs.adapter.ts) | JSON-key rotation follows the Google row. The adapter does not implement a separate HMAC-key rotation protocol. Workload identity is not a durable secret to replace in an env var. |
| azureblob | Azure storage accounts expose two keys. Rotate the unused slot, move consumers, then regenerate the former slot. Regeneration also invalidates account/service SAS tokens signed by that key; user-delegation SAS is different. [Account keys](https://learn.microsoft.com/en-us/azure/storage/common/storage-account-keys-manage) | Current adapter reads an account key; it does not implement key-slot migration. Account keys can affect multiple containers and signed URLs. Account scope, selected slot and all dependent SAS consumers must be known before revocation. |

## CI and external integrations

| Registered provider / credential | Native contract reviewed | Hypervibe gap / recovery constraint |
| --- | --- | --- |
| github / github-actions | PAT creation and deletion are user-controlled; permissions remain constrained by owner/repository access. Actions environment secrets can be replaced using their exact environment and encrypted input. [PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [Actions secret API](https://docs.github.com/en/rest/actions/secrets) | Replacing a CI copy does not mint/revoke its issuer credential, restart an existing run or prove runtime use. Secret metadata does not disclose value. GitHub App/OIDC and PAT rotation need different contracts; package-read tokens and signing credentials are separate inventory entries. |
| gitlab / gitlab-ci | PAT rotate revokes the predecessor and issues a replacement. Retrying rotation on an already revoked token can revoke active tokens in that token family. [PAT API](https://docs.gitlab.com/api/personal_access_tokens/) | Persist one-time response encrypted before continuing; an uncertain response must block automatic repeat. Personal/project/group/deploy tokens and runner credentials are distinct; this review establishes only the cited PAT behavior. CI variable replacement does not establish issuer rotation. |
| cloudflare | Rolling a token replaces its secret and invalidates the prior value while preserving permissions. Creating a new token is a separate option. [Roll tokens](https://developers.cloudflare.com/fundamentals/api/how-to/roll-token/) | Roll must be treated as invalidation during issuance, not a guaranteed overlap operation. Account/user token type, permission-management authority and exact-token recovery remain adapter gaps. |
| sendgrid | API key API supports creation and deletion with appropriate key-management authority. [API keys](https://www.twilio.com/docs/sendgrid/api-reference/api-keys) | Provision a separate scoped candidate only with issuer authority; Mail Send permission alone is not key-management authority. Existing adapter setup/delegated secret writes do not provide issuer rotation. New-key mail authorization and old-key rejection need separate checks. |
| twilio | Native key creation exposes a secret once; deletion addresses the key SID. Deletion invalidates REST authentication and Access Tokens signed by that key. [Regional credentials](https://www.twilio.com/docs/global-infrastructure/manage-regional-api-credentials), [Key API](https://www.twilio.com/docs/iam/api-keys/key-resource-v1) | Account, region and key type are part of identity. Inbound webhook validation uses the Account Auth Token, which is separate from a REST API key. [REST/security guidance](https://www.twilio.com/docs/usage/rest-api-best-practices) |
| stripe | Dashboard rotation supports immediate expiry or a grace period up to seven days. [API keys](https://docs.stripe.com/keys) | Automated issuance/revocation is not established by that Dashboard procedure. Exact account/live/sandbox scope and webhook signing secrets need separate inventory. Updating a delegated key cannot prove retirement of the old one. |
| appstoreconnect | Private API keys download once; revocation is irreversible. Individual users can have one active individual key. [API keys](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/), [revocation](https://developer.apple.com/documentation/appstoreconnectapi/revoking-api-keys) | Team/individual keys have different overlap possibilities and permissions. Distribution certificates, provisioning profiles, Match password and Match repository credentials are separate. No automatic signing/credential rotation implementation. |
| openai | Admin API can create a service-account API key and organization admin keys. Project-key deletion documents an error for service-account-owned keys. [Service-account key creation](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/projects/subresources/service_accounts/subresources/api_keys/methods/create), [project-key deletion](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/projects/subresources/api_keys/methods/delete), [admin key creation](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/admin_api_keys/methods/create) | Do not compose these into an assumed complete service-account rotation recipe; that revocation contract remains unresolved. Current adapter accepts an API key and checks model visibility, not admin authority or Responses write permission. Native admin features are not implemented rotation capabilities. |
| supabase integration keys | JWT signing-key standby/current/revoked states support separate rotation and revocation. Modern publishable/secret API keys are independent; legacy JWT-style anon/service-role keys require special handling. [Signing keys](https://supabase.com/docs/guides/auth/signing-keys) | Do not confuse signing-key rotation with database-password or management-PAT rotation. Existing applications' verification caches/session behavior and legacy compatibility need their own review. |
| neon, supabase management API tokens | Distinct from their PostgreSQL role credentials. [Neon organization keys](https://neon.com/docs/manage/orgs-api), [Supabase PATs](https://supabase.com/docs/guides/platform/personal-access-tokens) | Exact rotation, overlap and ambiguous-response recovery are not established in this review; mark them operator-required/unknown rather than applying the database password recipe. |

## Secret sources and local recovery material

| Registered secret source | Reviewed distinction | Current automation boundary |
| --- | --- | --- |
| vault | Dynamic leases have renewal/revocation semantics; revoking the issuing token can revoke its leases. KV values do not have that contract. Revocation can fail if the backing system is unreachable. [Leases](https://developer.hashicorp.com/vault/docs/concepts/lease), [irrevocable leases](https://developer.hashicorp.com/vault/tutorials/monitoring/troubleshoot-irrevocable-leases) | Current get/list port does not manage leases or source credentials. Never treat a read as authority for new dynamic issuance; exact mount, lease and auth method require review. |
| aws-secrets | Secrets Manager can coordinate database rotation using documented single/alternating-user strategies. [Rotation strategies](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotation-strategy.html) | Reading a secret is not enabling/operating its rotation workflow. Source IAM access follows the AWS row; source-secret versions and issuer credential state are separate. |
| bitwarden | Machine-account tokens are shown only on creation. Revocation prevents new authentication, but an authenticated session may retain access for up to one hour. [Access tokens](https://bitwarden.com/help/access-tokens/) | Current source is read-only; no token issuance/revocation adapter. Do not report immediate complete containment from a revoke acknowledgment. |
| 1password | Service-account token is the configured source credential. Native issuance/overlap/revocation contract **unreviewed** here. | Read-only adapter; externally supplied replacement and separate provider evidence required. |
| doppler | Service token plus project/config select the source. Native issuance/overlap/revocation contract **unreviewed** here. | Read-only adapter; changing a source value is not automatically rotating the service that issued it. |
| stripe-projects | Local authenticated Stripe CLI/cache is the source. | Adapter intentionally does not pull, refresh, provision or rotate. Cache freshness, source session and upstream key rotation remain separate operator steps. |

Hypervibe's local SecretStore encryption/root material is another credential
class. Replacing that root is not rotating project app keys and must not strand
encrypted plans, saved connections or derived immutable keys. Recovery material
requires a separate rewrap/backup contract; this document proposes no root-key
mutation.

## Minimum shared contract before adding a rotation adapter

The initial useful surface is a **value-free inventory and readiness report**.
It can classify known slots, declared consumers and missing evidence without
reading every secret or claiming to discover every external copy. A registry
entry lacking a reviewed capability must yield unsupported/unknown.

Any subsequent mutation contract needs these distinctions:

1. **Identity and authority:** issuer, credential kind, native credential id and
   resource scope; ownership; exact consumer destinations; affected projects;
   approved operation and independent administration/recovery access. Shared
   account access does not authorize changing other projects.
2. **Native strategy:** additional credential with overlap, replacement that
   invalidates immediately, primary/secondary slots, alternating principals,
   lease renewal, or externally supplied candidate. Record expiry, grant
   prerequisites, restart/downtime requirements and session invalidation limits.
3. **Separate lifecycle evidence:** candidate issued and privately captured;
   consumer copies installed; exact rollout completed; new authentication
   verified from required consumers; old credential disabled/revoked; eventual
   deletion/expiry and any sessions separately verified. A write acknowledgment
   or healthy public homepage cannot substitute for the other stages.
4. **Uncertain writes and recovery:** journal intent before issuance, preserve
   exact returned identities and one-time material encrypted, use native
   operation/idempotency evidence when available, and block on uncertain
   non-repeatable writes. A lost reset or GitLab rotation response cannot be
   retried by inventing another candidate. Cleanup needs proven ownership.
5. **Application semantics:** changing signing/session/encryption secrets may
   invalidate sessions or require dual verification/rewrapping. Model these as
   explicit prerequisites. Successful infrastructure auth tests do not prove
   application encryption compatibility or all external consumers discovered.

Keep this in spec/plan/apply with action-scoped confirmation, shared adapter
capabilities and secret-safe receipts. Do not create a one-off Railway rotation
command, mutate from diagnostics, or infer that a connection's scope grants
permission to revoke the credential currently authorizing the operation.
Revocation after suspected compromise may intentionally precede migration; the
plan must state the resulting interruption and require the relevant authority.

## Evidence and required regression cases

**Assumption challenged:** replacing runtime variables completes credential
rotation, and all providers permit candidate/previous overlap.

**Independent evidence:** the primary sources above distinguish issuance,
consumer configuration and invalidation. Concrete counterexamples include
Railway bucket reset, GitLab PAT rotation/reuse detection, Memorystore AUTH,
Azure key-signed SAS and Bitwarden's surviving authenticated sessions.

**Current validation:** the project-wide inventory and interface boundaries have
offline tests. The scoped Supabase implementation has pinned official HTTP
contract tests and fresh authentication regressions against isolated PostgreSQL
over TLS, including surviving old sessions and uncertain issuer responses.
Counterexamples were observed failing before changes and passing afterward.
Other proposed issuer adapters remain documentation review only. No live
lifecycle result is claimed. Further adapters must follow the same
[provider contract guidance](../test/provider-contracts/README.md).

Required cases belong in normal CI: registry roster coverage; no-op and read-only
mutation freedom; two environments sharing logical names; shared credential
consumers outside the selected project; permissions denied/unknown observation;
one-time issuance response lost; persistence failure after issuance; partial
consumer updates; unsupported overlap; stale/incorrect native identity;
revocation rejected or uncertain; existing sessions surviving revocation;
new-credential auth passing while rollout fails; exact recovery after retry;
and absence of secrets in plans, output, errors and snapshots. Adapter contract
tests establish the tested protocol boundary, not live permissions, service
propagation timing, application behavior or successful incident containment.

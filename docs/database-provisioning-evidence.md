# Database provisioning and persistence review

Reviewed 2026-10-24 against all eight registered database providers, including
the database adapters supplied by hosting providers. The machine-readable
[provider matrix](../test/provider-contracts/database-provisioning-provider-matrix.json)
records each native create API, storage model, identity, completion boundary,
recovery behavior, prerequisites and coverage gap. Official documentation was
read during this review; tests never download it.

## Shared contract and challenged assumption

A provisioned database must have a durable provider identity and storage that
survives replacement of its compute process. For a service-backed database,
the PostgreSQL data directory must be inside the exact service instance's
attached persistent volume. For a native managed database, the native database
resource owns storage. A successful create response, healthy process, familiar
service name, image name or dashboard icon is insufficient proof.

The counterexample is PostgreSQL running successfully from a container image
whose data directory is outside its persistent mount (or which has no mount).
It can accept writes and later initialize an empty database after a deployment.
Another counterexample is a managed database create that is rejected: falling
back to an ordinary hosting container would violate the declared database intent.

Provisioning must fail honestly when the provider cannot establish the required
identity/storage contract. Observation must preserve unknown evidence instead of
treating it as absence. Existing databases require preservation-safe inspection;
attaching a fresh empty volume or recreating a same-named database is not a
preservation-safe implicit repair. Explicit discard-data initialization is a
separate, narrowly scoped lifecycle operation described below.
Desired backup policy, available recovery points and a successful restore remain
three separate claims. No project incident cause is established by this review.

## Named provider findings

| Provider | Native storage and implemented creation path | Independent evidence and limits |
| --- | --- | --- |
| Railway | Reviewed creation uses the official PostgreSQL database template through `templateDeployV2`, then verifies its service and attached volume. Persistence depends on the actual data directory and mount, not its icon. | Railway documents [service construction](https://docs.railway.com/databases/build-a-database-service) and [persistent volumes](https://docs.railway.com/volumes). The [official image contract](https://github.com/docker-library/docs/blob/master/postgres/README.md) distinguishes version-specific data-directory defaults. Template or volume acknowledgement alone cannot verify the resulting attachment. |
| Supabase | Native hosted project with its own PostgreSQL instance and provider-managed disk; `POST /v1/projects`. | [Compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk) and the [project API](https://supabase.com/docs/reference/api/v1-create-a-project). Project readiness does not prove backup entitlement or a tested restore. |
| Neon | Native project/branch with durable storage separated from ephemeral compute; `POST /api/v2/projects`. | [Architecture](https://neon.com/docs/introduction/architecture-overview) and [create API](https://api-docs.neon.tech/reference/createproject). Endpoint suspension does not mean loss of branch data; project/branch deletion remains destructive. |
| Cloud SQL | Native Cloud SQL instance, using provider-default database disk configuration; SQL Admin `instances.insert`. | [Instance API](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances/insert) and [storage settings](https://docs.cloud.google.com/sql/docs/postgres/instance-settings). No Cloud Run database-image fallback exists in this path. Default capacity and live recovery remain unverified here. |
| RDS | Native RDS instance with explicit encrypted 20 GiB `gp3` storage. | [CreateDBInstance](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_CreateDBInstance.html) and [EBS-backed database storage](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html). Existing tests exercise SDK command inputs and lifecycle behavior; this review does not upgrade that evidence to create wire-schema or live certification. |
| Azure PostgreSQL | Native Flexible Server with explicit 32 GiB managed disk and auto-grow. | [Create API](https://learn.microsoft.com/en-us/rest/api/postgresql/servers/create-or-update?view=rest-postgresql-2025-08-01) and [managed storage](https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-storage). Subscription/resource-group ownership and runtime access are prerequisites, separate from durability. |
| Fly | Native Managed Postgres cluster with explicit 10 GiB storage, through `/v1/postgres`; not an unmanaged app Machine. | [Official API announcement](https://fly.io/changelog/managed-postgres-machines-api/) identifies asynchronous MPG v2 operations; [product documentation](https://fly.io/docs/about/pricing/) distinguishes MPG storage and its lifetime from app deletion. MPG v1 is outside this API; live compatibility is unverified. |
| DigitalOcean | Native managed PostgreSQL cluster with storage provided by its selected database size; `POST /v2/databases`, engine `pg`. | [Cluster creation](https://docs.digitalocean.com/products/databases/postgresql/how-to/create/) and [API contract](https://docs.digitalocean.com/products/databases/postgresql/reference/api/). This path does not create an App Platform development database. Online state is distinct from retained backups and restore proof. |

The bounded review found no second image-without-volume provisioning path among
the other seven providers. That is a source-and-contract finding, not proof that
every deployed database is durable, correctly wired, backed up or recoverable.
This work does not alter application repositories or adopt/repair existing cloud
resources.

Legacy runtime-reference metadata uses the existing isolated `database-bindings`
stage. The optional provider-neutral database capability observes the exact
bound resource and returns only its direct-URL variable name plus a fingerprint
of identity and key presence. Railway implements this capability using its
[variable API](https://docs.railway.com/integrations/api/manage-variables) and the
recorded official PostgreSQL template. Supabase, Neon, Cloud SQL, RDS, Azure
PostgreSQL, Fly and DigitalOcean explicitly do not implement this service-variable
metadata capability; their native URL projection is unchanged. The provider
matrix and ordinary CI require that distinction for every registered database.

The local repair requires independently observed native backup-source identity,
an exact reviewed action, unchanged binding metadata, and fresh matching variable
evidence. It merges only an absent `directUrlVariable` name, never overwrites an
explicit selection, and preserves the legacy private reference when it exists.
Valid partial legacy scope is completed only when the independently observed
native source agrees with every recorded key; malformed or conflicting scope is
preserved and blocked. The reviewed partial scope is checked again at apply.
The exact service's observed name must match the committed reference namespace;
a renamed database or stale reference name is blocked without automatic renaming.
An unknown read or unusable selected key blocks dependent work. It does not
change variables, credentials, volumes, workloads, or database contents, and its
fingerprint never includes credential values or credential-derived hashes.

Railway's official CLI at immutable revision
`f60f3a77b980c47f1136909fbd9a443e29a2b95f` distinguishes
[database addition](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/commands/add.rs)
from Docker-image services. Its
[template deploy implementation](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/commands/deploy.rs)
passes the fetched serialized configuration through to `templateDeployV2`,
preserving native fields and generators, and waits for workflow completion.
The checked-in [source excerpts](../test/provider-contracts/railway/database-template-source.json)
and [recorded public template response](../test/provider-contracts/railway/postgres-template.recorded.json)
provide independent evidence beyond the opaque GraphQL JSON scalar. The
recorded PostgreSQL 18 template explicitly puts `PGDATA` at
`/var/lib/postgresql/data/pgdata` and mounts `/var/lib/postgresql/data`, so its
explicit configuration outranks the upstream image's default. Template metadata
was read publicly without authentication; no database was created by recording
this evidence. Nullable template provenance fields are not storage proof.

## Explicit fresh initialization of an existing database

Design reviewed 2026-10-26 before adapter implementation. Railway now
**implements** this capability with offline contract coverage; the other seven database providers are explicitly
**unsupported**. The matrix records implementation admission separately from
official contract evidence and does not certify live support.

The challenged assumption is that a missing persistent volume can be repaired
without changing the meaning of the existing data. A running PostgreSQL service
may contain valuable data only in its container filesystem. Mounting an empty
volume and starting PostgreSQL there creates a different, empty database; it
does not preserve those writes. This operation therefore requires explicit
`database.freshInitialization = { id, discardExistingData: true, target: {
externalId, providerScope } }` intent for the exact bound database, an isolated
`database-initialization` plan, and confirmation of its data-bearing action.
Ordinary persistence drift never authorizes it. A request to initialize this
database does not authorize resetting any other environment or managed database.

The optional provider-neutral `adapter.freshInitialization` capability must
preserve the provider-native database identity, keep provider mechanics private,
and report uncertainty and durable resume evidence explicitly. Private variable
configuration stays encrypted. A completed one-use intent must not initialize
the database again on later plans. Existing or pending volumes, unsupported
images/startup overrides, ambiguous identity, unknown reads and changed reviewed
configuration block the action. No current database contents are exported by
this discard-data operation; it does not disable future backup intent or claim
that an unavailable checkpoint succeeded.

| Provider | Native boundary and admission for this operation |
| --- | --- |
| Railway | Implemented for the exact existing PostgreSQL 16 service using the supported stock startup, with complete project/environment scope and independently proven absence of a volume. [Volume creation](https://github.com/railwayapp/docs/blob/4bc46bc0ba1b27d50c5ef0393132753982b31112/content/docs/integrations/api/manage-volumes.md) attaches a new persistent volume to a service; it does not recover old filesystem data. Offline contracts do not establish live initialization success. |
| Supabase | Unsupported. Each project owns its [dedicated PostgreSQL instance and disk](https://supabase.com/docs/guides/platform/compute-and-disk); [project backups and restores](https://supabase.com/docs/guides/platform/backups) are separate operations. |
| Neon | Unsupported. [Durable storage is separate from compute](https://neon.com/docs/introduction/architecture-overview); [branch reset and restore](https://neon.com/docs/manage/branches) change branch data/history, not a service volume. |
| Cloud SQL | Unsupported. [Restore can overwrite the target instance and restart it](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/restore); the [restore API returns an Operation](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances/restoreBackup). That is a distinct restore lifecycle. |
| RDS | Unsupported. [Snapshot restore creates a new DB instance](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_RestoreDBInstanceFromDBSnapshot.html), with its own identity; it is not initialization of an unattached hosting volume. |
| Azure PostgreSQL | Unsupported. [Flexible Server restore creates a new server without overwriting the original](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore). Managed storage cannot be treated as a missing workload mount. |
| Fly | Unsupported. The registered adapter uses Managed Postgres; [MPG restore creates a new cluster](https://fly.io/docs/flyctl/mpg/). Unmanaged Fly Machines and volumes are outside this database operation. |
| DigitalOcean | Unsupported. [Creating from a backup creates a new managed cluster, moving from `creating` to `online`](https://docs.digitalocean.com/reference/api/reference/databases/). It is not an empty-volume attachment to an existing service. |

Railway's pinned official documentation distinguishes the required steps.
[Variable updates](https://github.com/railwayapp/docs/blob/4bc46bc0ba1b27d50c5ef0393132753982b31112/content/docs/integrations/api/manage-variables.md)
can be additive and deferred with `skipDeploys: true`; replacing the complete map
would delete omitted keys. The adapter stages the reviewed child-directory
`PGDATA` before creating the volume, preserving the issuer credentials and raw
references. It always supplies the exact project, service and environment on
`volumeCreate`, even though the native environment field is optional.
[Volumes are mounted at startup, not during builds or pre-deploy commands](https://docs.railway.com/volumes).
Whether creating a volume automatically starts a deployment is unspecified by
the reviewed contract and must not be assumed in either direction.

The pinned [PostgreSQL 16 image](https://github.com/docker-library/postgres/blob/dfc76bb299b057785026eb2eea39556b6fe52983/16/bookworm/Dockerfile)
defaults `PGDATA` to the mount root, while
[PostgreSQL's initializer](https://github.com/postgres/postgres/blob/61aec3f3bc91c42cd08d1947794ddcc258020869/src/bin/initdb/initdb.c#L2987-L2998)
recommends a child directory when mount contents such as `lost+found` are present.
The pinned entrypoint initializes a directory without `PG_VERSION`; custom
initialization arguments, WAL paths or password-file inputs can change that
behavior and remain outside the narrow admission. The complete reviewed Railway
docs, Docker source and explicit initializer excerpt are stored with
[source hashes and immutable provenance](../test/provider-contracts/railway/database-initialization/source.json).
An explicit nonempty initializer password is required. The documented empty or
missing username/database defaults are resolved privately, and any existing
credential aliases and URLs must agree with those effective initializer values.
Raw credentials, references and other variable definitions remain unchanged.

[Service deployment](https://github.com/railwayapp/docs/blob/4bc46bc0ba1b27d50c5ef0393132753982b31112/content/docs/integrations/api/manage-services.md)
returns a deployment ID. The action must retain the acknowledged volume ID,
verify and retain its exact environment-specific volume instance ID, retain the deployment ID from
`serviceInstanceDeployV2`, and correlate the terminal
[deployment status](https://github.com/railwayapp/docs/blob/4bc46bc0ba1b27d50c5ef0393132753982b31112/content/docs/integrations/api/manage-deployments.md)
with the same instance before claiming configuration completion. Neither native
mutation has an idempotency key in the reviewed pinned schema. A lost response
must retain uncertainty instead of authorizing a second create/deploy or guessing
cleanup ownership. Once initialization may have started, automatic volume
deletion is not compensation.

### Provider activation replacing the acknowledged deployment

The assumption that the explicitly acknowledged deployment must remain current
was falsified by read-only observations on 2026-10-28: that deployment was removed
and stopped, while the sole active deployment referenced a committed environment
patch that only created and mounted the exact acknowledged volume. The complete
manifest and raw variable snapshots matched between deployments. This identifies
the verification blocker; it does not establish SQL readiness or the cause of
the earlier data loss. The provider does not document a request-to-patch lineage
guarantee, so timing and matching manifests alone remain insufficient.

The [reconstructed observation and official contract pins](../test/provider-contracts/railway/database-initialization/successor-source.json)
support a narrow read-only reconciliation. It requires the exact service,
environment, project, volume and volume instance; the stopped original deployment;
one successful current successor; and its exact committed patch containing only
the reviewed volume creation and mount. Both immutable variable snapshots must
match the frozen reviewed raw definitions plus the reviewed PGDATA. The source
image, default startup, replica topology, image digest, manifest and mount evidence
must agree, and mutable storage/configuration plus candidate identity are checked
again before completion. Raw references are compared without copying or rendering
them into persisted evidence. These checks do not prove process environment or
SQL authentication.

The shared completed receipt keeps `deploymentId` as the original acknowledgment
and adds optional strict version-one `activationReconciliation` evidence with the
verified deployment and provider operation IDs. Progress and receipt must agree.
Legacy receipts and their seed fingerprints remain unchanged. Bootstrap observes
the separately verified activation when present; seed generation includes the
same validated receipt. A retry issues no additional volume, variable, deployment
or cleanup mutation. Supabase, Neon, Cloud SQL, RDS, Azure PostgreSQL, Fly MPG and
DigitalOcean remain explicitly unsupported for fresh initialization: this receipt
extension does not admit any of their reset or restore APIs.

Regression checks first failed through the real Railway client and serialized
GraphQL transport, then through the completed-receipt and bootstrap boundaries.
They cover malformed/extra patch changes, reference and credential drift, different
snapshots, wrong scopes or mounts, multiple active deployments, replacement during
verification, and local receipt failures. These reconstructed offline fixtures
remain distinct from live provider compatibility and durable database recovery.

Exact mount/configuration readback and a successful provider deployment remain
separate from authenticated SQL, application migrations, seed completion, running
application health, and a restart durability experiment. Those checks and future
backup protection retain their existing explicit lifecycle stages. No live
initialization, discard, export, deployment or restore has been performed by this
design review.

Fresh storage also invalidates historical seed completion for the prior data
generation. The seed regression observed the same command hash incorrectly yield
a noop after fresh initialization. Seed planning and execution now compare the
validated initialization receipt's generation, recheck it before and after the
task, and record it only after success. Historical seed evidence is preserved;
this does not run a seed or migration during initialization or bypass ordinary
task, release or backup prerequisites.

The native-scope conformance review found a separate shared-schema defect:
reusing the recovery scope allowlist rejected Fly's `organizationSlug` and
DigitalOcean's `accountUuid` before their unsupported capability could be
reported. Both native-scope regression cases were observed failing against the
original schema; the other five passed. Fresh initialization now accepts safe
native scope coordinates, and lifecycle admission still requires every scope
key declared by the actual provider registry. This does not add initialization
support to either provider.

## Railway replica configuration

Railway's legacy `ServiceInstance.numReplicas` field is nullable. A null value
does not mean one replica. The shared Railway configuration check can establish
the configured total from a nonempty `multiRegionConfig` map only when every
region and replica count is valid and explicit. Fresh database initialization
requires exactly one; the retained-volume boundary permits at most one.
Missing, null, empty or malformed regional evidence cannot replace an unknown
legacy count. Neither path changes replica settings to make admission succeed.

The [pinned source excerpts](../test/provider-contracts/railway/replica-configuration-source.json)
cover the schema, environment configuration model and official CLI inspection.
The CLI reads a deployment's manifest, while code configuration can override
dashboard settings for that deployment. Configured replica evidence therefore
does not prove the number or health of running containers. The CLI's legacy
manifest fallback and permissive display counts are not null-to-one defaults
for Hypervibe authorization.

New initialization snapshots include normalized replica topology in their
reviewed fingerprints, so a region change cannot retain approval merely because
the total remains one. Previously persisted pending snapshots retain their
original legacy validation and fingerprint semantics; new regional evidence
does not retroactively widen their authorization. The shared contract and the
eight-provider admission matrix above are unchanged: this is a Railway parser
correction. These source contracts and reconstructed boundary tests do not
establish BillForge's observed regional map or live initialization compatibility.

## Executable enforcement and evidence limits

`database-provisioning-provider-contracts.test.ts` compares the named matrix with
the complete database registry, so an added provider cannot bypass this review.
Its native API checks call the real Supabase, Neon, Cloud SQL, Azure PostgreSQL,
Fly and DigitalOcean adapters through serialized HTTP. Reconstructed preflight
responses permit one native database create, which is rejected with HTTP 400.
The assertions require a failed receipt and no hosting-resource fallback or
follow-on mutation. Authentication is synthetic; no provider is contacted.
These checks supplement the pinned Supabase/Neon schemas and existing provider
lifecycle tests. They do not validate complete response schemas, successful
creation, disk contents, restarts, or recovery. RDS has existing SDK-command
coverage rather than a new create-transport case in this test.

Fresh-initialization conformance also compares the matrix to actual adapter
capability objects and requires executable rejection coverage for all seven
unsupported providers. Those tests use the real registry, desired-state parser,
SQLite repositories, `PlanService` and shared apply handler. Only adapter dispatch
is substituted to supply each concrete adapter without authentication. An
unsupported plan produces no actions; even a synthetic confirmed action and a
noop are rejected without provider reads, creates or deletes, and leave durable
database/environment bindings unchanged. These are local admission checks,
not successful native API evidence.

The regression suite is included by the ordinary `npm test` Vitest configuration.
The committed `hypervibe-acceptance.yml` workflow runs typecheck and `npm test`,
and the desired project spec declares `Hypervibe / acceptance` required.
Passing offline checks do not establish live branch-protection enforcement or
provider certification. Railway's persistence regression and its observed
before/after result belong in the accompanying implementation change; the
cross-provider audit tests are baseline conformance checks, not newly reproduced
bugs in those seven providers.

Fresh-initialization regressions first observed the missing adapter capability
and ordinary full planning where the explicit intent required an isolated
`database-initialization` plan. Provider tests use the real Railway client and
serialized GraphQL transport against pinned schema/source evidence, with
synthetic success, rejection and uncertainty responses. They cover exact scope,
storage/deployment identity, delayed visibility, preserved configuration and
uncertain-write recovery. The initial username/database default counterexamples
also failed before the implementation followed the pinned PostgreSQL entrypoint.
Shared lifecycle checks cover confirmation, outstanding-work vetoes, durable
progress and lost local acknowledgements. Neither these results nor a persisted
completion receipt proves SQL authentication, migrated/seeded application data,
restart durability or live provider compatibility.

## Railway regression record

Before runtime edits, `railway.database-template.api-contract.test.ts` observed
`serviceCreate`, `variableCollectionUpsert`, `volumeCreate` and redeploy where the
user requirement and official CLI require one `templateDeployV2`. The real-client
persistence regressions observed a verified database noop both without a volume
and with `PGDATA` outside its mount; removing the disk did not change the plan's
observation fingerprint. Issuer-reference transport regressions rejected the
official composed URL as `unsupported_reference` and omitted `DIRECT_URL`.
These are reproduced code defects, not a proven cause of Billforge's incident.

The corresponding regressions now require official template deployment,
unchanged reference/generator definitions, exact persistent configuration,
blocked missing/unknown evidence and stale-plan rejection on volume changes.
Template tests cover failed/pending/uncertain workflows, malformed acknowledgements,
extra resource rejection, two environments, provider-assigned names, and raw alias
readback. Shared lifecycle tests cover confirmation, durable bindings, incomplete
provisioning recovery and mutation-free noop. Existing data is not automatically
adopted, attached to a new disk, migrated, restarted or deleted.

The official CLI establishes complete-workflow plus before/after service inventory
correlation. Hypervibe additionally requires matching template provenance and the
original template service key, exact environment/image and a unique new identity.
The schema permits nullable template provenance; the semantic equality between
`templateServiceId` and the serialized slot key remains unverified against a live
deployment. Missing/mismatched provenance therefore blocks with retained recovery
state rather than guessing ownership. The pinned schema validates GraphQL types;
the public recorded template and official CLI source separately establish opaque
serialized-configuration expectations. No live creation, persistence experiment,
backup, restore or customer repair was performed by this change.

The Railway retained-resource regression also challenges the assumptions that
every PostgreSQL image ends in `/postgres` and every durable database uses the
default mount. The official `railwayapp-templates/postgres-ssl` image and a
recorded valid nondefault mount are counterexamples. The real-client pinned-SDL
tests in `railway.database-retained.api-contract.test.ts` observed both failures
before the shared image predicate and exact recorded-mount checks were applied.
The retained path now checks provider scope, image and live volume identity,
preserves ambiguous/unsafe evidence, and remains idempotent after confirmed
absence. These are offline lifecycle results; no live database was deleted.

Explicit Railway adoption has a separate reference round-trip regression in
`railway-database-import.contract.test.ts`. The recorded current template has
`DATABASE_URL` without `DATABASE_PRIVATE_URL`; before the fix, a successful
real-client/MCP import omitted the selection metadata and projected the missing
private alias as `DIRECT_URL`. The test observed that missing metadata before
runtime edits. Import now privately reads only the confirmed mapped instances,
requires nonempty selected keys, and stores their names without their values.
Existing `DIRECT_URL` or `DATABASE_PRIVATE_URL` keys take precedence; an empty
present alias blocks instead of choosing a different destination. The passing
transport regressions include two environments, unreadable/malformed variables,
no writes on incomplete evidence, and preservation after a failed force-import.
This establishes configured key presence and reference projection, not SQL
authentication, successful runtime resolution or a live import.

Three additional serialized import counterexamples initially adopted observed
service names containing reference delimiters or a newline. Import now invokes
the shared reference builder before local writes and rejects those names with
value-free diagnostics. These tests exercise reference construction from a
provider response; they do not claim Railway permits creating every synthetic
name used by the negative cases.

The import round-trip also reproduced a missing environment ID in the saved
PostgreSQL scope. Import now retains both project and environment IDs, and the
same real-client test verifies that subsequent credential inspection accepts
each imported binding in its own environment.

Legacy bindings with complete provider scope and committed database identity also
need the URL-key metadata. The lifecycle regression initially returned a full plan
without the required repair; it now produces an isolated `database-bindings`
action, rechecks its evidence during apply, and reaches an ordinary noop afterward.
The real-transport cases cover denied reads, unusable present keys, changed scope
or selection, preserved explicit choices, export retries and deferred secret
inputs. Credential-value changes do not change this value-free metadata
fingerprint. Separate template regressions also reproduced a stale serialized
`value` taking precedence over the official `defaultValue`, and a composed URL
pointing at the wrong component references. Both now fail safely or use the
official default as appropriate. These checks do not establish live URL
resolution or database authentication.

## Public database access admission

Railway database operations no longer create public TCP proxies. Private-only
query and migration access returns a value-free limitation with operator SSH
guidance; existing endpoints and cleanup of earlier owned leases are preserved.
The recorded official template has empty `networking`. Before `templateDeployV2`,
Hypervibe rejects public endpoint entries and unknown or malformed networking
inside that opaque configuration. Private DNS and URL references remain intact.

Two real-client query/migration regressions first failed because they serialized
`tcpProxyCreate`; they now pass with no provider mutations. Six template
regressions first failed by sending deployment requests with public or unreviewed
networking, then passed after admission checks. Fixtures use the pinned official
GraphQL schema and independently recorded template metadata. These normal
acceptance tests do not establish live template deployment or CLI tunnel
compatibility. The operator workflow and secret-output limits are in the
[installed recovery guidance](../skills/hypervibe/references/deployment-and-recovery.md).

Review also reproduced lost existing-endpoint reuse in migration and credential
operations after creation was disabled. Both regressions failed, then passed
with a read-only resolver scoped to the exact component. It preserves the
configured identity, credentials and connection options, changes only the
transport address, and leaves runtime URLs and explicit connections intact.
Synthetic SQL responses in these route tests do not prove authentication.

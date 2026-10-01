# Pinned provider API contracts

Run `npm run test:providers:api-contracts`. These tests also run in the ordinary
`npm test` acceptance gate. No credentials, schema downloads, or provider
resources are used. The existing `test:providers:upstream-contracts` command
and `scripts/check-railway-upstream-contract.mjs` remain offline compatibility
entrypoints for already-reviewed managed workflows, not upstream drift checks.

## Sources and coverage

The [shared recovery contract](../../docs/recovery-contract.md) records the
official recovery-model review for all eight database and seven hosting
providers. `recovery-provider-contracts.test.ts` checks explicit registry coverage,
actual capability declarations, unsupported planning and emitted rollback recipe
capabilities. Shared source/point tests check representation; they do not claim
unimplemented adapters or live recovery. Existing provider transport and lifecycle
tests remain the executable API boundary for implemented operations.

`daily-backup-provider-matrix.json` records official-source design evidence for
all eight database, seven hosting/mount and four object-storage providers.
`daily-backup-provider-contracts.test.ts` checks that roster and the complete
implemented policy ports against registry flags. Unsupported rows are explicit
Hypervibe implementation gaps; the matrix does not certify live backup coverage
or replace the implemented adapters' transport-contract tests. See
[daily backup defaults](../../docs/default-backup-policy.md).

`managed-recovery-provider-matrix.json` separately reviews the seven hosting
adapters' private helper execution and all four storage adapters' retained-copy
transports. Its roster test checks the private helper capability flags and exact
lockfile SDK versions/integrities. S3/Railway and Azure tests execute their real
SDK serialization with injected HTTP transports; GCS tests inspect JSON API
conditions and the raw HTTPS media path, including compressed stored bytes.
These are documentation-based wire assertions, not checked-in provider schemas
or live API certification. They cover conditional reads, create-only writes,
exact conditional deletion, pagination/revision metadata and streamed content.
Railway's general S3 compatibility claim leaves individual conditional-header
semantics to isolated live acceptance. Object streaming support does not imply
that a private database worker can receive every provider's native credentials.

Shared recovery tests exercise completion-last SHA256 readback, isolated restore,
bounded streaming, joint database/file references, controller cleanup markers
and retention of exact owned keys. Hourly health checks read committed manifests
and object inventories; they report prior restore proof and matching retained revisions,
not a fresh full-byte audit. Partial executions never certify health or count
toward the seven complete sets required before retention deletion.

### Recovery quality audit after PR #242

The audit compared the changes since `v0.1.35` through `f4ccec4` with the shared
contracts and their implemented consumers. Registry matrices cover all eight
database, seven hosting and four storage providers; unsupported rows stay
explicit. This is bounded review of recovery, adjacent rollout authority and
helper publication, not certification of every API operation in the repository.

| Boundary | Executed counterexample and enforcement |
| --- | --- |
| Cloud SQL emitted drill | Rejected/uncertain clone, failed or unrelated operation, wrong instance identity, HTTP 200 null after deletion, and provider/credential error leakage. The generated script requires correlated terminal creation before unlabeled cleanup and emits value-free diagnostics. |
| Retained SQL and object bytes | Same-size replacement after read-back or before health/retention. Real PostgreSQL restore tests and real S3 SDK serialization bind format-2 proof to the verified native revision; final deletion inventory must still match it. |
| Storage inventory | Missing object names/sizes and malformed or repeated pagination fail as unknown through real S3/Azure SDK transports and the GCS JSON API path. No object silently disappears or becomes zero bytes. |
| Private helper admission | Public immutable GHCR helper without private credentials; Railway hosting with a non-Railway database; changed or ambiguous destination; missing explicit provider cleanup proof. Shared admission checks the supported pair and current desired selection before execution. |
| Evidence upgrade | Current-contract legacy proof remains unknown. Historical contracts remain retained without blocking a fresh current set or granting deletion authority. |

These regressions were observed failing before their fixes and run under normal
`npm test`. The committed acceptance workflow and desired acceptance commands
both run that suite and type checking; live branch-protection settings were not
checked. Tests use synthetic/reconstructed responses, actual SDK serialization,
and isolated local PostgreSQL, not recorded successful provider recovery runs.
Live permissions, private routing, Railway conditional-storage semantics and a
real Cloud SQL restore still require isolated provider acceptance. Retention
checks current-key absence, not physical purging of provider version/soft-delete
history.

The adjacent hosted-configuration presence review (PR #239) reran its application
and serialized Railway transport checks without finding another defect. It
checked requested-name-only projection, repository/revision provenance, exact
bound service scope, query-only requests and secret redaction against the pinned
schema and [Railway's variable API](https://docs.railway.com/integrations/api/manage-variables).
Presence still does not establish runtime use or credential validity.

Each provider directory contains `source.json`: official source URL, upstream
revision when available, source-content SHA-256, checked-in schema SHA-256,
API version, and the exact extraction boundary. Tests verify the local hash.
Upstream descriptions/license metadata retained in OpenAPI assets belong to
their respective providers; these assets are reference contracts, not Hypervibe
API definitions.

| Contract | Pinned source | Executed coverage |
| --- | --- | --- |
| Railway | Full schema from official CLI commit `f60f3a77b980c47f1136909fbd9a443e29a2b95f` | Static adapter query validation; real `graphql-request` serialization, GraphQL input coercion and response execution; project/environment creation; unsuffixed staging web/PostgreSQL/Redis beside production; isolated second-environment bucket creation through shared plan/apply, scoped deletion and noop replan; variables, domains, volumes, delete/retry, pagination, unknown reads and uncertain writes |
| Supabase v1 | Official OpenAPI commit `26585dd4a4d6db8910a595214c9f6e8fdd206768` | Organization response and project-create request validation through the adapter's HTTP transport; ID/slug distinction; negative project-response fixture validation |
| Neon v2 | Official release OpenAPI snapshot, content hash in `source.json` | Real serialized project-create body/query validation; organization scope; negative input validation |
| SendGrid v3 webhooks | Official OpenAPI commit `fb95a935c87b79f7f982ac34bd37adab1f697dbc` (selected operations) | Exact-ID settings reads, signing PATCH serialization, unique URL discovery, optional/null fields, and negative payload validation; shared signing/key lifecycle uses reconstructed transport and synthetic hosting observations |

Railway SDL is the complete lexicographically sorted official introspection
schema rendered without descriptions. No fields, arguments, defaults, types,
or deprecations were changed. REST snapshots contain the exact selected
operations and the transitive closure of their component references, including
response schemas. No requiredness or field types were rewritten.

Pinning a test schema does **not** freeze a hosted API. Railway `/graphql/v2`
does not select the historical CLI schema revision. Supabase `/v1` and Neon
`/v2` select major API versions, not immutable server builds. In particular,
Neon's release schema URL is mutable; tests consume only its checked-in snapshot.

## Evidence boundary

The Railway fixture executes requests against the official schema in memory;
only `fetch` is intercepted. It is synthetic state, not a captured server.
The missing-service-instance error reconstructs the message, extension code,
and field path observed in Hypervibe run
`c8ac543a-c31e-4c86-8fde-956c5fd676ee`; it is explicitly not a raw HTTP recording.
Non-null fields cannot become successful null responses through this fixture.
Deletion uses scoped tombstones. Other synthetic `NOT_FOUND` classification
unit tests do not establish that Railway emits that code for every resource.

Delayed bucket tests use a fake clock at the HTTP boundary and exercise both
same-apply convergence and timeout -> persisted recovery -> re-plan -> finalization
without a second create or import. Bucket configuration may omit mutation flags,
following the official CLI's optional
[`BucketInstance` model](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/controllers/config/environment.rs)
and active-instance selection in
[`bucket.rs`](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/commands/bucket.rs).
These timings and payloads are synthetic, not captured live responses. The
GraphQL schema treats `EnvironmentConfig` as an opaque scalar; it does not
validate those JSON internals. Exact scope, region, instance reads, unchanged
production and mutation counts therefore also have behavioral assertions.

REST tests intercept only HTTP transport and inspect the actual serialized
body. Creation receives a deliberate HTTP 400 after inspection: these tests
do not claim a successful database connection or full REST lifecycle. OpenAPI
validation checks referenced shapes, required fields, types, enums, bounds and
patterns; it does not enforce string formats or every vendor semantic rule.
Neon's optional `org_id` additionally has a semantic assertion preserving the
configured organization; schema validity alone cannot prove correct ownership.

Existing hand-mocked unit tests, generated CI requests, and providers not in
the table are not thereby schema-certified. Generated workflow execution and
shared lifecycle parity tests remain complementary gates. No provider is
promoted to `supported` by these offline tests.

Railway checkpoint tests also execute snapshot creation, inventory and workflow
status through the real serialized client and pinned SDL. Snapshot identities
and nullable fields follow the official CLI's
[`database/pitr.rs`](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/commands/database/pitr.rs#L1308-L1437),
including its explicit distinction between a volume id and a volume-instance id.
The fixture is synthetic; no backup or restore has been performed by these tests.
Checkpoint failure diagnostics also follow that revision's
[`client.rs`](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/client.rs)
authorization-error recognition and
[`workflow.rs`](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/controllers/workflow.rs)
status-polling limitations. Error fixtures are reconstructed; they verify safe
categories and retained recovery identities, not the cause of a live failure.

S3, GCS and Azure Blob Storage also run the shared storage plan/apply/binding
path with two environments using the same logical resource name. Their
stateful transport/SDK fixtures check isolated physical identities and noop
replanning; they are synthetic lifecycle tests, not pinned-schema or live API
certification. Railway runs that shared path against the schema-executed
fixture above, preserving the populated production bucket instance.

The resource-name unit contract checks native plain names, scope isolation,
lossy normalization, truncation, reserved prefixes, and minimum lengths.
Hosting transport tests assert the names actually sent on creation while
retaining historical-name fixtures for bound updates and read-only discovery.
The Pub/Sub queue test composes real adapter HTTP requests with shared plan,
apply, persisted bindings, runtime variables, noop and staging-only teardown
inside one synthetic GCP project. Legacy topic/subscription IDs remain bound;
unbound legacy resources and unknown reads block creation. These additional
tests do not expand the pinned-schema certification table above.

## Changing an integration

Retained service-volume tests additionally exercise Fly, ECS Express/EFS,
Azure Container Apps/classic Azure Files, and Cloud Run/Filestore through real
clients with synthetic HTTP/SDK transport. Their fixtures cite official API
documentation; unlike Railway, they do not execute a pinned provider schema.
Shared SQLite lifecycle tests cover per-component intent, acknowledged identity,
confirmation, delayed/unknown observations and mutation-free convergence. Fly
also exercises app → disk → first Machine through the real plan/apply boundary.
Generated GitHub and portable deployment scripts are executed to check mount
preservation and reject provider-observed configuration loss. These checks do
not prove live permissions, networking, filesystem I/O, regional availability,
durability or billing. See [service volumes](../../docs/service-volumes.md).

1. State the assumption, independent evidence and counterexample before changing
   runtime code. Reproduce it as a failing test through the real client/transport.
   A fixture copied from our types, implementation or submitted request is not
   independent API evidence. Record the source and observed failing/passing
   results in the PR template's assumption section; distinguish a reproduced bug
   from a proven customer-incident cause.
2. Validate positive requests **and** responses against the pinned official
   contract. Check its validation boundary: opaque JSON/scalars require separate
   evidence for nested fields and semantics. Exercise valid omitted/null/defaulted
   fields where permitted; keep malformed fixtures in named negative tests. Add
   semantic assertions for durable identity, environment isolation and mutation
   count. Keep these regressions in the ordinary `npm test` acceptance gate.
3. For lifecycle changes include a populated first environment, a second
   environment, pagination, bound/unbound retries, failed observations and
   ambiguous mutation outcomes. Unbound resources require explicit adoption;
   an unknown read is never absence.
   For naming changes also exercise normalization/length collisions, retained
   old names and uncertain-write markers, runtime/CI binding consumers, noop
   mutation counts and teardown. Update every affected provider's contract;
   do not declare a shared naming cleanup complete from one adapter's test.
4. Update a schema only in an explicit reviewed PR. Fetch the official URL in
   `source.json`, record the new immutable revision where offered, and hash the
   exact downloaded bytes. Reapply the documented transformation, review the
   API diff, update the local hash, and run the contract and affected lifecycle
   suites. Never fetch “latest” from a test or scheduled contract job, or change
   a pinned schema merely to make an invented request pass.
5. Run opt-in live acceptance through normal Hypervibe spec/plan/apply with
   isolated resources and explicit billing/destruction authority. Preserve
   failed-resource bindings for recovery. Record the tested source SHA,
   provider/API version, exact scoped identities, operation results, terminal
   health/absence, and sanitized evidence. Never commit tokens, passwords,
   connection strings, dotenv values or raw unredacted response bodies.

For the Apreskeys recovery, live acceptance must prove staging resources and
bindings beside unchanged production, exact-reviewed-SHA managed deployment,
public health, and a subsequent noop plan. Customer production is not a
destructive test fixture. Broader create/update/delete live certification stays
in disposable accounts; the existing live harness's project/environment cleanup
TODO remains a limitation, not a passing check.

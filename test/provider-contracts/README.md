# Pinned provider API contracts

Run `npm run test:providers:api-contracts`. These tests also run in the ordinary
`npm test` acceptance gate. No credentials, schema downloads, or provider
resources are used. The existing `test:providers:upstream-contracts` command
and `scripts/check-railway-upstream-contract.mjs` remain offline compatibility
entrypoints for already-reviewed managed workflows, not upstream drift checks.

## Sources and coverage

Each provider directory contains `source.json`: official source URL, upstream
revision when available, source-content SHA-256, checked-in schema SHA-256,
API version, and the exact extraction boundary. Tests verify the local hash.
Upstream descriptions/license metadata retained in OpenAPI assets belong to
their respective providers; these assets are reference contracts, not Hypervibe
API definitions.

| Contract | Pinned source | Executed coverage |
| --- | --- | --- |
| Railway | Full schema from official CLI commit `f60f3a77b980c47f1136909fbd9a443e29a2b95f` | Static adapter query validation; real `graphql-request` serialization, GraphQL input coercion and response execution; project/environment creation; staging web/PostgreSQL/Redis beside production; variables, domains, volumes, delete/retry, pagination, unknown reads and uncertain writes |
| Supabase v1 | Official OpenAPI commit `26585dd4a4d6db8910a595214c9f6e8fdd206768` | Organization response and project-create request validation through the adapter's HTTP transport; ID/slug distinction; negative project-response fixture validation |
| Neon v2 | Official release OpenAPI snapshot, content hash in `source.json` | Real serialized project-create body/query validation; organization scope; negative input validation |

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

## Changing an integration

1. Reproduce the regression through the real client/transport before changing
   runtime code. A fixture copied from the adapter's TypeScript interface is
   not independent API evidence.
2. Validate positive requests **and** responses against the pinned official
   contract. Keep malformed fixtures in named negative tests. Add semantic
   assertions for durable identity, environment isolation and mutation count.
3. For lifecycle changes include a populated first environment, a second
   environment, pagination, bound/unbound retries, failed observations and
   ambiguous mutation outcomes. Unbound resources require explicit adoption;
   an unknown read is never absence.
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

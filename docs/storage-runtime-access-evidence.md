# Storage workload access evidence

This reconciliation extends the existing runtime-access plan/apply lifecycle with
provider-owned storage grants. Environment projection only reads the exact retained
grant; it cannot grant access, copy the deployment credential, or turn an unknown
read into absence. Clearing configuration and deleting a bucket remain blocked
until retained permissions have been reconciled.

| Storage provider | Supported hosting target | Native grant and limits |
| --- | --- | --- |
| S3 | ECS | Inline policy on the observed immutable task role, restricted to the selected bucket and object operations, with expected bucket owner and resource-account conditions. |
| GCS | Cloud Run | Version 3 bucket IAM with etag, exact per-service account lifetime and bucket/object condition. Unrelated bindings are retained; broader or unknown project access blocks preparation. |
| Azure Blob | Azure Container Apps | Exact container RBAC assignment to an observed system identity or retained user-assigned identity. User-assigned identity lifetime, attachment and Main/All availability must match. |
| Railway Buckets | None through this IAM port | Existing bucket credentials and native references remain separate. Railway does not expose this workload IAM lifecycle. |

The hosting roster also explicitly includes Fly, DigitalOcean and Vercel; none
has a native grant implementation in these storage adapters. Cross-cloud runtime
identity grants are unsupported. Existing explicitly selected standalone runtime
storage credentials remain separate from management aliases.

## Independent contracts and counterexamples

The provider responses are reconstructed from published contracts; these are not
live observations. Tests use real AWS SDK Query/XML serialization and the real GCP
and Azure REST clients with synthetic transport responses.

- [IAM PutRolePolicy](https://docs.aws.amazon.com/IAM/latest/APIReference/API_PutRolePolicy.html),
  [GetRolePolicy](https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetRolePolicy.html),
  [S3 policy scope](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-policies-s3.html).
- [GCS setIamPolicy](https://cloud.google.com/storage/docs/json_api/v1/buckets/setIamPolicy),
  [IAM conditions](https://cloud.google.com/storage/docs/access-control/iam#conditions).
- [Azure role assignment create](https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/create?view=rest-authorization-2022-04-01),
  [Blob data access](https://learn.microsoft.com/en-us/azure/storage/blobs/assign-azure-role-data-access).
- [Pub/Sub subscription get](https://cloud.google.com/pubsub/docs/reference/rest/v1/projects.subscriptions/get),
  [topic get](https://cloud.google.com/pubsub/docs/reference/rest/v1/projects.topics/get).

A matching workload identity does not establish bucket authorization. Before the
runtime changes, the new native storage and roster regressions observed 38 failures
and 3 passes because grants were unavailable and Azure projection could read account
keys. A composed regression also observed successful unwiring while its exact grant
remained retained. The corrected native, shared SQLite/wiring and teardown checks
require exact grant evidence and keep uncertain attempts recoverable.

Likewise, one absent Pub/Sub object does not establish that both the topic and
subscription are absent. The queue regressions observed 16 failures and 34 passes:
unconfirmed create could mutate, an update could recreate absence, partial pairs
looked absent, and a concurrent-create response could authorize a dependent create.
The corrected lifecycle and native suites pass all 50 checks. Saved-plan application
checks separately exercise exact confirmation and the queue-only prerequisite scope.

## Remaining evidence boundary

No live permission propagation, application SDK authentication, billing or cleanup
is certified. IAM and ARM create/update operations do not provide a general atomic
create-only ownership guarantee; exact prechecks and postchecks cannot exclude an
external writer racing the same IAM slot. GCS uses its native policy etag.

Azure prepared holding workloads and configured-but-not-running identities cannot
supply observed application access. Native local Azure access that cannot identify
the caller through the existing credential client remains blocked. This change does
not introduce a new token decoder or weaken the hosted federated identity path.

The normal Vitest include patterns run these contracts, `.github/workflows/hypervibe-acceptance.yml`
runs `npm test`, and `.hypervibe/spec.json` declares that acceptance command. This
checks repository CI configuration; live branch protection was not inspected.

## Reconciliation validation

Backup CI must select the credentials for its declared storage providers as well
as its host. A Railway-hosted, GCS object-only backup regression first failed
because its generated gate omitted `GCP_SERVICE_ACCOUNT_JSON`; the selection now
uses the shared backup provider contract. A separate regression first exported a
credential after its provider explicitly rejected automation use. The corrected
selection honors that capability and blocks conflicting values for one environment
secret. Existing hosted federation and database credential rollout code are retained.

The newer runtime-identity lifecycle is also used directly during storage wiring;
a regression first failed when the legacy identity resolver was absent. Native
Azure tests separately cover current user-assigned identity lifetime, attachment,
container availability and public client-ID selection.

Final isolated branch validation: 19 focused test files, 377 tests passed;
`npm run typecheck` and `git diff --check` passed. The tests cover real serialized
provider clients and SQLite application flows with synthetic transports. No live
provider operation, deployment, credential rotation or public access change occurred.

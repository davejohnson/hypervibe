# GCP managed recovery

Cloud Run can execute the managed recovery helper for a bound Cloud SQL database
and GCS archive. Preparation is part of `hv_spec` → `hv_plan` → `hv_apply` and
requires a separate confirmation for each currently observed mutation. Setting a
daily policy alone does not prove an available recovery point or a successful
restore.

## Authority and execution

Preparation verifies the native project number, database identity, environment
labels, bucket project numbers, service-account lifetime and exact existing IAM
policies. It creates a dedicated recovery service account and database-credential
secret, grants the worker Cloud SQL connection access, exact secret-version read
access and archive/source bucket access. Etag-protected policy merges preserve
unrelated bindings. Missing identity, permission or concurrency evidence blocks.

The operator can prepare these resources using a transient, exact-environment
local Google authorization. A human user is never represented as a service
account. If a separately reviewed GitHub workload identity is retained, the
native service-account unique ID is checked before granting it `actAs` on the
worker and exact archive-bucket object access for the backup controller. Source
bucket bytes remain worker-only; CI receives no project-wide object permissions.
The controller's immutable ID stays in recovery evidence so removal can verify it
even after separately authorized CI trust removal. Local user tokens are never put into a workflow or helper.

Scheduled backups use the separately reviewed backup workflow in that GitHub
identity descriptor. The generated job requests GitHub OIDC and forwards only
the runner's two OIDC request environment variables by name to its controller.
The committed contract contains public identity coordinates, not a service-account
key or administrator refresh token. The controller rechecks the current binding
before creating adapters. Existing durable service-account connections retain
their explicit credential path; a malformed federation descriptor cannot fall
back to that path.

The worker runs one temporary Cloud Run job task, with one execution, no retries,
2 vCPU, 4 GiB memory and a 2,700-second timeout. The job uses a separately verified
immutable helper image, the dedicated runtime identity and an exact numerical
Secret Manager version. PUBLIC uses the authenticated Cloud SQL connector;
PRIVATE additionally requires a verified matching subnet. Provider credentials
and arbitrary application variables are not copied into the helper.

The helper produces a complete recovery set only after isolated restore and
verification succeed. Temporary job, execution, task, template, UID, generation,
etag and terminal result are independently observed. Unknown run acknowledgement
does not authorize another execution or deletion of an unknown execution. The
controller reports incomplete cleanup and retains the exact identity for
reconciliation. A secret-version write with an uncertain acknowledgement retains
its encrypted private input and prior version inventory for read-only recovery;
it is not blindly resubmitted.

Setting backups to `disabled` with an explicit reason plans a separate removal
frontier from the retained public source coordinates. It does not need to read a
database password. Each grant removal and dedicated credential/identity deletion
requires exact confirmation. Removal blocks while jobs still reference the
worker, when a native identity changed, or when independently added secret
versions/readers would be affected. Secret deletion carries its native etag;
service-account deletion uses the immutable unique ID. Lost acknowledgements are
reconciled read-only and are never blindly repeated. Local authority is cleared
only after native absence and all grant removals converge. Existing archive data,
source objects and separately authorized application identities are preserved.
Native archive retention, Cloud SQL backups/PITR and application recovery remain
separate policies. A scheduled workflow using the old contract will fail closed
after this removal; removal does not erase backup history or rewrite old commits.

## Independent evidence and regression results

The provider contract is based on [Cloud Run Jobs and executions](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs),
[per-task completion](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions.tasks),
[Cloud SQL connection from Cloud Run](https://docs.cloud.google.com/sql/docs/postgres/connect-run),
[Secret Manager version creation](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/addVersion),
[GCS bucket project identity](https://docs.cloud.google.com/storage/docs/json_api/v1/buckets),
[Resource Manager project identity](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects),
and [conditional bucket IAM updates](https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/setIamPolicy).
Serialized HTTP fixtures are reconstructed from these contracts; they are not
recordings of a live customer account.

The following counterexamples failed before the corresponding implementation
changes and pass afterward:

| Challenged assumption | Observed counterexample and boundary |
| --- | --- |
| A managed helper must receive copied provider keys. | The actual helper parser rejected both PUBLIC and PRIVATE native Cloud SQL/GCS configurations (2 failures). Native worker configuration now admits only prepared public coordinates. |
| A setup caller always has a service-account email. | Native `testIamPermissions` allowed a local human caller to act as the worker, but preparation rejected it. Both allowed and denied native-authority cases now behave independently of principal type. |
| An environment label establishes bucket ownership. | An otherwise matching bucket belonged to another native project number and incorrectly produced a mutation. It now blocks. |
| Importing the backup controller registers its database and hosting providers. | An isolated import lacked Cloud Run and Cloud SQL metadata. The actual controller provider entry point now registers both. |
| A workflow file alone gives a container access to runner federation. | Executing generated backup shell captured no `id-token: write`/OIDC forwarding. The generated workflow and Docker argument boundary now contain exactly the reviewed inputs. |
| Controller object permissions belong on its project role. | Two real serialized-policy regressions failed because the archive had no controller grant. A separately reviewed exact archive-bucket grant now converges, rejects a replaced controller during cleanup and preserves source/unrelated access. Lost acknowledgement recovers without a second PUT; the focused native/shared/WIF run passed 65 checks. |
| A retained CI account email establishes its lifetime. | Preparation accepted a replaced service-account unique ID. Native identity mismatch now blocks before IAM writes. |

On 2026-10-25, the focused recovery/helper/backup-controller/spec-binding suite
passed **186 tests in 11 files** before removal was added; the focused removal
and shared lifecycle suite then passed **51 tests in 2 files**. Both runs used
ordinary `npm test`. The subsequent combined recovery/authority suite passed
245 tests in 12 files, and `npm run typecheck` passed. The pinned actual
Cloud SQL connector's loopback HTTP/TLS contract suite passed 5 tests. These tests
are in ordinary `npm test`; `.github/workflows/hypervibe-acceptance.yml` executes
that command, and `.hypervibe/spec.json` declares the acceptance check required.
A separate read-only `hv_ci_status` observation on 2026-10-25 confirmed main is
protected with `Hypervibe / acceptance` required and no mandatory human review.
Administrators are not forced through that protection (`enforceAdmins: false`).
The built helper image `sha256:63cadbad22c8b0570ea51f056169acad46034b9257221e5fa8eeba83e3d8a736`
passed `test/backup-runner-smoke.mjs` with Docker networking disabled: packaged
PostgreSQL 16 schema/rows/files, isolated restore, and late-verification failure
without source loss. This is a local image ID from the pre-removal candidate,
not a published registry manifest or native Cloud SQL restore evidence.

Removal challenged the assumption that disabling backups could simply retain
access and report readiness. Before the fix, the native reverse-frontier test
returned `unknown`, and the shared disabled-backup test produced no action.
Both now pass. Additional tests cover replaced identities, live jobs, unowned
versions, independent readers and deletion acknowledgements lost before or after
commit. Official [secret deletion](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/delete)
and [service-account deletion](https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/delete)
contracts establish the etag and immutable-identity boundaries.

No native Cloud Run job, cloud permission, private route, published helper digest,
customer backup or live restore is certified by these offline results. The
[provider matrix](../test/provider-contracts/managed-recovery-provider-matrix.json)
keeps AWS ECS and Azure Container Apps private recovery execution explicitly
unsupported; adding GCP does not change those implementations.

The exact archive-only CI grant also crosses shared value-free evidence and
packaged helper configuration. The native lost-acknowledgement test exposed a
contradiction: `permission:controller-archive-access` was a valid provider
receipt but the common evidence parser rejected it. That actual receipt failed
before adding its exact coordinate to the shared allowlist; the native receipt,
shared bindings and helper configuration checks now pass (108 tests across four
focused files). Unknown or suffixed grant kinds still fail. The native cleanup
test also verifies `actAs` removal, then controller archive access, worker archive
access, dedicated database secret and finally worker identity. These checks
exercise the serialized evidence and native request sequence, not live IAM.

## Integration provenance

This integrates selected GCP recovery work already present in the original
Hypervibe working tree based on `8b491912401ad92edf7cadd5e1cbbd5a84f6f555` into
the isolated Connect Cloud draft based on
`4e75df6e22821efbddbc23b9a88a448a49611b78`. The original working tree was not
changed. The initial source-file hashes are retained in
`test/provider-contracts/gcp-recovery-source-provenance.json`; they describe
input provenance, not the final adapted code or prior test claims.

Shared interfaces, preparation/apply authority, encrypted pending state, native
helper transport, restore-drill connector handling and ordinary regression checks
were selected. Unrelated original edits were excluded. Additional fixes above
adapt the implementation to the current Zod version, local authorization,
environment-scoped connections and separately reviewed GitHub federation.

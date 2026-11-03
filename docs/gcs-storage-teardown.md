# GCS bucket teardown and retained deletion evidence

This change fixes ordinary storage teardown and migration candidate/rollback
cleanup. It does not implement operator artifact retirement, project deletion,
retention-policy changes, or permanent data purge.

The failed assumption was that a current-object listing describes every stored
generation, and that a missing active bucket proves all data was removed. The
counterexample is a versioned bucket containing live and noncurrent generations:
the previous client listed only the live objects and deleted by name. A second
counterexample is successful native deletion followed by ordinary GET 404 while
soft-deleted data remains recoverable.

## Native contract and behavior

The JSON API requires `versions=true` to enumerate noncurrent generations.
Teardown completes every page before mutation, then deletes only those exact
generations with `generation`, `ifGenerationMatch`, and
`ifMetagenerationMatch`. Retention inventory uses a separate `softDeleted=true`
listing. Missing generations, repeated page tokens, denied reads, malformed
metadata, or incomplete inventory stop cleanup. Object holds and retention are
preserved. These fixtures reconstruct the documented transport; they are not
native observations. Sources: [object listing](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list),
[object deletion](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/delete),
[object metadata](https://docs.cloud.google.com/storage/docs/json_api/v1/objects).

The client verifies the exact bucket in the connected project and rereads its
generation, creation time, project number and metageneration before destructive
steps. It does not sweep objects introduced after the initial inventory. A final
version listing must be empty; the native bucket DELETE independently refuses a
bucket containing live/noncurrent objects. Its only available condition is
`ifMetagenerationMatch`. The provider does not offer a bucket-generation DELETE
condition, so these reads are not an atomic fence against external same-name
replacement. Existing producer shutdown and reviewed bucket authority remain
necessary. Sources: [bucket listing](https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/list),
[bucket deletion](https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/delete).

Bucket deletion can succeed while soft-deleted objects remain. Before deleting
the parent, Hypervibe captures each observed retained object's name, generation,
metageneration, retention dates and restore token when present. It then verifies
the exact soft-deleted bucket generation and its native deadline, which must
cover the captured child deadlines. A deleted bucket's children cannot be listed
without restoring it, so child details in the receipt are the captured
pre-deletion observations, not a claim of fresh child reads after parent deletion.
Hypervibe does not restore the bucket just to inspect it. Sources:
[bucket metadata read](https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/get),
[soft delete](https://docs.cloud.google.com/storage/docs/soft-delete).

Success means the requested bucket is absent from active use, with the native
retention obligation stated separately. The receipt never claims physical
erasure. After the provider's retention window, exact active and soft-deleted
metadata reads are still required; elapsed time alone proves nothing.

## Write-ahead recovery and local state

Before the first child DELETE, the caller saves the bucket lifetime, every selected
object name/generation/metageneration, the final bucket step and existing retention
observations with an environment SQLite compare-and-swap. Before each dispatch it
marks that exact step uncertain; after verified child absence it advances to the
next unattempted step. Each transition compares the original local reference and
effective provider context. Failed persistence stops further deletion. The immutable
selection is never expanded to sweep concurrent writes.

A lost response, denied readback, or failed progress/completion save retains this
marker and the original active/candidate/rollback reference. Restart recovery uses
only metadata reads for the recorded generation; it never repeats DELETE or acts
on a same-named replacement. Exact object GETs use `generation` and, separately,
`softDeleted=true`; no object contents are downloaded. Ambiguous restore-token
resolution remains unknown. Source:
[object metadata reads](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get).

When the uncertain child is verified absent, recovery saves that observation and
returns pending. A fresh plan offers a confirmable continuation pinned to the
current marker hash and the remaining unattempted native identities. Replaying an
old ordinary or migration action cannot dispatch those remaining steps. The same
running authorized attempt may advance through its initially selected steps.
The ordinary retained-permission blocker also applies to continuation and each
new dispatch; uncertain read-only recovery stays available.

Acknowledged DELETE HTTP 403/412 responses are saved as rejected, separately from
crashes, missing acknowledgments and timeouts. A read-only exact presence check
can prepare a fresh, explicitly described retry action. For an uncertain object
attempt, Google documents conditional idempotence when `ifGenerationMatch` or an
exact generation is supplied. The retry rechecks the original bucket lifetime and
object metadata, preserves the original uncertain/rejected attempt, then saves a
new attempt before dispatching once with the unchanged generation and both
preconditions. After that child is verified, it stops; remaining unattempted steps
need their own fresh continuation plan. There is no automatic retry. Changed metadata or holds block the
retry; this workflow cannot adopt new metadata or lift protection. Sources:
[retry contract](https://docs.cloud.google.com/storage/docs/retry-strategy),
[request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions).

The marker uses the existing strict recovery frontier under the historical
`storageCreateRecovery` key, with the honest discriminator `operation: "delete"`.
There is no fabricated create attempt or second marker. Existing create-only
parsers retain their old behavior and reject a delete record. Current plan/apply
and migration readers separate the two kinds; malformed or ambiguous maps block
mutation. Planning emits either read-only uncertain-step recovery or an explicit
remaining-deletion continuation before further storage work.

Validated nonsecret completion evidence is saved in local
`storageDeletionReceipts` in the same SQLite compare-and-swap that removes only
the matching reference and marker. The comparison includes effective context for
legacy bindings. Migration candidate cleanup stops for a fresh plan before
creating another candidate, so a stale follow-on write cannot overwrite concurrent
candidate/context changes. Receipt history is never treated as active storage.
Pending deletion markers and receipt history stay out of repository exports;
repository input cannot supply or replace them. Existing portable create recovery
remains unchanged.

## Explicit limits

- When a bucket has no soft-delete policy, Google documents that
  `softDeleted=true` can return HTTP 400 `invalidArgument`. Previously retained
  objects can outlive a later policy change. This implementation treats that
  inventory as unknown and blocks cleanup; it does not silently treat the bucket
  as empty or change its policy. This is a practical unsupported cleanup state.
- An uncertain bucket deletion that still reads as active remains blocked.
  Google's general bucket idempotence classification does not provide a bucket
  generation-match DELETE condition across same-name replacement. Completion
  needs verified absence/retention for the original lifetime; retry would need
  a stronger native lifetime condition or separately proven exclusive ownership.
  No state deletion or blind retry is used to conceal the gap.
- The bucket lifetime is checked against this operation's native observations
  and frozen for restart recovery. This does not retroactively add immutable
  creation evidence to older bindings or prove exclusive control of all outside
  writers.
- Read-only native resource absence is not proof of immediate physical erasure
  or zero charges during provider retention.

## Shared-provider review and checks

The optional recovery argument and evidence do not change `Receipt` or assume
provider parity. GCS opts in. S3, Azure Blob and Railway keep their existing
deletion implementations and cannot acquire GCS retention proof from a generic
success message. S3 requires all versions/delete markers to be removed before
bucket deletion; Azure's existing adapter deletes the bound storage account,
whose ARM contract is distinct from container soft deletion. Sources:
[S3 DeleteBucket](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteBucket.html),
[Azure account deletion](https://learn.microsoft.com/en-us/rest/api/storagerp/storage-accounts/delete),
[Railway buckets](https://docs.railway.com/storage-buckets).

Observed pre-fix failures covered omitted generations, mutation after incomplete
inventory, changed scope/lifetime, missing durable completion evidence, concurrent
binding replacement, and migration callers dropping retention receipts. Further
regressions failed before their corrections for lost-response restart, completion
CAS failure, repository import/export, and private data disguised as coordinates.
The child-recovery extension first reproduced two failures: child writes before a
failed recovery save, and no retained identity after a lost child acknowledgment.
Another actual migration-caller test caught a pending recovery result incorrectly
reported as blocked. Tests cover those corrections, step-progress CAS failure,
changed effective context before the first child, stale action rejection, retained
runtime-permission blocking on continuation, and
read-only child recovery followed by an exact fresh-plan continuation.
Conditional retry tests first failed for unclassified 403/412 rejection and
still-present uncertain objects. They now check fresh-plan authorization, native
recheck, unchanged preconditions and preservation of the original uncertain outcome.
An actual saved-plan/executor regression also reproduced missing action-authority
admission. Recovery, continuation and retry now have strict separate envelopes;
forged identifiers, hashes or metadata fail before dispatch. A further failing
retry-scope test proved that approving one retry must stop before later children.
The current tests execute the real GCS client and actual SQLite callers with
synthetic native transport, plus the complete registered storage roster.

All new tests are discovered by ordinary `npm test`. The committed acceptance
workflow and desired required check run that test path and TypeScript checking.
Live branch protection, real provider compatibility and a cloud cleanup were not
tested. No provider writes were performed while developing this change.

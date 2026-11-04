# Retained parent deletion recovery

The existing retained-cleanup flow can select one inspected, owned, empty Google
Artifact Registry repository. This correction saves its deletion attempt before
the native DELETE. If the response is lost, a later plan checks that same attempt;
it does not send the deletion again. The exact resource ID, creation time and
ownership evidence remain first-class fields in `previousResource`.

The challenged assumption was that a failed DELETE call meant it was safe to
offer the same deletion after restart. The counterexample is a lost response
while the repository remains visible during asynchronous deletion. The actual
SQLite/import/saved-plan/apply test initially issued two DELETEs across restart.
It now issues one, preserves the checkpoint, and clears the binding only after
an independent authenticated observation proves the exact repository absent.

## Supported workflow and boundaries

Continue using `hv_import` with `mode=retained-resource-cleanup`, an exact inspected
ID and scope, then `hv_plan` with `scope=retained-cleanup` and `hv_apply` for the
saved plan. A new deletion remains an explicit confirmed destroy action. After an
attempt, planning emits a read-only update named `retainedResourceRecover`, with
no deletion confirmation or mutation authority. A noop still performs no provider
mutations. Pending or unknown recovery stops dependent cleanup.

The checkpoint records a unique attempt, the complete target hash, and the exact
acknowledged operation when its shape and scope are verified. Both write-ahead
persistence and subsequent removal use complete binding compare-and-swap. Failed
persistence prevents the dependent write. Unknown, denied or malformed responses
preserve the checkpoint. This slice does not automatically reset or retry failed
attempts. An unrecognized operation identity, including an unverified numeric
project alias, stays unconfirmed; it cannot trigger another DELETE. A missing
operation is not proof of repository absence.

Initial completion and restarted recovery share the same bounded native read
path. It validates operation scope, identity, status and the Empty result shape;
it never relies on operation completion alone to remove the binding. A current
same-name replacement with a different lifetime is blocked. Provider messages and
operation error bodies are not copied into durable cleanup diagnostics. An exact
access-token echo cannot become a persisted operation identity.

The repository exporter omits the whole pending local cleanup record. Import
cannot introduce a checkpoint or change its target. An identical older export
may retain the original target without a checkpoint; actual context hydration
preserves the newer local checkpoint, including across a SQLite restart.

## Provider matrix

| Provider / existing capability | This change |
| --- | --- |
| Cloud Run / retained Artifact Registry parent | Opts into durable DELETE and read-only recovery; empty inventory and exact lifetime remain required. |
| Cloud SQL / retained backup | Existing capability unchanged; does not advertise this optional durable parent contract. |
| AWS ECS, AWS S3, Azure Container Apps, Azure Blob and all other registered providers | No generic retained parent deletion opt-in. Their separate cleanup capabilities are not implied or changed. |

The normal application roster regression enumerates every registered provider
and asserts exactly the two existing retained-cleanup registrations and only the
Cloud Run durable opt-in.

## Native limits and evidence

Google's [repository DELETE contract](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories/delete)
deletes a repository **and its contents** and returns an operation with no
metadata and an Empty completion response. It exposes no lifetime/etag or request
ID precondition. The existing complete package/file/attachment inventory and
immediate lifetime recheck establish observed emptiness, not an atomic empty-only
guarantee. An external upload or same-name replacement can race the final check;
this change neither solves that native limitation nor authorizes silent cleanup
of observed nonempty contents. Quiesce producers before the separately reviewed
parent cleanup. Shared project, IAM, billing and other repositories are preserved.

[Operations.get](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.operations/get)
reads the exact project/location operation. The [Operation contract](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.operations)
distinguishes pending, error and successful results. A different operation,
permission failure, malformed body or missing operation remains unknown.

The regression uses synthetic responses reconstructed from these contracts,
the actual serialized adapter transport, actual SQLite and saved plans. It covers
lost acknowledgment, pending/denied/missing/malformed operations, replacement,
unexpected payloads, local concurrency, confirmation classification and stale
repository hydration. Additional observed RED cases rejected arbitrary operation
payloads and acknowledgment without a persisted first attempt. These checks run
in ordinary `npm test`, which the committed acceptance workflow and desired
required check invoke. They do not establish live deletion compatibility or live
branch-protection settings. No native deletion was executed for this work.

## Local state compatibility

Migration 14, `retain_native_delete_attempts`, changes no tables or existing data.
It records a minimum reader format so an older runtime cannot ignore the saved
attempt and repeat a deletion. Schema progression is intentional and has no
supported downgrade; do not remove its migration record to run an older package.
Before activation, preserve a consistent database/key backup and use the reviewed
updated runtime. No real operator database was migrated during this work.

A separate read-only compatibility probe loaded the actual frozen operator 4989
package against a disposable synthetic schema-14 database. Its existing forward
version guard rejected the database before applying migrations; original rows and
migration history were unchanged. Normal SQLite regression tests also preserve
the historical schema-11/12 histories while adding the new format barrier.


This compatibility barrier applies to older runtimes opening the **same local
SQLite state**. It cannot fence a separate installation with its own stale copy
or coordinate an external administrator. New exports omit pending cleanup and
same-state hydration preserves it; this is not cross-machine native idempotency.

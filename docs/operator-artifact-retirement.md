# Operator publication retirement

An accepted publication is not deletion authority. An explicit
`operatorArtifacts.<name>.retirement` declaration selects its original
installation ID and plan digest, `resources: "delete-owned"`, and a data choice.
Use the ordinary `hv_spec` → `hv_plan` → exact-action `hv_apply` workflow. The
retirement review is isolated from image preparation and deployment. Removing
the declaration alone never deletes anything.

This slice implements GCP publication **content** removal, not complete cloud
teardown. The original project/repository creation journals own those parents;
publication receipts do not grant authority to delete them. No live removal has
been performed to validate this implementation.

| Provider / object | Implemented scope | Remaining boundary |
| --- | --- | --- |
| Cloud Run private application candidate | Original attempt tag, then its exact immutable image version when `data=delete-owned` | Shared Artifact Registry repository, IAM and project remain |
| GCP public holding / backup helper images | Same tag/version path; `data=retain` removes the selected tag and retains the immutable image URL and bytes | Public repository access remains; retained images can still incur charges |
| AWS `s3` operator templates | Desired retirement is stored but planning remains explicitly unsupported | Exact public version statements, CloudFormation stack, object versions/delete markers and retained bucket need the separate reviewed adapter |
| Azure | No operator-artifact publication capability is registered | Existing application/storage cleanup is a different lifecycle |

Desired and bound services, runtime identities/read grants, previous hosting,
unfinished release or recovery work, retained backup runtime authority, registered
automation authentication, and an enabled backup schedule block this teardown.
Disabling the desired schedule alone is insufficient: the supported backup
runtime removal must finish and remove its binding, and the automation identity
must be disconnected before image cleanup. Another unfinished publication also
blocks it. The shared planner
matches the retained original declaration/spec, exact selected ancestry and
completed-evidence hashes, then freezes the entire current binding map in the
saved outer plan. Every write rechecks that selection; unrelated concurrent
binding changes stop the next effect without overwriting them. A fresh plan can
finish readback and separately review remaining actions against the new binding
snapshot, without rewriting the original native intent or replaying deletion.
A refresh marker is consumed historical
context, so retirement replaces that marker with the exact accepted receipt.

The GCP driver rechecks the original project identity/lifetime, repository
creation time/ownership marker and current metadata/delete permissions. It does
not require billing, anonymous access or an old local image to remain usable.
Each target must match an accepted original upload time, immutable digest and
attempt tag. It lists every bounded page of the package's tags; foreign tags,
malformed/partial inventory, changed lifetimes, immutable-tag policy and denied
reads stop removal. Shared versions published by multiple accepted attempts are
currently rejected until a combined tag selection is supported.

Tag deletion precedes version deletion. The latter explicitly uses `force=false`:
any remaining or newly created tag blocks it. No repository, IAM grant or
unrelated version is deleted. Removing an image prevents its future deployment
or rollback; downloaded copies elsewhere are not erased. Hypervibe cannot
inventory arbitrary external consumers, which remains an explicit review limit.

Google tags expose only a name and destination, without a separate immutable
creation identity. A same-name replacement pointing to the same digest cannot
be distinguished from the original reference; the plan explicitly discloses
this limit. Google documents no tag-delete precondition. A concurrent external administrator
can move the selected tag after the last read, and deletion can then remove that
tag's changed reference. The plan discloses this limitation; it does not describe
the prior read as an atomic ownership fence. Version deletion likewise has no
upload-time precondition: a concurrent same-digest replacement after the final
read cannot be excluded. It still targets the reviewed content digest and
refuses tagged versions. The plan states both limits explicitly.

The shared journal records an attempt before each DELETE. A retained long-running
operation is reobserved by its exact name. A lost acknowledgment can converge
only through freshly authenticated exact absence; a still-present target remains
pending and is never automatically deleted again. Readback requires current
metadata-read authority, not continuing delete permission. Loss of read authority
and failed or missing operation reads remain unknown. A definitely rejected write requires a
fresh, exact retry review. Original publication and completed retirement records
remain immutable. `data=retain` is terminal for this slice: a later retained-image
deletion continuation is not implemented and must not be inferred from secret
output-container continuation support.

## Evidence and normal acceptance

The challenged assumption was that accepted operator publication could be
cleaned up through the existing desired-state lifecycle. An actual saved-plan /
SQLite regression showed it was unconditionally blocked before a retirement
review, even after workload consumers were removed. That RED preceded runtime
changes. The new tests exercise saved-plan/apply, real bounded REST serialization,
exact action confirmation, read-only restart, native operation receipts, denied
reads, malformed inventory, retained data, concurrent binding changes, and the
private/holding/backup image producers. The fixtures are reconstructed official
responses, not newly observed native deletion evidence.

These tests run in ordinary `npm test`; the committed acceptance workflow uses
that command. This repository evidence does not verify live branch protection.

Plan and apply results project completed removal and retained-data outcomes through
the same closed schema as operator application retirement. A later `hv_plan` reports
the terminal outcome without rebuilding the image. A saved-plan/apply regression
first exposed missing retained-image summaries on all three result surfaces; the
fix preserves their native identities and says storage and traffic charges may
continue. This is recorded completion evidence, not a new native deletion check.

Official contracts:

- [Tag resource](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.packages.tags): named reference to a version, without a separate lifetime identifier.
- [Tags.delete](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.packages.tags/delete): empty request and empty JSON response; no documented precondition.
- [Tags.list](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.packages.tags/list): paginated inventory.
- [Versions.delete](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.packages.versions/delete): long-running operation; `force=false` rejects versions with tags.
- [DockerImages.get](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.dockerImages/get): exact digest metadata and upload time used with retained publication evidence.
- [Repositories.delete](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories/delete): deletes the repository and its contents; deliberately outside this content-only review.

AWS follow-up must preserve its native differences: the existing template uses
CloudFormation `Retain`; stack deletion alone leaves the bucket/data. Historical
versions require exact `Bucket + Key + VersionId`, not a versionless delete.
S3 conditional-delete ETag evaluation applies to the **current** version and is
not a historical-version CAS. Bucket deletion and policy changes lack a native
lifetime/policy CAS. `HeadBucket` errors are ambiguous; complete authenticated
owning-account inventory is required for absence. These constraints are recorded
in the provider matrix; this slice advertises no AWS cleanup implementation.

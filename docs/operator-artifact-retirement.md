# Operator publication retirement

An accepted publication is not deletion authority. An explicit
`operatorArtifacts.<name>.retirement` declaration selects its original
installation ID and plan digest, `resources: "delete-owned"`, and a data choice.
Use the ordinary `hv_spec` → `hv_plan` → exact-action `hv_apply` workflow. The
retirement review is isolated from image preparation and deployment. Removing
the declaration alone never deletes anything.

The supported paths remove GCP publication **content** and an AWS template
publication's owned stack, versions and bucket. They do not implement complete
cloud teardown. The original GCP project/repository creation journals own those
parents; publication receipts do not authorize deleting them. No live removal
has been performed to validate these implementations.

| Provider / object | Implemented scope | Remaining boundary |
| --- | --- | --- |
| Cloud Run private application candidate | Original attempt tag, then its exact immutable image version when `data=delete-owned` | Shared Artifact Registry repository, IAM and project remain |
| GCP public holding / backup helper images | Same tag/version path; `data=retain` removes the selected tag and retains the immutable image URL and bytes | Public repository access remains; retained images can still incur charges |
| AWS `s3` operator templates | Exact public version statements, original CloudFormation stack and optionally selected immutable versions followed by the empty owned bucket | Account, customer stacks and downloaded copies remain; foreign versions/markers/uploads block cleanup; retain-to-delete continuation unsupported |
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
A publication provider need not be the hosting provider: AWS `s3` templates can
belong to an operator hosted on Cloud Run. Current desired and bound hosting must
still match the original saved hosting provider, and retained automation
authority is checked through that hosting provider's registered capability.
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

## AWS template publication cleanup

The AWS adapter compiles targets from selected accepted publication records,
including inherited immutable versions. It verifies each final publication
attempt and completion proof, exact account, original stack ARN/create time,
original template, sole bucket resource, ownership tags and creation event.
Retirement uses the existing temporary AWS connection without issuing
publication setup actions or requiring public access to remain enabled.

The saved plan has separate confirmed actions: remove the exact owned public
version statements; delete the original stack by full ARN with `STANDARD` and
the durable attempt token; for `data=delete-owned`, permanently delete each
reviewed `Bucket + Key + VersionId`; then delete the empty owned bucket. The
stack's `Retain` policy deliberately leaves bucket data until those explicit
steps finish. No force deletion, versionless object deletion, governance bypass
or multipart cancellation is authorized.

Full version/delete-marker inventories are paginated using both markers. Each
present selected version is checked using metadata, checksum and immutable
version ID without reading its contents. Foreign versions, delete markers,
incomplete pages, changed identity, protected versions, MFA Delete and multipart
uploads stop removal. Unrelated bucket-policy statements are preserved for
`data=retain`; their presence blocks whole-bucket deletion. A fresh complete
owning-account bucket inventory, authenticated by matching STS identity, proves
bucket absence. `HeadBucket` 403/404 is never used as absence evidence.

Unknown acknowledgments only permit readback. A still-present uncertain target
is not sent another delete. A definitely rejected request requires the existing
fresh exact retry review. Stack deletion is observed by the original ARN and
the matching attempt token in its events; missing/expired stack history remains
unknown, not permission to recreate or repeat deletion. Retained data is included
in typed plan/apply outcomes with continuing cost information. A later change
from completed `retain` to `delete-owned` is not implemented.

There is no atomic policy or bucket lifetime CAS in these APIs. Concurrent
same-account policy changes or same-name bucket replacement after the final
read cannot be excluded and are disclosed in every native retirement review.
Historical versions are identified by `Bucket + Key + VersionId`; S3's ETag
conditional-delete evaluation concerns the current version, so no historical
version ETag CAS is claimed. Customer stacks created from these templates and
downloaded copies are outside this cleanup.

The ordinary test path exercises the real AWS SDK serialization and actual
SQLite saved-plan/apply/restart boundary. Initial RED proved the missing AWS
plan path. Further RED cases caught inconsistent account-owner metadata across
bucket inventory pages and the complete removal of an owned-only policy's
optional document ID. Fixtures reconstruct official responses; they do not establish
live retirement compatibility.

Official AWS contracts:

- [CloudFormation Retain](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html)
- [DeleteStack](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DeleteStack.html)
- [ListObjectVersions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html)
- [DeleteObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html)
- [Conditional delete limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-deletes.html)
- [PutBucketPolicy](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketPolicy.html)
- [DeleteBucketPolicy](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteBucketPolicy.html)
- [DeleteBucket](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteBucket.html)
- [HeadBucket ambiguity](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadBucket.html)
- [ListBuckets](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListBuckets.html)

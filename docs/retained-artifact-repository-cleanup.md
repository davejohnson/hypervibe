# Retained Artifact Registry repository cleanup

A repository name identifies a reusable address, not its original lifetime. The
retained-resource cleanup path now preserves the observed repository `createTime`
and a SHA-256 digest of its strictly formatted Hypervibe creation marker beside
project/location. Import, planning and apply keep that exact scope; the adapter
checks it before child inventory and immediately before DELETE. Missing or changed
evidence blocks deletion without replacing the original binding. HTTP 200 with a
null, malformed or different-name repository is unknown; only native 404 is absence.

This bounded repair does **not** prove original creation from a marker. A marker is
mutable metadata, and retaining an inspected resource still requires the existing
explicit import confirmation. Original local-scope creation journals must be
connected to parent retirement before this path can independently establish owned
parent teardown. Legacy bindings without a lifetime remain blocked; this change
does not silently upgrade them from a currently observed same-name repository.

Only standard Docker repositories with complete lifetime and marker observations
are eligible. The adapter reads every page of packages, files and attachments;
any child, denied/malformed response, repeated token or inventory bound blocks the
parent delete. Empty protobuf arrays and empty page tokens may be omitted. This
path never deletes a discovered child. Exact publication retirement remains a
separate earlier step. The final repository read catches identity drift during
inventory; it does not make the provider operation atomic.

## Independent contract and boundary evidence

- The [Repository API](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories)
  defines `createTime` as output-only, while description and labels are supplied
  metadata. Names are unique within a project/location, not permanent lifetime IDs.
- [Repository DELETE](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories/delete)
  deletes all contents and returns an operation that completes after deletion. It
  documents no generation or etag precondition. A writer or replacement between
  the last read and DELETE cannot be excluded by this API; no atomicity or permanent
  erasure is claimed.
- [Packages](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.packages/list),
  [files](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.files/list)
  and [attachments](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.attachments/list)
  have separate paginated inventories. Read failure never proves an empty repository.

The regression uses the real import command, SQLite, saved plan, apply dispatcher
and Cloud Run adapter with synthetic serialized HTTP responses. Before the repair,
a same-name repository with a later creation time was deleted, apply reported
success, and the retained binding disappeared. The expanded boundary also covers
ownership-marker drift, immediate pre-delete replacement, unknown child inventory,
late-page children, malformed HTTP 200 absence and a different returned name.
An unchanged, observed empty repository completes through the existing path.

The tests run in the ordinary `npm test` glob and committed acceptance workflow;
`.hypervibe/spec.json` requests that same check. This records repository configuration,
not live branch-protection enforcement or native lifecycle compatibility.

## Explicit remaining limits

This repair is not complete test-project teardown and must not be described as a
new ownership or recovery mechanism. The existing retained-resource path still
needs durable pre-dispatch identity and exact accepted operation recovery for a
lost DELETE acknowledgement or restart. No new recovery JSON, old-reader
compatibility claim, automatic retry or ownership adoption is introduced here.
Original owned-repository/public-reader grants, CI identities, parent project
retirement, consumer checks and preservation of unrelated resources remain
separate lifecycle work. Keep the original creation evidence and cleanup bindings
while those outcomes are unknown. The current disposable project's parent cleanup
must wait for those missing boundaries.

The registered shared cleanup category currently contains Cloud Run artifact
repositories and Cloud SQL retained backups. No shared signature changed. Planning
now honors the existing `cleanupSupported: false` observation consistently with
import; the Cloud SQL native deletion and recovery contract is unchanged.

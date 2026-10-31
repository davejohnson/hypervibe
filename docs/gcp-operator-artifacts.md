# Reviewed operator image repositories

The operator continuation prepares the private application repository `hypervibe`
before binding CI. The optional selection
`publicArtifactRepository: "operator-public"` inserts a separate repository stage
before optional GitHub federation and the final environment binding.

This challenges the assumption that private application image storage is also a
safe place for public holding and backup helper images. A public read grant on
that repository would expose every application image. The new stage instead
reuses the existing native create algorithm for a distinct `operator-public`
repository and then plans a separate `allUsers` / `roles/artifactregistry.reader`
grant on that exact repository. Each action requires its own confirmation through
the local lifecycle. It uploads no images and grants no CI publisher access.
Current and future images in that public repository are publicly readable; do
not place application images, configuration or credentials there.

Every boundary rechecks the allocated project's native number, creation time,
parent, ownership markers and billing selection. The public stage also verifies
the retained private repository's exact creation lifetime and ownership attempt.
Public creation uses the same owned attempt marker and long-running-operation
correlation as private creation. The public policy update carries the current
etag and preserves unrelated members, roles and conditions. Missing etags,
permission denial, a same-name replacement, concurrency conflict or an unknown
read do not establish convergence. A lost public-grant acknowledgement is
reconciled by an independent policy read, never by blind resubmission.

The resulting nonsecret proof includes public repository name, native creation
time, installation ID and create-attempt ID. Optional GitHub federation preserves
and verifies that proof while its writer role remains confined to the private
application repository. Disconnecting CI trust must not revoke the separate
public-reader grant. The final local environment binding stores registry proof
directly under `platformBindings.providerScope`, where CI target construction
reads it.

Independent contracts checked 2026-10-25:

- [Repository IAM access and public access](https://docs.cloud.google.com/artifact-registry/docs/access-control)
- [Get repository IAM policy](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories/getIamPolicy)
- [Set repository IAM policy](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories/setIamPolicy)
- The unchanged Google protobuf snapshots and SHA256 hashes in
  `test/provider-contracts/gcp/artifact-registry/` pin repository creation time
  and the native create-operation response type.

The first public native regression failed with `invalid_contract` before runtime
changes; the private/public native suite subsequently passed 17 tests. It covers
separate confirmations, read-only acknowledgement recovery, etag/conflict and
permission handling, replacement and preservation. Reconstructed HTTP resources
are exercised through the real serialized client and shared lifecycle journal;
they are not recorded live responses.

The real application/SQLite public-stage cases then exposed a separate binding
assumption: nested hosting-receipt metadata was not normalized by the local
binder. Three cases failed because the expected `providerScope` was missing.
Persisting it directly produced three passing cases: ordinary public binding,
lost public-grant acknowledgement, and public setup followed by CI disconnection
while retaining public access.

These regressions remain in normal `npm test`, executed by the committed
acceptance workflow and declared required in the desired repository spec. Actual
branch-protection enforcement, native public pulls, policy propagation, billing
and live publication remain separate verification. No registry, policy, image or
cloud billing resource was changed while implementing these tests.

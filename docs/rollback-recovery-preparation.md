# Preparing a recovery baseline

Before updating a managed deployment workflow, inspect the release that would
be needed if the next promotion fails. This operation is read-only and may
select the release currently running in the environment.

1. Use `hv_ci_status` for the exact managed definition, then its successful run
   and release artifact. Record the full source SHA and exact run/artifact IDs.
2. Ensure the reviewed project spec and provider bindings are already recorded
   and match the repository. Preview refuses to adopt edits or bootstrap a project
   or environment.
3. Call `hv_rollback` with `action: "preview"`, the project/environment,
   `toSha`, `sourceWorkflowRunId`, and `sourceArtifactId`. CLI callers use
   `hypervibe rollback --action preview` with the equivalent flags.
4. Read the returned blockers and unchecked boundaries. `evidence-compatible`
   means the artifact passed the current generated consumer's contract checks;
   it does not mean an image was pulled, production was restored, or a database
   backup was validated. `restoreVerified` remains false.

The source workflow SHA may differ from the application SHA when the original
workflow dispatched a selected commit. The preview pins the original workflow
and bindings to the workflow run's exact SHA, and the application spec to the
recorded application SHA. It returns hashes of those original bytes, never the
raw artifacts, configuration documents, or credentials.

V2 release records remain v2. They establish their recorded repository, SHA,
service names and immutable image reference, but omit provider scope/resource
identities and a program fingerprint. The preview compares historical repository
bindings and program settings with the current target, reports changes, and
always blocks v2 execution. It does not fill missing fields using current state.

## Remaining legacy execution boundary

A usable v2 recovery path requires a separate reviewed consumer change:

- Preserve and re-read the exact source run, artifact ID and original content
  digest. Verify the successful producer workflow at its immutable revision;
  derive targets only from recognized original provider deployment steps and
  historical bindings, with no execution of downloaded workflow code.
- Corroborate each original scoped provider identity and the exact image digest
  through provider observations. Verify registry availability and pull authority.
  Ambiguous, missing or changed identities remain blocked.
- Show historical versus current runtime, service and migration contracts.
  A build-only difference needs an explicit reviewed compatibility decision;
  it must not be silently replaced with the current program fingerprint.
- Freeze the exact recovery target and compatibility decision into a reviewed
  operational plan and generated consumer contract. Re-observe source artifact,
  workflow, latest run and provider identities before dispatch. Keep default
  rollback selection and v4 validation unchanged for ordinary releases.
- Reuse the existing serialized deployment lock and immutable-image deployment
  path. Skip checkout, dependency installation, image build and push. Preserve
  migration compatibility and independently verify the final provider image and
  application health. Do not describe a preview as that final verification.

Database backup and restore validation is a separate prerequisite. A code
rollback does not restore database contents or reverse schema migrations.

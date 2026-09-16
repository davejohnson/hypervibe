# Retained Railway web-service volumes

Declare one persistent filesystem mount on a web service:

```json
{
  "hosting": { "provider": "railway" },
  "services": {
    "web": { "volume": { "mountPath": "/data" } }
  }
}
```

This is an environment fragment, not a complete project spec. Keep application
paths under that mount through your application's existing environment variables
or configuration. Hypervibe does not guess a media path or inject bucket credentials.
`storage` remains object/bucket storage; a service `volume` is a separate resource.

## Review and apply

Use the normal `hv_spec` → `hv_plan` → `hv_apply` → `hv_status` workflow.

1. A new service first needs a durable provider identity. Manual deployments get
   an isolated `hosting-bindings` plan; managed CI uses its existing binding
   stage. Apply and re-plan. These stages configure empty services, not disks or
   application deployments.
2. The next plan contains `volume:<service>`, including the exact project,
   environment, service and mount path. Creating the disk is billable and
   data-bearing; explicitly confirm that action ID with `confirmActions`.
3. Hypervibe persists create intent before the provider mutation, records the
   acknowledged disk ID, and independently observes that exact attachment before
   recording success. Service deployment and the applied-contract marker depend
   on verified attachment. An unchanged plan performs no disk mutation.
4. Deploy the application, then verify its actual mounted path, permissions,
   read/write behavior, and persistence across redeployment separately.

## Retention and recovery

This first version is **retain-only**. Omission from the spec does not delete or
detach the disk and may continue to incur provider charges. Its binding remains
in SQLite and, in a matching checkout with repository export enabled, the
value-free `.hypervibe/bindings.json` export. Local-only execution retains
recovery in SQLite only. Hosting teardown,
replacement/provider changes, and local record deletion that would lose retained
ownership are blocked. Mount paths cannot be changed in place.

An unbound existing disk is never adopted by its mount path. A lost create
response without an acknowledged ID leaves an unresolved marker and blocks
automatic retries. Investigate that resource with read-only provider inspection;
this version intentionally has no automatic clear/adopt escape hatch. If the
provider acknowledged an ID but observation failed, a fresh plan can offer a
confirmed `serviceVolumeFinalize` action for that exact identity, without a
second provider write. Missing or pending-deletion bound disks never cause
automatic replacement with empty storage. Preserve all recovery bindings.

No delete, detach, adoption, resizing, capacity selection, backups, migration,
shared worker mounts, or cron volumes are implemented in this slice. Automated
recovery of an unacknowledged create remains a follow-up requiring explicit
ownership evidence, not manual removal of the marker and blind retry.

## Provider constraints and evidence

Railway documents one volume per service, no replicas, and redeployment downtime
for volume-backed services. Default capacity depends on the account plan; this
feature leaves sizing to Railway rather than claiming a chosen allocation.
See the [volume reference](https://docs.railway.com/volumes/reference) and
[API guide](https://docs.railway.com/integrations/api/manage-volumes).

Observation requires a known single-instance configuration (including explicit
regional replica counts) and complete, paginated environment inventory. Nullable
or incomplete provider settings block rather than imply defaults. Whether a
fresh live Railway service exposes enough configuration for this check remains
unverified; the schema permits nullable replica counts. This implementation
does not silently change replica settings to make the check pass.

Tests execute serialized GraphQL against the pinned official Railway schema and
synthetic provider state, plus real local SQLite persistence. The opaque JSON
deployment configuration is modeled from the independently pinned official CLI
source. See [provider contract coverage](../test/provider-contracts/README.md).
These tests prove transport shapes and tested safety transitions, not live API
compatibility, mounted filesystems, actual billing, or durability. Ordinary
`npm test` includes the regressions; the checked-in acceptance workflow runs it
and typecheck on PRs. Branch-protection settings are not asserted by these tests.

The existing CI deployment contract includes volume intent, but later direct CI
dispatches do not freshly observe disks. Run `hv_status`/`hv_plan` after external
provider changes. No live resources were created to validate this feature.

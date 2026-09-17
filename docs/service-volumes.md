# Retained service filesystems

> Cross-host implementation in PR #218. Offline tests do not
> certify live mounts or durability. See the [provider audit](service-volumes-design.md).

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
2. A `service-volumes` plan contains `volume:<service>` or individual
   `volume:<service>:<component>` actions, including exact scope, mount path,
   capacity/cost notes and dependencies. Confirm the exact action IDs with
   `confirmActions`. One action never hides another resource's creation.
   Apply the currently ready components and re-plan before their dependents.
3. Hypervibe persists create intent before the provider mutation, records the
   acknowledged disk ID, and independently observes that exact attachment before
   recording success. Service deployment and the applied-contract marker depend
   on verified attachment. An unchanged plan performs no disk mutation.
4. Deploy the application, then verify its actual mounted path, permissions,
   read/write behavior, and persistence across redeployment separately.

Fly has an additional ordering constraint: bind an empty app namespace, create
the disk, then create its first Machine using the acknowledged disk ID. Only
then can managed CI publish a workflow targeting that Machine. Adding a disk
to an existing diskless Machine is blocked; no implicit replacement is allowed.

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

Component lifecycles retain each write intent and acknowledged resource ID
independently. A created account/filesystem is not proof of an attached, ready
workload. Repository merges preserve omitted component recovery and never
downgrade it. Removing volume intent blocks unfinished creation, rather than
continuing to create now-unwanted resources.

No delete, detach, adoption, resizing, user-selected capacity, backups, migration,
cross-service shared mounts, or cron volumes are implemented. Automated
recovery of an unacknowledged create remains a follow-up requiring explicit
ownership evidence, not manual removal of the marker and blind retry.

## Provider constraints and evidence

| Host | Filesystem path and initial constraints |
| --- | --- |
| Railway | Native volume; web only, known single-instance configuration. Capacity follows account defaults. |
| Fly | Encrypted 1 GB native volume; web/worker, one Machine, attached at Machine creation; no replication. |
| Azure Container Apps | Dedicated Standard_LRS StorageV2 account, classic SMB share with 5 GiB quota, environment registration and app attachment; web only. |
| ECS Express | Encrypted regional EFS, access point, dedicated network permissions and task-definition attachment; web only; metered storage/throughput/transfer. |
| Cloud Run | Dedicated VPC/subnet and BASIC_HDD Filestore, **1024 GiB minimum provisioned capacity**, then NFS attachment; web/worker. |
| DigitalOcean App Platform | Rejected explicitly: this hosting product has no persistent mount support. |
| Vercel Functions | Rejected explicitly: sandbox Drives are not mounts for the Functions hosting product. |

Cloud Run's selected `<region>-a` zone must be independently observed as UP in
the configured region before Filestore creation. Conflicting existing VPC/cache
placement blocks rather than silently moving the workload. Cache removal must
not remove networking still used by the filesystem. NFS on Cloud Run has no
locking support; application UID/share permissions require separate validation.
The provisioned-capacity cost is not equivalent to a small local disk. See
[NFS mounts](https://docs.cloud.google.com/run/docs/configuring/services/nfs-volume-mounts)
and [Filestore tiers](https://docs.cloud.google.com/filestore/docs/service-tiers).

Azure account keys stay inside the provider boundary when registering the share;
they are never binding fields. ECS retains the workload identity and uses a
custom task definition rather than mixing it with Express `primaryContainer`
inputs. Non-idempotent task registration uses one SDK attempt; an ambiguous
response retains recovery intent. EFS denies insecure/wrong-access-point/root
access but does not claim exclusivity against every other same-account IAM
grant. A prepared task revision blocks attachment if the runtime changed in
the meantime. Azure refreshes the app template before attachment, but does not
claim atomic optimistic concurrency. Neither provider substitutes a bucket.

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

The CI deployment contract includes volume intent. Generated deployments preserve
existing mount configuration; this is not filesystem I/O or backup verification.
Run `hv_status`/`hv_plan` after external provider changes. No live resources were
created to validate this feature. Whole-project acceptance results are recorded
in the PR; do not infer them from individual provider tests.

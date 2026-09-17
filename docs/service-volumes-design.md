# Cross-host persistent filesystem design — original audit

The initial Railway slice was not completion of the requested cross-host
feature. This document records the September 16, 2026 pre-implementation audit
before replacing the Railway-shaped shared contract. No resources were created
and no hosted compatibility or filesystem durability was verified by this audit.

## Every registered hosting provider at the original audit

| Hypervibe host | Documented persistent filesystem path | Current feature implementation |
| --- | --- | --- |
| `railway` | Native service volume | Partial draft, contract-tested only |
| `fly` | Native volume attached when creating a Machine | Missing |
| `ecs` (ECS Express Mode) | EFS through a custom Fargate task definition | Missing; does not require switching away from Express |
| `azure-container-apps` | Classic Azure Files SMB or NFS share | Missing |
| `cloudrun` | NFS mount, with managed backing through Filestore | Missing; no NFS locking |
| `digitalocean` (App Platform) | App Platform explicitly does not support volumes | Underlying hosting-product limitation |
| `vercel` (Functions/deployments) | No equivalent persistent mount in this hosting path | Drives are a different Sandbox product, not Functions storage |

Missing implementation is not the same as unsupported provider capability.
Object storage and ephemeral disks must not be substituted for persistent
filesystem mounts to make this table appear complete.

## Independent evidence and counterexamples

- [Railway volumes](https://docs.railway.com/volumes/reference) attach to a
  service. The initial implementation requires project/environment/service IDs
  before disk creation; those fields cannot be a universal target contract.
- [Fly volume API](https://fly.io/docs/machines/api/volumes-resource/) scopes
  disks to an app and region, with explicit capacity. The
  [Machine update contract](https://fly.io/docs/machines/flyctl/fly-machine-update/)
  does not allow attaching a new disk to an existing Machine. Thus creating the
  final Machine first, then creating its disk, is a concrete counterexample to
  the current shared orchestration assumption. Existing-Machine replacement
  needs explicit authority and downtime guidance; never replace it implicitly.
- [ECS Express custom task definitions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-getting-started.html)
  and [Express updates](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-update-full.html)
  accept a Fargate task definition with a `Main` container. This input is
  mutually exclusive with the current `primaryContainer`-based configuration.
  [EFS task volumes](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specify-efs-config.html)
  require separately owned filesystem/access-point/mount-target/network/IAM
  resources. Preserve Express management; do not resurrect hand-built ECS.
- [Container Apps mounts](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts)
  support classic Azure Files, via managed-environment storage and app revision
  configuration. An Azure Blob bucket is not the same resource. SMB is the
  simpler candidate for current environments; NFS adds VNet/security constraints.
  Account-key material must remain inside the provider/secret boundary.
- [Cloud Run NFS mounts](https://docs.cloud.google.com/run/docs/configuring/services/nfs-volume-mounts)
  require network access and do not support NFS locking. A managed solution needs
  Filestore plus explicit network and API prerequisites. Existing `cacheNetwork`
  removal must not remove networking still needed by a filesystem. The
  [Filestore tiers](https://docs.cloud.google.com/filestore/docs/service-tiers)
  and [pricing](https://cloud.google.com/filestore/pricing) require reviewed
  capacity and cost disclosure, not an invisible small-disk default.
- [DigitalOcean App Platform limits](https://docs.digitalocean.com/products/app-platform/details/limits/)
  explicitly rule out volumes. Droplets/Kubernetes would be additional hosting
  backends, not implementation of a missing App Platform API.
- Vercel's [Functions file guidance](https://vercel.com/kb/guide/how-can-i-use-files-in-serverless-functions)
  recommends object storage for persisted writes. Its
  [Drives feature](https://vercel.com/kb/guide/vercel-drives) mounts into
  Sandboxes, a different product. Do not silently change the hosting execution
  model or claim a Blob bucket is a mounted filesystem.

These findings are official documentation plus code inspection. They are not
passing multi-provider lifecycle tests. Implementation regressions still need
observed failures through real serialized provider transports before fixes.

## Required shared lifecycle changes

1. Separate the backing filesystem's scoped identity from its workload
   attachment and observed runtime revision. A created but unattached disk is
   not absent and is not a successfully mounted workload.
2. Use provider-native scope, rather than requiring Railway-shaped project and
   environment IDs. Preserve complete compound identities and per-step recovery.
3. Plan backing storage and attachment explicitly. Support both orderings:
   app → disk → Machine on Fly; service → volume attachment on Railway. Network
   filesystem providers also have explicit IAM/network/storage prerequisites.
   CI must not provision these resources on demand.
4. Declare filesystem semantics, attachment timing, replica/sharing limits,
   capacity constraints and cost notes in provider capabilities. Do not imply
   NFS/SMB, local disks and object-store FUSE have identical locking semantics.
5. Preserve mounts through direct deploy, environment updates, GitHub and
   portable CI, release execution and rollback. ECS's primary-container-only
   paths must support exact reviewed task-definition revisions. All providers
   must verify identity and protect retained data during enclosing teardown.
6. Run one shared acceptance contract across every mount-capable host:
   confirmation, absent/present/unattached/pending/unknown observations, partial
   creation, acknowledged-ID recovery, two environments, zero-write noop,
   retention, and both dependency orderings. Explicitly test rejection for
   actual host limitations. Keep registry, matrix, docs and evidence aligned.

## Approved scope

The user approved persistent mounts for the five hosts with documented paths
and explicit rejection on App Platform and Vercel Functions. Do not add alternate
hosting products. This audit table records the pre-implementation findings;
current implementation constraints and evidence are in `service-volumes.md`.
PR #218 now contains all five native paths and explicit rejection for the two
unsupported hosting products. None has been promoted to live-verified by the
offline implementation or tests.

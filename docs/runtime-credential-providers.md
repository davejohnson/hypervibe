# Runtime credential updates across hosting providers

Reviewed 2026-10-25. The shared contract selects an already-bound workload and
changes only reviewed variable names. It never creates a missing workload,
chooses a namesake, rebuilds desired configuration, changes images or identities,
or removes unrelated values/references. Providers report whether the native write
defers activation or starts a configuration rollout. `scope=secrets` retains its
stricter no-restart contract; credential rotation explicitly reviews native effects.

| Provider | Official native contract | Configuration and activation |
| --- | --- | --- |
| Railway | [Variable upserts](https://docs.railway.com/integrations/api/manage-variables#rotate-secrets), pinned GraphQL `VariableCollectionUpsertInput` | Exact project/environment/service, additive selected values and `skipDeploys`; plaintext readback, later deployment required. |
| Cloud Run | [Service patch](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch), [job patch](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/patch), [revision variables](https://docs.cloud.google.com/run/docs/configuring/services/environment-variables) | Exact project/region/resource and UID/etag; patch only container environment list while retaining all containers and their fields. Service update creates a revision; job update changes the next execution template. References stay references unless that exact key is reviewed. |
| ECS Express | [UpdateExpressGatewayService](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateExpressGatewayService.html) | Exact cluster/service ARN and environment ownership; merge current primary container, preserving secret references and roles. Existing custom task definitions retain all sidecars and task configuration through the existing task revision writer. The native update performs a rolling deployment. |
| Azure Container Apps | [Secrets](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets), [app update](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/update?view=rest-resource-manager-containerapps-2025-01-01) | Exact subscription/resource group/managed environment/app; update only selected existing secret references, or add one secret and its exact env reference. Secret-only updates wait for restart/revision; a changed env-reference template creates a revision. Other secrets, Key Vault references, identity, images, scaling and ingress are preserved. |
| Fly.io | [Staged app secrets](https://docs.fly.io/apps/secrets) | Exact organization/app/Machine binding; vault update only, without Machine mutation. Values are write-only, and acknowledgement is not equality proof. Later managed Machine update activates them. |
| DigitalOcean App Platform | [Component environment variables](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/), [app update API](https://docs.digitalocean.com/reference/api/api-reference/#operation/apps_update) | Exact app/collection/component binding; round-trip app spec changes only selected component env values, preserving unrelated source/image/settings and expressions. Encrypted values are write-only; the native app update deploys configuration. |
| Vercel | [Scoped environment upsert](https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables), [rotation](https://vercel.com/docs/environment-variables/rotating-secrets) | Exact team/account/project binding and native production target; each Hypervibe environment owns its bound project. Selected-key upsert must not remove internal markers or touch preview/development/custom targets. Sensitive values are write-only and activate on a later deployment. |

The regression counterexample is a valid credential update alongside an unrelated
provider reference, image, service identity, sidecar, or runtime setting. General
deploy methods may rebuild those fields and are not credential-update authority.
Tests execute actual REST/SDK serialization using reconstructed official response
shapes. They run under ordinary `npm test`; they do not establish live permissions,
provider convergence timing, or successful business operations.

## Database consumer activation evidence

Credential-specific rollout requirements retain an opaque operation ID and an
encrypted comparison expectation in local state. They preserve the same expected
configuration, service identity, provider scope and original deployment baseline
across retries. A new `SUCCESS` deployment alone cannot clear that requirement.
Activation can be established by an exact deployment's resolved configuration,
or by accepted selected-key synchronization joined to that operation's exact
native or managed deployment. Both paths require complete active deployment
coverage for the selected replacements. Earlier active revisions remain pending.
Write-only values retain unknown current-value comparison even when accepted
synchronization and exact deployment activation are established. Instance
retirement remains separate where the provider observes routing or revisions.

Credential requirements remain pending for `activeDeploymentCoverage: traffic`,
even with an exact native or managed deployment receipt. Routing cutover cannot
prove that older requests or processes have stopped. This currently limits Cloud
Run services, ECS Express, DigitalOcean App Platform and Vercel; it does not alter
ordinary non-credential rollout completion. Instance-backed evidence, exact
selected-key coverage and matching deployment identities remain required as
before for providers that expose them.
These local expectations are excluded from repository binding exports and cannot
be replaced by importing a repository binding file.

| Hosting provider | Independent native evidence boundary | Current database consumer evidence |
| --- | --- | --- |
| Railway | Pinned official GraphQL `deployment(id)` scope and `snapshotId`, `deploymentSnapshot(deploymentId).variables`, `ServiceInstance.activeDeployments`, and `variablesForServiceDeployment`; [deployment actions](https://docs.railway.com/deployments/deployment-actions) distinguish deployment configurations from current settings. | Reconstructed serialized transport covers exact snapshot, scope and resolved string-map validation. Unresolved references, missing/malformed snapshots and failures remain unknown. No live snapshot/process parity or SQL authentication is claimed. |
| Cloud Run | [Revision configuration](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services.revisions) and service traffic/conditions describe distinct revisions; jobs use execution templates. | Exact accepted configuration is joined to the selected revision or immutable execution. Traffic/execution inventory retains previous consumers; unresolved secret references do not become plaintext equality proof. |
| ECS Express | [Service deployments](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html) and task definitions identify deployments; running tasks can reference Secrets Manager. | Accepted selected-key writes retain native deployment identity, or join an exact managed deployment. Active service revisions preserve concurrent consumers; task retirement and resolved external secret values remain separate. |
| Azure Container Apps | [Revisions](https://learn.microsoft.com/en-us/azure/container-apps/revisions) and [secrets](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets) have separate lifecycle and activation behavior. | Accepted secret updates require the corresponding new revision or restart evidence. Exact active revisions and replica counts prevent an already-existing ready revision from proving activation. |
| Fly.io | [Secrets](https://fly.io/docs/apps/secrets/) may be staged before Machine updates. | Acknowledged writes retain their native secret version; managed Machine updates require that minimum version and return exact replacement identities. Machine instance coverage proves activation/retirement separately from unknown write-only value equality. |
| DigitalOcean App Platform | [Deployments](https://docs.digitalocean.com/products/app-platform/how-to/manage-deployments/) use application specifications and component configuration. | Acknowledged writes retain exact native deployment identity and selected-key coverage. Active/in-progress deployments keep earlier consumers pending; encrypted value comparison and individual instance retirement remain separate. |
| Vercel | [Environment variables](https://vercel.com/docs/environment-variables) and [deployments](https://vercel.com/docs/deployments) have separate scopes and lifetimes. | Accepted production-target writes join the exact managed deployment and observed alias targets. Previous routed deployments remain consumers; sensitive value equality and process retirement remain unknown without their own evidence. |

`configurationState=resolved` means the provider snapshot is a string map with
no unresolved Railway reference syntax. The opaque GraphQL scalar does not
validate that map. Runtime-process inspection, fresh authentication with the
application's database/identity/TLS configuration, and application operations
remain separate checks. The snapshot adapter returns private hashes only; public
results omit those inputs. No authentication is inferred from a matching snapshot.
The native database composer retains each service's accepted configuration,
deployment identity and version independently in the existing encrypted plan.
One consumer's write receipt cannot authorize another consumer's activation.

## Activation evidence

A recorded configuration update is separate from deployment selection and instance
retirement. Every adapter now exposes exact native deployment identity when the
provider returns it. `activeDeploymentCoverage` records what the observation
actually covers; omitted identities or coverage remain unknown.

Azure managed credential rollouts derive a stable revision suffix from the accepted
operation and source commit. A new operation creates a fresh revision even when
the application SHA is unchanged; retries retain that operation's revision identity.
Fly retains the accepted secret version for both the immediate `min_version`
readback and the Machine update's `min_secrets_version` barrier. Its
[official client source](https://raw.githubusercontent.com/superfly/flyctl/master/internal/appsecrets/secrets.go)
and [version contract](https://community.fly.io/t/flyctl-update-for-managing-secrets/25878/1)
explain why a new Machine identity alone cannot prove it fetched the replacement.

Vercel managed credential deployments carry an accepted-operation metadata marker.
Both CI paths inspect the complete bounded deployment history before creating or
retrying. A new operation uses the official
[`forceNew=1` deployment option](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)
only when no viable matching deployment exists; a retry reuses only that exact
operation's deployment, including after an uncertain creation acknowledgement.
Every matching identity is read directly before excluding a terminal
[`ERROR` or `CANCELED` attempt](https://github.com/vercel/sdk/blob/main/docs/sdks/deployments/README.md#canceldeployment)
and creating a replacement for the same accepted credential. Blocked or unknown
states, multiple viable identities, and mismatched deployment metadata remain
unresolved. Source SHA alone does not identify a credential replacement.

Fly's accepted secret version is carried through readback (`min_version`),
Machine creation/update (`min_secrets_version`) and the operation-bound release
artifact. A new instance ID alone can still refer to cached secrets. This follows
the [official client source](https://raw.githubusercontent.com/superfly/flyctl/master/internal/appsecrets/secrets.go)
and [Fly's version contract](https://community.fly.io/t/flyctl-update-for-managing-secrets/25878/1).
Missing or mismatched version evidence cannot clear credential activation.

Azure secret-only updates require a fresh revision even when the code and image
are unchanged. Both managed producers use an operation-specific revision suffix,
stable across retries, and wait for that exact ready revision. This prevents an
already-ready revision from being mistaken for activation of a new app secret.

| Provider | Independent observation contract | Coverage |
| --- | --- | --- |
| Railway | Pinned GraphQL service-instance/deployment contract | Existing active deployment records and exact deployment configuration snapshots. |
| Cloud Run | [Service traffic status](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services), [immutable executions](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions) | Services use actual `trafficStatuses`, retaining older weighted routes and zero-percent tagged routes. This proves traffic selection, not that in-flight requests stopped. Jobs use scoped, paginated execution identities and their immutable environment snapshots; old running executions remain active consumers. Updating a Job template does not fabricate execution evidence. |
| ECS Express | [Active configurations](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ECSExpressGatewayService.html) | Current deployment plus every active service revision, including concurrent configurations during gradual rollout. Current configuration hashes belong to the exact selected revision. Active revision coverage is distinguished from individual task retirement. |
| Azure Container Apps | [Revision collection](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps-revisions/list-revisions?view=rest-resource-manager-containerapps-2025-01-01) | Paginated exact-app revisions preserve every active revision or revision with nonzero replicas. Complete replica counts establish instance coverage; incomplete reads do not. Changing an app-level secret does not attribute the update to an already-existing revision. |
| Fly.io | [Machines API](https://docs.machines.dev/) | Exact bound Machine instance versions and native state provide instance coverage. Stored Hypervibe hash metadata is marked `recorded-update`, never presented as current secret-value proof. |
| DigitalOcean | [Deployments](https://docs.digitalocean.com/products/app-platform/how-to/manage-deployments/) | Active and in-progress native deployment identities are retained separately from individual instance retirement. |
| Vercel | [Paginated aliases](https://vercel.com/docs/rest-api/aliases/list-aliases) | Exact project alias targets retain older deployments that still receive routed requests. Alias coverage does not establish process retirement or business-operation success. Missing/ambiguous alias and microfrontend routing evidence stays unknown. Exact service identities and variable presence remain observable when encrypted values are not readable. |

The composed all-hosting regression runs shared credential planning, approval,
apply, inventory, and ordinary secret reconciliation using each real native
credential writer. Its non-Railway observation projection is deliberately synthetic;
separate adapter transport tests exercise native observation and old revision
coverage. Neither test class is a live deployment or application verification.

# AWS and Azure branch releases

AWS and Azure have an implemented GitHub Actions release path. Its admission,
native requests, generated workflow and pinned infrastructure configuration are
covered by ordinary acceptance tests. Live OIDC federation, cloud permissions,
builds and application health have not been qualified by this change. The runner
must be published in a Hypervibe package release before generated workflows can
use it; existing installed versions and already committed workflows do not change.

## Managed path

Set the environment's `deploy.strategy` to `branch`, its exact `deploy.branch`,
and the project's GitHub `gitRemoteUrl`. `hv_launch` uses the ordinary access
setup and reviewed infrastructure plan. The plan adds a separate CI identity
whose GitHub subject names that repository and branch. Access changes and new
billable resources require their exact action confirmation. Manual environments
do not acquire CI identities.

After a complete apply, Hypervibe projects exact native identities from private
engine state into the sanitized `engineCi` binding. A failed or partial apply
clears the CI marker. A successful noop can repair missing bindings without
provider writes. Once complete, `hv_launch` writes
`.github/workflows/hypervibe-release-<environment>.yml` locally. Commit the spec,
bindings and workflow together. The workflow uses a fixed Hypervibe package
version, serializes releases for the environment and saves a value-free receipt.
Inspect and dispatch it through `hv_ci_status` and `hv_ci_trigger`, selecting this
workflow definition; after a successful run, check `hv_health`.

The runner admits the exact committed spec, repository, branch and revision
before requesting cloud credentials. No applied binding produces a neutral
no-deploy result. A stale deployment contract, incomplete native identity or
unreadable prerequisite blocks the release. Credentials come from GitHub OIDC;
cloud keys and engine state are not copied into Actions. It builds one committed
source archive through CodeBuild or ACR Tasks and uses the shared release path
to update existing workloads. It does not create infrastructure or infer its
absence from an error. Failed or unknown steps stop dependent releases.

## Access and build isolation

AWS grants image release access to exact web services (ECS Express Mode), ECS
services and task families. Task-definition reads require AWS's unscoped read permission; new task
revisions, tag preservation and passing the runtime role use the provider's
supported restrictions. Source uploads and CodeBuild access target this
environment's existing build resources. An older setup may need the normal
reviewed boundary-policy update before these permissions take effect.

Azure's owner setup installs two fixed custom roles and allows the local deploy
identity to assign their exact IDs to service principals. It does not let that
identity edit role definitions or assign arbitrary privileged roles. The engine
assigns CI release access at each existing app/job and build access at a dedicated
registry for this environment. This additional Basic registry is billable and
appears in the reviewed plan. The shared registry and its pull grant remain so
currently running images survive the transition. Disabling branch releases
retains stored images until an explicit teardown.

ACR's `scheduleRun` permission applies to a registry, not an individual task, so a
task-scoped identity alone cannot isolate build credentials on a shared registry.
The dedicated registry is required for this reason. See Microsoft's
[ACR Tasks permissions](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers#container-registry-tasks-contributor).

Private-package tokens remain build inputs: CodeBuild reads the exact Parameter
Store reference; the ACR task identity reads the exact Key Vault reference.
Neither path adds the token to runtime secrets or committed CI bindings.

## Remaining limits

This path does not add release-command migrations, production profiles, custom
domains, promotion, rollback or deployment-history listing to AWS/Azure.
Provider-specific refusals remain in force. A receipt establishes what the
runner observed; it does not prove a later scheduled job succeeded or qualify
backup/recovery readiness. Live qualification remains tracked separately from
the offline implementation evidence.

On AWS, a web service with an explicit `startCommand` receives a separate
image with its entrypoint cleared. ECS runs that service's command with
`sh -c`, so the image must contain `sh`. The ordinary image retains the
Dockerfile entrypoint and default command for web services without an override,
workers and scheduled jobs. A single CodeBuild job can publish both images for
one commit. Removing a web override selects the ordinary image again.
When Hypervibe generates the Dockerfile, each web service needs its own
explicit startup command.

Existing AWS environments that add a web override need the reviewed build
project update from `hv_plan scope="infrastructure"` and `hv_apply` before CI
can build the web image. If an older environment needs to create a web
service using Dockerfile defaults, release an existing workload from the
Dockerfile commit before planning that change. This records the source of
the ordinary image. Tests cover the Docker image configurations and ECS
requests offline. Live AWS qualification remains open.
[#717](https://github.com/davejohnson/hypervibe/issues/717)

Private web services still require local releases. This CI runner needs public
HTTP access to verify web health.

Azure's current app/job update API documents JSON Merge Patch without an
`If-Match` condition. Releases re-read the exact template immediately before
changing its image and verify the current image afterward, but a concurrent
infrastructure template change can still race that update. Avoid overlapping an
Azure infrastructure apply with a CI release until Hypervibe has shared
cross-process coordination for those operations. See the native
[Container Apps update contract](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/update?view=rest-resource-manager-containerapps-2024-03-01).

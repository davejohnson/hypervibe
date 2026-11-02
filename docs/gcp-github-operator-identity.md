# Google operator CI without stored cloud keys

The operator's local Google session prepares a dedicated GitHub federation path
through the existing [reviewed continuation](local-cloud-scope-continuation.md).
It does not become a runtime or CI credential. Customer Connect Cloud deployment
continues to use its separately approved hosted broker; the two authorities
cannot be selected together for one target.

The named hosting-provider matrix remains Cloud Run, ECS, Azure Container Apps,
Railway, Fly, DigitalOcean and Vercel. This optional local continuation is declared
only for Cloud Run. AWS/Azure customer federation and their emitted deployment
programs remain separate implementations, not inherited local Google behavior.

Seven explicit actions create the workload identity pool, service account,
provider and custom release role, then grant the role, exact private image
repository access and impersonation trust. Each action has its own confirmation,
native identity evidence and durable attempt. Repository/owner numeric IDs,
repository name, environment, default branch, workflow path and event kind bind
the trust condition. The optional backup workflow is named separately.

The generated program exchanges GitHub OIDC for Google STS credentials and
requests a 15-minute service-account token. It verifies native service-account
identity, response origin, body limits, deadlines and expiry. Neither local ADC
nor a service-account key is written into a workflow or Docker configuration.
Runtime `actAs` is granted only on each prepared workload account. Registry writer
access is on the exact private repository; a separately prepared public helper
repository receives no CI writer grant. Backup control receives object access
only on its reviewed archive bucket, through the separate recovery lifecycle.

Transient CI builds now load the candidate locally before publishing it. The
publication step obtains a fresh token, rechecks the exact registry lifetime,
and verifies the local image ID returned by the build action against the exact
source-derived candidate tag. It pushes within the remaining token lifetime,
then requires a matching immutable repository digest. The former temporary
Docker configuration is removed when the fresh one replaces it; final cleanup
runs on failures too. The existing npm build-secret input is preserved.

The challenged assumption was that a registry login acquired before building
would still be valid when a long build finished. Google's
[requested token lifetime](https://docs.cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken)
and the [Docker build action's load/imageid contract](https://github.com/docker/build-push-action/blob/v6/action.yml)
provide independent evidence. Executing the emitted program with a simulated
28-minute build first failed on an expired pre-build login. The revised program
passes that case and rejects replaced registry/image identities, changed source
and unrelated digest evidence. The SDK/emitted suite now passes 26 cases; the
combined emitted/native release checks passed 78. Docker subprocesses and cloud
transport are substituted in these regressions, so a live registry push remains
part of the approved walkthrough. Legacy unmanaged workflow bytes retain their
existing hash regression.

`githubAccess: disconnect` prepares a distinct reverse frontier: revoke federation
trust, private-registry writer access and the dedicated project-role binding.
It verifies the original native identities and ownership before each write,
preserves unrelated IAM bindings, and reconciles uncertain writes without replay.
After those removals converge, a separate local handoff clears only the matching
CI descriptor. It retains connections, registry and runtime identities, stored
secrets, archive data and separately authorized application access. It does not
claim to invalidate an already issued token immediately or delete every native
identity resource.

Independent evidence is Google's [deployment-pipeline federation contract](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines),
[asynchronous provider creation](https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.locations.workloadIdentityPools.providers/create),
[service-account impersonation](https://docs.cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken),
and [repository IAM](https://docs.cloud.google.com/artifact-registry/docs/access-control).
Native transport fixtures reconstruct those contracts; they are not live Google
observations or full schema validation.

The actual application/SQLite test challenged the assumption that final resource
proof could omit an acknowledged creation operation. Two first-run cases stopped
after pool creation because the durable journal correctly refused to lose the
operation name. Retaining it in completed proof changed both cases from failing
to passing. The same tests exercise complete preparation, local binding and
separately confirmed disconnection, including a lost creation acknowledgement.
The native suite passed 12 cases; SDK, STS and emitted-program checks passed 21,
and runtime-identity checks passed 44. These are focused results, not a substitute
for the final combined acceptance run.

All suites run through ordinary `npm test`. The committed acceptance workflow
runs that command and type checking. A read-only `hv_ci_status` observation on
2026-10-25 verified the required `Hypervibe / acceptance` check on main, no
mandatory human review, and `enforceAdmins: false`. Live GitHub OIDC, Google IAM
propagation, registry uploads and backup execution still require the approved
disposable walkthrough.

The full acceptance run also challenged treating every credential-schema field
as a manual connection input. The owner requires infrastructure identities to be
prepared by the reviewed workflow. The new federation descriptor and mode
appeared in connection forms instead: the existing field regression failed,
and an actual MCP discovery regression separately failed on the internal mode.
Provider metadata now keeps the descriptor and its workflow-only choice out of
manual forms for Cloud Run, Cloud SQL and GCS, preserving both existing sign-in
choices. GCS project identity stays workflow-owned too. The shared form helper,
MCP discovery and apply guidance use the same metadata. All 83 focused checks
across guidance, actual MCP and registry suites pass; type checking passes.
This is interface evidence, not proof of native federation or cloud authority.

## Adding federation after the application is running

The same seven-action installation can now be selected after the original project
and hosting connections have been bound. Preserve the accepted allocation and
continuation fields, then add the exact GitHub repository/owner IDs, default branch,
release workflow and optional backup workflow to the existing continuation. Review
`hv_plan` without deployment inputs; it returns the isolated cloud-scope stage
before unrelated artifact preparation. Existing quota-API and public-registry
ancestry remain authoritative. No new project or replacement hosting is involved.

An explicit provider capability admits only the public `gcpGithubWorkloadIdentity`
addition. Before IAM mutations, the shared lifecycle re-observes the accepted
predecessor and verifies its exact local scope and saved connection configurations.
An existing conflicting CI descriptor blocks installation. The final separately
reviewed binding action adds only the verified descriptor, using a full-binding
compare-and-swap that preserves services, runtime identities, recovery records and
connections. Unknown native outcomes keep the same operation; read-only recovery
remains available after a later denied read, without authorizing writes or a
conflicting binding. This does not broaden the existing combined release/backup
role or add a backup-only identity mode.

The challenged assumption was that GitHub federation must precede hosting binding.
The [official deployment-pipeline contract](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
allows federation in an existing Google project. The actual saved-plan/SQLite/native
transport regression initially returned a cloud-preparation error after successful
hosting binding, instead of the seven separately confirmed identity actions.
A second regression reproduced a completed, bound installation remaining stuck
after a denied IAM read was restored. A third exercised the existing quota-API
prerequisite followed by CI installation: its consumed quota selector was mistaken
for a new request after the first IAM action. Exact predecessor/successor proof now
keeps that quota prerequisite satisfied, including later disconnection. These
checks exercise reconstructed native responses, not a live identity installation. The keyless archive backup pipeline
already consumes the resulting descriptor; helper publication, workflow publication,
GitHub OIDC execution and a verified retained backup/restore remain separate work.

## Exact IAM role reads

Role inspection must use [`projects.roles.get`](https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.roles/get)
with the exact role name and an empty body. The `view=FULL` option belongs to
[`projects.roles.list`](https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.roles/list),
not GET. A bounded native read on 2026-11-02 returned HTTP 400 with that option
and HTTP 404 for the same absent role without it. Neither request made a cloud
change. The failed CI plan saved no installation proposal, so normal replanning
requires neither a journal repair nor a replacement accepted installation.

The challenged assumption was that GET needs the list option to return role
permissions. Strict serialized-transport checks failed through the actual secret
writer, CI preparation and deployment clients; the application/SQLite retry check
also failed on its second plan. Removing only the invalid query fixes those
requests while retaining exact ownership/permission verification and treating
only HTTP 404 as absence. The reconstructed error fixtures are synthetic; the
native diagnostic established status codes, not a Google error-body shape.
These regressions run in ordinary `npm test`, including recovery and disconnection
paths. After the URL-only correction, all 70 focused client/lifecycle checks and
27 saved-plan CI/retry checks passed; type checking passed. They verify the request correction, not a completed federation installation
or successful backup execution; those remain separate live acceptance steps.

# Deployment and recovery

## Plan and apply infrastructure

Read the selected application's desired state and current tool schemas. Express
hosting, databases, storage, queues, domains, DNS, email, CI, schedules, and other
supported managed resources in `hv_spec`. Use `hv_plan` to observe drift and
compute dependencies, then `hv_apply` for the exact reviewed plan.

Preserve explicit user choices. Infer ordinary names and supported reversible
defaults without a questionnaire; obtain only the missing access, ambiguous
ownership/billing choice, or consequential confirmation required by the plan.
Present costs honestly, including uncertainty. An authorization for one action
does not authorize another provider resource or a changed plan.

Stop dependent work after a blocked, failed, pending, or confirmation-required
stage. Report what worked, what stopped, and the next decision. An explicit
bounded `agentInstruction.action="continue"` permits only the stated work.
Broad investigation or iteration requires the user's request and still cannot
bypass resource ownership, confirmation, or secret boundaries.

Provider acknowledgment is not convergence. Verify exact identities and changed
state through Hypervibe's results; unknown observation remains unknown.
Read-only inspection must not adopt repository edits, change desired state, or
write local environment files.

## Deploy or promote a release

Use `hv_deploy` for a plan-gated direct/manual deployment. For managed CI, use
`hv_ci_status` to identify the reviewed workflow, `hv_ci_trigger` to dispatch it,
and `hv_ci_status` to monitor the result. Verify service health after a successful
release. Do not dispatch or inspect managed CI through a code-host connector,
provider CLI, browser, or direct API to work around a Hypervibe blocker.

Ordinary deployment does not require backup setup, an archive bucket or fresh
recovery evidence. Keep backup gaps visible without presenting them as release
prerequisites. Requested backup work uses `hv_plan scope="backups"` and its exact
confirmations; preserving native snapshots and accepted backup programs does not
authorize new resources. Explicit destructive-operation checkpoints retain their
separate prerequisite and confirmation rules.

Ordinary repository changes preserve existing backup programs and never publish
a new one. Plan backup publication for the environment whose backups are
requested, even when the canonical GitHub environment differs or has backups
disabled. That scoped proposal changes only its selected backup program. To
retire a managed program, declare backups disabled and review a backup-scoped
removal; retained data and native snapshots remain untouched.

For a corrected operator helper at the same package version, use the existing
`operatorArtifacts.<name>` declaration's `refreshFrom` with its latest completed
publication's exact `installationId` and `planDigest`. Plan and separately review
the new upload; do not invent another artifact name or replace a retained receipt.
Keep that marker after completion so repeated plans remain noops. A later refresh
names the new completed publication; removed or stale markers block. Reconcile
uncertain uploads through their existing attempts. After verified publication,
select its immutable digest in `backups.runnerImage` and review the backup program
separately; publishing a helper does not update an existing runtime reference.

For an image-only update to existing services using a published operator image,
select those services explicitly in `hv_plan` and set `includeEnvFile: false`.
Hypervibe verifies the exact immutable image and runtime dependencies while
preserving unrelated completed setup records. An expired administrator session
for another cloud is not a reason to repeat that setup. Other runtime changes,
unknown required resources or unfinished setup effects still need their normal
review; do not bypass a blocked plan. Images outside operator publication and
first-time service creation keep their existing deployment path.

For access checks or a supported ownership-metadata repair on existing services,
use `hv_plan scope="runtime-access"` with explicit `services` and
`includeEnvFile: false`. Review only the returned runtime actions; this scope
does not deploy code or run migrations, and does not authorize unrelated cloud
setup. Preserve the successful parts of a partial release. After repairing and
verifying its exact prerequisite, plan only the workloads still awaiting update.
Missing or conflicting ownership evidence is not permission to adopt a resource
by name, replace its identity or edit provider metadata directly.

The existing environment policy and reviewed deployment bindings determine the
release path. Portable managed CI is the normal push-deploy path where
implemented. Do not change deploy-source settings or workflow content outside
the lifecycle, and do not create missing infrastructure from CI.

Preserve exact candidate source/image evidence for releases and release commands.
A branch name or caller-provided digest does not prove provider-resolved source.
Successful staging evidence covers only its actual workloads, integrations, and
data configuration; identify differences before promotion.

Use the application's existing web/worker/cron topology. Background workers on
request-scaled platforms need continuous execution and nonzero capacity; HTTP
health probes are per-service configuration, and jobs have different provider
semantics. Let the current capability/schema express these settings rather than
assuming a provider resource type from the workload label.

## Diagnose, inspect, and adopt

Use `hv_status`, `hv_health`, `hv_logs`, `hv_ci_status`, or the appropriate current
read-only capability for the user's question. Preserve known public URLs and
their environment/source even when DNS is unmanaged. Do not infer a domain or
DNS provider from an application name.

`hv_inspect` performs read-only provider forensics. Start with its advertised
discovery mode if selectors or capabilities are unknown, then use only the exact
supported scope. A same-named resource is a candidate, not proof of ownership.
Duplicate or incomplete identities remain ambiguous. A successful response that
omits necessary evidence cannot establish absence or health.

Use `hv_import` only when the user explicitly wants to adopt existing provider
infrastructure. Present the exact observed resources and mappings, then use its
required confirmation. Do not use import as a repair shortcut that replaces
accepted desired state, or as a way to perform read-only discovery.

Keep diagnostics value-free. Configuration-key presence does not prove active
usage, credential validity, monitoring access, or runtime health. A successful
administrative database connection does not prove the application uses the same
target or credential. Report supported alignment evidence and remaining gaps.

For database credential incidents, distinguish raw references, resolved provider
configuration, selected deployment configuration, fresh SQL authentication and
application operation. `databaseConsumers` includes declared database aliases;
unchanged reference strings do not mean a running workload has current values.
Keep each affected workload pending until its intended deployment configuration
is active and older deployments have drained. Unknown provider evidence is not
proof of completion.

Database authentication belongs to the reviewed credential lifecycle. Its native
probe verifies the selected replacement, role and database; administrative access
does not establish application connection settings, runtime provenance or use.
Separately authorized `hv_db_query` diagnostics can check session identity, but
its managed connection path may require temporary access authorization. Report
that evidence separately from application authentication. Database names and
schemas are distinct. Do not rename either as a credential fix.

Railway database operations do not create public TCP proxies. Existing reachable
endpoints and cleanup of access recorded by earlier operations remain supported.
Without a verified private connection or reachable endpoint, report the access
limitation rather than opening a public port.

If the user explicitly authorizes a private diagnostic connection, an operator
may use Railway CLI in their own terminal. Check `railway connect --help` for
`--ssh`, `--project` and `--environment`; older versions require an upgrade.
The [official CLI v5.27.0 source](https://github.com/railwayapp/cli/blob/v5.27.0/src/commands/connect.rs)
supports this scoped command without changing the linked project:

```sh
railway connect '<verified-service-name>' --project '<project-id>' --environment '<environment-id>' --ssh
```

Independently match the current service name to the exact bound service first:
this command accepts a name, not a service ID. Always pass `--ssh`; bare
`connect` may choose a public proxy. Forced SSH errors do not fall back to public
access. Use the CLI's own authorized session and an already registered local SSH
key. [First-time key registration](https://docs.railway.com/cli/ssh) is a separate
access grant, requiring its own authorization. Exit the database client to close
the local tunnel. No public endpoint is created.

Do not run `--tunnel-only` through agent-captured output: it
[prints passwords and connection URLs](https://docs.railway.com/cli/connect).
Keep this operator terminal workflow separate from Hypervibe automation; do not
collect CLI output, process arguments or connection strings as evidence. A tunnel
or administrative SQL login does not verify application credentials, deployment
provenance or operation. This exception authorizes no SQL mutations, credential
rotation, deployment or other infrastructure changes.

Password rotation requires the dedicated reviewed database credential lifecycle
through `hv_spec`, `hv_plan scope="credentials"`, and exact confirmed `hv_apply`
actions. Updating an initialization variable alone does not change the actual
database password. Resume an uncertain attempt with its retained plan and same
encrypted replacement; do not generate another password or bypass an unsupported
native capability. Production diagnosis does not authorize rotation, deployment,
new access paths, session termination or data changes.

## Operational tasks and recovery

For ordinary repository configuration flags, use
`devops.ci.repositoryVariables` in the existing canonical DevOps selection.
GitHub Actions supports selected non-secret values on an existing external
repository; GitLab CI is not yet supported for this facet. Follow the current
spec schema, plan the canonical environment, and apply only that persisted plan.
Existing variables require explicit `adoptExisting: true`; adoption performs no
provider write, and a different desired value needs another reviewed plan.
Omission preserves values and local ownership. Never put credentials in these
plain spec values. Ownership is local, so another workspace needs explicit
adoption rather than importing a binding as authority.

Inspect a flag through `hv_inspect provider="github" resource="repository-variable"`
with the exact project or scope and optional name. Readback proves configuration,
not workflow execution. A retained uncertain write gets a readback-only recovery
plan; do not clear its journal or repeat the mutation through another tool.
Verify subsequent scheduled or authorized workflow execution separately.

Use supported Hypervibe commands and current action schemas for one-off database
or application tasks. Do not temporarily change a release command to run a data
operation. Preserve the exact environment, provider target, and deployment lock;
an uncertain previous execution must be reconciled before any repeat that might
duplicate effects.

For an explicitly discarded database with completed `freshInitialization`, the
optional `database.freshInitialization.bootstrap: { service, image }` selects a
declared application service and an exact immutable configured image. The image
must be independently observed; this review does not claim a successful release
or a source commit. Preserve the application's existing canonical migration
release command. Run `hv_plan` and confirm its private authentication action,
then plan and confirm the separate schema-bootstrap action. Each action creates
and removes one private temporary task through the supported provider capability.
No public database access or standalone migration command is needed.

Resume retained attempts through their reviewed plans; never clear recovery
markers or rerun an uncertain migration manually. Report authentication,
command exit, task cleanup and application operation separately. A successful
bootstrap preserves application-deployment requirements and any explicit
destructive-operation checkpoint. It does not require ordinary rollout to wait
for backup health. Providers without the exact private task capability remain
unsupported.

For rollback or restore, inspect existing evidence through the supported
Hypervibe workflow before proposing the action. Keep source identity, retained
recovery point, release provenance, and requested destination explicit. Distinguish
configured backups, an available point, compatible evidence, available images,
and a verified restore. None implies the others.

Use `hv_rollback` and the current plan/capabilities when appropriate. Unsupported
provider combinations, missing recovery prerequisites, and unknown observations
remain blockers. Do not reconstruct historical evidence from the current desired
state or replace a retained baseline to make recovery appear possible.

For destruction, use `hv_destroy` or the supported lifecycle plan and require
the exact consequential confirmations. Preserve dependencies and stop after
failed or unknown deletion. Report success only when terminal absence is
verified; a submitted deletion request is not proof that data is gone.

End with the practical outcome, exact public links where available, and any
failed, skipped, pending, blocked, unsupported, or untested part. A command never
attempted because a prerequisite failed is skipped, not failed.

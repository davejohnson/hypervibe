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

### Change a setting without releasing new code

Save the value first, then apply it. Non-secret values go in the environment's
`envVars` through `hv_spec`; secrets go through `hv_plan` `secretRefs` or the
`hv_secrets action="collect"` page, never chat. Review `hv_plan`, then `hv_apply`.

- Google Cloud, AWS and Azure: the apply restarts the services on the image that
  is already running. It never releases new commits, and no deploy is needed.
- Managed-CI environments (existing Railway branch deploys): the value is saved,
  but running services keep the old one until the next deployment. `hv_status`
  reports `restartRequired`. To activate it without new commits, run
  `hv_deploy env=<env> redeployCurrent=true`. It redeploys the exact verified
  image already running through the reviewed workflow, with no build and no new
  commits. The run is labelled as a rollback in the CI provider because it uses
  the same verified restore. Follow it with `hv_ci_status`, then `hv_health`.
  Do not dispatch an older `commit_sha` through `hv_ci_trigger` for this: a
  forward deploy is blocked whenever the spec changed after that commit.

`hv_rollback` is not a restart. It only restores an earlier release and refuses
the one already running. Do not push a commit, re-run a provider deployment or use
a provider console to force a restart. If the deploy workflow needs a sync first,
the tools say so: complete that reviewed `hv_plan`/`hv_apply` before dispatching.

Ordinary deployment does not require backup setup, an archive bucket or fresh
recovery evidence. Read backup coverage through `hv_status` or an explicit backup
plan; ordinary plans do not run recurring-backup health checks or read recovery
archives. Keep backup gaps visible without presenting them as release
prerequisites. To request the cloud's built-in PostgreSQL backups, set
`database.automatedBackups: true` and review the infrastructure plan.
Independent daily backup programs use `hv_plan scope="backups"` and their own
confirmations. Explicit destructive-operation checkpoints retain their separate
prerequisite and confirmation rules.

Ordinary repository changes preserve existing backup programs and never publish
a new one. Plan backup publication for the environment whose backups are
requested, even when the canonical GitHub environment differs or has backups
disabled. That scoped proposal changes only its selected backup program. To
retire a managed program, declare backups disabled and review a backup-scoped
removal; retained data and native snapshots remain untouched.

The managed workflow schedules one backup per day. Each backup verifies its
restore and reports its outcome in GitHub Actions. Inspect the run with
`hv_ci_status` and its receipt artifact when available. To inspect retained
evidence between runs, dispatch the backup workflow with `hv_ci_trigger` and
`inputs: { "operation": "health" }`. The daily-only workflow has no separate
scheduled health checks or GitHub issue alerts. To upgrade an older workflow
that still runs hourly, select the matching published helper digest and
reconcile that environment through `hv_plan scope="backups"`, confirmed
`hv_apply` and review and merge of the proposed files.

The existing environment policy and reviewed deployment bindings determine the
release path. Portable managed CI is the normal push-deploy path where
implemented. Do not change deploy-source settings or workflow content outside
the lifecycle, and do not create missing infrastructure from CI.

Preserve exact candidate source/image evidence for releases and release commands.
A branch name or caller-provided digest does not prove provider-resolved source.
Successful staging evidence covers only its actual workloads, integrations, and
data configuration; identify differences before promotion.

On Google Cloud, `hv_deploy` reports the migration job's outcome separately from
each service's health. When Cloud Run identifies the execution, follow the
result's `hv_logs` arguments to read that run's output. For recent output across
the environment's migration job, use `hv_logs source="release-command"` with
the project and environment and omit `execution`.

Use the application's existing web/worker/cron topology. Background workers on
request-scaled platforms need continuous execution and nonzero capacity; HTTP
health probes are per-service configuration, and jobs have different provider
semantics. Let the current capability/schema express these settings rather than
assuming a provider resource type from the workload label.

## Pause an app or move visitors to a replacement

For a user who wants to copy database or bucket data themselves, use explicit
application maintenance on the source environment:

```json
{ "maintenance": { "enabled": true, "mode": "application" } }
```

Merge this into the existing environment through `hv_spec`, preserving its
hosting, services, database, and storage. Run a full `hv_plan`, apply the reviewed
actions with their required confirmations, and verify the result before the
user starts copying. Hypervibe serves a Cloudflare 503 page and suspends the
declared scheduled jobs, workers, and web services. This pause does not open
database access, change a database write fence, or read, change, or copy bucket
contents. Keep private data access private.

Explain that current application jobs and uploads should finish first. The
pause does not prove that external clients stopped writing or that a persistent
worker completed its current job. GCP native scheduled jobs wait for existing
executions to finish; provider stop/scaling behavior on other workloads is not
evidence of graceful application completion. Report an unknown or pending stop
as incomplete and stop dependent work.

Keep `mode: "application"` explicit: omitted mode retains data maintenance,
including PostgreSQL fencing. Application maintenance blocks automated
`dataMigration`. Later full plans keep an enabled application pause isolated
even when ordinary settings drift. Do not use a service-filtered plan, direct
deployment, or provider tool to restart the app around that boundary. A paused
environment cannot switch hosting providers; prepare a separate target through
its own Hypervibe plan and apply instead.

After the user's manual copy, verify the target app against its intended data
and storage before moving visitors. If the user wants the existing public URL
to reach a prepared `next` environment's public `web` service, set this on the
paused source:

```json
{
  "domainTarget": { "environment": "next", "service": "web" },
  "maintenance": { "enabled": true, "mode": "application", "page": "off" }
}
```

Review and apply the source's full plan, then check the public URL. Hypervibe
keeps a Cloudflare Worker on the source hostname and forwards requests to the
verified target provider HTTPS URL. The source stays paused. Domain ownership,
DNS, and the provider custom-domain attachment remain with the source; do not
describe this as a domain transfer. Keep Cloudflare proxying enabled. Do not
assign the same hostname to the target, chain targets, or bypass an unavailable
target observation. A completed routing action does not prove the copied data
or the target app works; report those checks separately.
Configure the target app for the original public URL and its trusted forwarding
settings. The Worker does not rewrite app-generated absolute URLs or cookie
domains. Verify authentication, redirects, links, and uploads through the
original hostname after switching traffic.
After an uncertain routing result, preserve the requested page/target and saved
transition state. Follow Hypervibe's recovery result before selecting another
target or page; do not clear bindings or retry through Cloudflare directly.

To show the maintenance page again, change `page` to `"active"` while keeping
application maintenance enabled and the target declared, then plan and apply.
This restores the 503 response on the same route without restarting the source
or stopping writes through the target's other endpoints.

To resume the source, remove `domainTarget` and `page` if present and set
`maintenance: { "enabled": false, "mode": "application" }`, then plan, apply,
and verify the source app. Removing maintenance entirely also restores using
the saved mode when no target remains. Hypervibe restores saved workload
settings before removing the route; it does not copy target data back. Explain
any writes made since the switch before proposing a return to the source, and
never call traffic restoration a data rollback. Verify provider and application
results for this move; offline tests are not proof of live compatibility.

## Observe an existing environment on a schedule

When the user requests ongoing cloud runtime observation, set
`runtimeObservation: { "branch": "<default branch>" }` on the selected
Cloud Run, AWS ECS or Azure Container Apps environment through `hv_spec`.
Use `hv_launch stopAfter="infrastructure"` to review access, plan and apply
the observer and native monitoring resources. GitHub runs a separate
observer every five minutes by default. Set `intervalMinutes` to 10, 15 or 30 for a lower polling frequency. Explain the runner usage, retained artifacts
and potential cloud monitoring charges when reviewing costs.
Commit the resulting spec, applied bindings and generated
`.github/workflows/hypervibe-observe-<environment>.yml` to the default
branch. Verify a subsequent scheduled report’s log and job coverage.
Provider read failures or delayed runs can leave a monitoring gap.
To retire it, remove the option, apply the reviewed removal and commit the
binding and workflow changes. Use a released runner that includes the
observer command before enrolling an application.

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
repository. Follow the current
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

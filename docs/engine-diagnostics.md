# Engine workload diagnostics

`hv_logs source=service` and the deployment observations in `hv_health` have
read-only capabilities on the existing AWS and Azure engine connections. These
capabilities have ordinary-CI transport and command coverage; they have not been
validated against live AWS or Azure access. They do not add legacy hosting
lifecycle adapters or claim worker backlog, schedule delivery, or application
operation health.

Apply projects exact native identities from the private retained OpenTofu state
into non-secret service bindings. This also repairs older bindings on a no-op
apply. Missing or unreadable state preserves existing recovery identity; it does
not establish cloud absence. Reads use the persisted ARN/ARM identity and its
environment region. They never discover a replacement by reconstructing the
logical service name. ECS releases retain their returned task-definition ARN.

| Capability | AWS | Azure |
| --- | --- | --- |
| Web logs | Bound ECS group and the web container's exact stream prefix | Exact Container App in its environment's verified Log Analytics workspace |
| Worker/job logs | Bound ECS group and exact container stream prefix | Exact Container App or Container Apps Job in that workspace |
| Web deployment | The exact ECS service's primary rollout and running count | Current revision identity, provisioning and health; an older ready revision cannot establish success |
| Worker deployment | Exact ECS service and primary rollout; zero desired tasks can be converged | Current Container App revision |
| Job execution | Latest retained task for the exact task-definition ARN and cluster | Latest observed execution matching the current container images |

Logs cover the last 24 hours, return at most 500 entries and truncate each message
after redaction to 4,096 characters. AWS reads at most 20 CloudWatch pages;
Azure asks the workspace for a bounded ordered result. Read failures, malformed
responses, repeated/excessive pagination and Azure partial-query errors are
errors, never empty success. `errorsOnly` filters the bounded scan. A missing
log group is an error; a complete empty log query is successful empty evidence.

Deployment reads keep present, absent and unknown distinct. Access errors and
missing fields remain unknown; provider-confirmed missing workloads are reported
as deployment failures with absent presence. AWS task inventory and Azure job
execution inventory are bounded. ECS retains stopped task history only briefly;
no retained execution remains unknown. An active task definition or provisioned
job alone is not a successful execution. Azure execution image correlation does
not prove that unchanged-image configuration was applied to that execution.
Worker/job-only environments report deployment evidence with HTTP checks marked
not applicable. Successful HTTP with unknown deployment evidence is displayed as
unknown, not healthy.

`hv_logs source=build` and `source=deployments` remain unavailable on these engine
connections. The deployment observations described here are part of `hv_health`.
GCP and Railway retain their existing log and deployment-status implementations.

## Provider contracts used

The reconstructed transport fixtures follow these primary API references,
reviewed 2026-11-16. They are not captured cloud responses or pinned-schema
certification. Tests intercept only HTTP transport for the diagnostic clients;
SQLite connection resolution, shared commands, AWS request serialization and
Azure requests execute normally.

- AWS [FilterLogEvents](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_FilterLogEvents.html): empty pages can carry a continuation token; results are ordered oldest first.
- AWS [DescribeServices](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DescribeServices.html) and [failure reasons](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/api_failures_messages.html): exact ARN failures and primary rollout state.
- AWS [ListTasks](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ListTasks.html) and [DescribeTasks](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DescribeTasks.html): exact cluster/family scope, pagination, task-definition identity and limited stopped-task retention.
- Azure Container Apps API `2025-01-01`: [current revisions](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps-revisions/get-revision?view=rest-resource-manager-containerapps-2025-01-01) and [job executions](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/jobs-executions/list?view=rest-resource-manager-containerapps-2025-01-01).
- Azure [Container Apps Log Analytics queries](https://learn.microsoft.com/en-us/azure/container-apps/log-monitoring), [job log queries](https://learn.microsoft.com/en-us/azure/container-apps/tutorial-event-driven-jobs) and [Log Analytics response format](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/api/response-format).

The tests live under `src/tools/__tests__/engine-diagnostics.test.ts` and
`src/application/__tests__/engine-workload-bindings.test.ts`, included by ordinary
`npm test` in `.github/workflows/hypervibe-acceptance.yml`. Shared provider-log,
health, presentation and provider-roster checks cover the retained callers.

## Scheduled runtime observation

For an existing Cloud Run, AWS ECS or Azure Container Apps environment, set
`environments.<environment>.runtimeObservation` through `hv_spec`. This example
selects a repository whose default branch is `main`.

```json
"runtimeObservation": {
  "branch": "main"
}
```

Use a released Hypervibe package that includes `hypervibe ci observe`. Run
`hv_launch` for that environment with `stopAfter="infrastructure"`. Review the
access and infrastructure changes when prompted. Launch uses the existing
applied workloads and can also surface other outstanding desired changes in
the environment. Review the full plan before approving it. To apply an already
prepared AWS or Azure environment separately, use `hv_plan scope="infrastructure"`
and approve the returned `hv_apply` actions. Commit the resulting
`.hypervibe/spec.json`, `.hypervibe/bindings.json` and
`.github/workflows/hypervibe-observe-<environment>.yml` to the verified default
branch. The generated job runs a fixed package version on a GitHub-hosted
runner. It obtains temporary cloud credentials using GitHub OIDC.

| Cloud | Access reviewed during enrollment |
| --- | --- |
| AWS | A separate IAM role can read the environment’s CloudWatch log group and list or describe tasks in its ECS cluster. The role accepts the selected GitHub repository, branch and observer workflow name. Older account setups need an approved change to the maximum permissions of app roles. |
| Azure | A separate managed identity trusts the selected repository’s default-branch OIDC subject. It has Reader access on the applied workloads and Container Apps environment. A Log Analytics Data Reader assignment restricts log access to the container console table and the named workload rows. The owner setup can need permission to assign those two roles. |
| Google Cloud | A separate federated service account can read non-private log entries in the selected Google project. The collector filters to each applied workload. Execution access is confined to the bound Cloud Run jobs. |

The default five-minute schedule requests 288 polls per environment each day. Set `runtimeObservation.intervalMinutes` to 10, 15 or 30 to reduce polling. A 15-minute interval requests 96 polls per day. GitHub
can delay a scheduled run. Each poll uses Actions runner time, artifact storage
and cloud reads. Native dashboards and alert rules can add charges under the
account’s pricing and allowances. Review the resources in the saved plan.
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[AWS CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/),
[Google Cloud Observability pricing](https://cloud.google.com/products/observability/pricing)
and [Azure Monitor pricing](https://azure.microsoft.com/en-us/pricing/details/monitor/).

A successful run publishes `hypervibe-runtime-observation` with one redacted
`<environment>.json` report. Its separate `hypervibe-runtime-cursor` artifact
records progress per source. Check the report’s source statuses for coverage.
A provider failure can leave a source unread even when the report uploaded
successfully. The next poll overlaps the previous window, retries incomplete
sources and reports gaps beyond the available history. ECS retains stopped
tasks briefly. Azure retains a bounded execution history for each job.
Busy log intervals are split into smaller reads, with new evidence checked first. The artifact records coverage gaps if a single timestamp or a sustained error burst exceeds the collection limits. Jobs with incomplete execution history stay unverified.
An Azure job can fail with zero restarts when retries are disabled. The native
restart alarm covers restarts. Use the observer’s execution-history result
to detect that terminal failure. The collector reads error-level logs and
scheduled job outcomes, and compares
declared schedules with observed starts after a grace period. Deployment
events and endpoint health checks are outside this collector’s coverage.

For hosted daily reviews, set `runtimeObservation.hostedReview` to `true` on an environment already imported into the hosted project. The generated workflow sends redacted findings and terminal job results to `https://hypervibe.dev/api/v1/runtime-observations` using a separate GitHub OIDC audience. GitHub retains the report artifact for seven days. Repository readers can download it, including readers of a public repository. Each poll saves its report and cloud checkpoint before attempting hosted delivery, so a hosted outage does not interrupt collection or missed-job checks. GitHub Actions warns when delivery fails. The next poll retries up to 12 prior opted-in reports from the same environment and provider, oldest first, starting after the last acknowledged batch. At five-minute intervals this covers about one hour of consecutive polls. If a report has expired or the backlog exceeds 12 polls, the workflow warns about the resulting hosted coverage gap. The ordinary report artifact remains available for its seven-day retention period.

To retire the observer, remove the environment’s `runtimeObservation` option
with `hv_spec`, then run the same infrastructure review and apply. Commit the
updated bindings and removal of the generated workflow. The shared AWS and
Azure owner permissions stay available for other enrolled environments.

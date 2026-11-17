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
| Web logs | Bound Lambda CloudWatch group | Exact Container App in its environment's verified Log Analytics workspace |
| Worker/job logs | Bound ECS group and exact container stream prefix | Exact Container App or Container Apps Job in that workspace |
| Web deployment | Function state and last update result | Current revision identity, provisioning and health; an older ready revision cannot establish success |
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
- AWS [GetFunctionConfiguration](https://docs.aws.amazon.com/lambda/latest/api/API_GetFunctionConfiguration.html): function state and last update status are separate evidence.
- AWS [DescribeServices](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DescribeServices.html) and [failure reasons](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/api_failures_messages.html): exact ARN failures and primary rollout state.
- AWS [ListTasks](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ListTasks.html) and [DescribeTasks](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DescribeTasks.html): exact cluster/family scope, pagination, task-definition identity and limited stopped-task retention.
- Azure Container Apps API `2025-01-01`: [current revisions](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps-revisions/get-revision?view=rest-resource-manager-containerapps-2025-01-01) and [job executions](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/jobs-executions/list?view=rest-resource-manager-containerapps-2025-01-01).
- Azure [Container Apps Log Analytics queries](https://learn.microsoft.com/en-us/azure/container-apps/log-monitoring), [job log queries](https://learn.microsoft.com/en-us/azure/container-apps/tutorial-event-driven-jobs) and [Log Analytics response format](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/api/response-format).

The tests live under `src/tools/__tests__/engine-diagnostics.test.ts` and
`src/application/__tests__/engine-workload-bindings.test.ts`, included by ordinary
`npm test` in `.github/workflows/hypervibe-acceptance.yml`. Shared provider-log,
health, presentation and provider-roster checks cover the retained callers.

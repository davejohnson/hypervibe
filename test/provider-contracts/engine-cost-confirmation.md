# Engine cost approval evidence

The approval contract is [DG-067](../../docs/development/lifecycle.md#dg-067):
billable changes need exact action-id confirmation, including in-place resizing.
An unrelated image, environment variable, label or backup-window update is the
counterexample to treating every change under `template` or `settings` as a cost
change.

`cost-confirmation.test.ts` reconstructs **synthetic** `tofu show -json` resource
changes using these primary references, reviewed on 2026-11-17. They are not
recorded cloud plans. Tests never fetch these sources.

| Contract | Primary evidence |
| --- | --- |
| Lists/sets become JSON arrays; `after_unknown` marks unknown leaves while `after` may omit them | [OpenTofu JSON format](https://opentofu.org/docs/internals/json-format/#change-representation) |
| Google provider 8.9.0 Cloud SQL size, disk, availability and edition are within `settings` | [Cloud SQL resource](https://raw.githubusercontent.com/hashicorp/terraform-provider-google/v8.9.0/website/docs/r/sql_database_instance.html.markdown) |
| Cloud Run 8.9.0 CPU/memory and CPU allocation are inside the template's container resources; replica bounds are within template scaling | [Cloud Run service](https://raw.githubusercontent.com/hashicorp/terraform-provider-google/v8.9.0/website/docs/r/cloud_run_v2_service.html.markdown) |
| Worker pools use top-level scaling; jobs nest containers below two template blocks | [Worker pool](https://raw.githubusercontent.com/hashicorp/terraform-provider-google/v8.9.0/website/docs/r/cloud_run_v2_worker_pool.html.markdown), [job](https://raw.githubusercontent.com/hashicorp/terraform-provider-google/v8.9.0/website/docs/r/cloud_run_v2_job.html.markdown) |
| AWS 6.70.0 Aurora capacity bounds and pause timing belong to `serverlessv2_scaling_configuration` | [RDS cluster](https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/v6.70.0/website/docs/r/rds_cluster.html.markdown) |
| ECS Express CPU/memory are scalar attributes; scaling is a single-element list of objects | [Pinned schema and `expressGatewayScalingTargetModel`](https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/v6.70.0/internal/service/ecs/express_gateway_service.go) |
| Fargate task CPU/memory are top-level attributes | [ECS task definition](https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/v6.70.0/website/docs/r/ecs_task_definition.html.markdown) |
| AzureRM 5.11.0 PostgreSQL uses scalar `sku_name`, `storage_mb`, `storage_tier` | [PostgreSQL server](https://raw.githubusercontent.com/hashicorp/terraform-provider-azurerm/v5.11.0/website/docs/r/postgresql_flexible_server.html.markdown) |
| Container Apps and jobs nest container CPU/memory under template; apps also have replica bounds | [Container App](https://raw.githubusercontent.com/hashicorp/terraform-provider-azurerm/v5.11.0/website/docs/r/container_app.html.markdown), [job](https://raw.githubusercontent.com/hashicorp/terraform-provider-azurerm/v5.11.0/website/docs/r/container_app_job.html.markdown) |

Ordinary `npm test` runs the real parser, provider mapping, persisted plan and
`ConvergeExecutor` confirmation boundary. Missing or unrelated confirmations
cannot reach the engine handler; an exact action id can. Unknown cost leaves or
ancestors retain confirmation, while unrelated unknown image values do not gain
cost approval requirements. Noops invoke neither mutation handler.

These checks establish local approval behavior and the selected provider path
semantics. They do not establish live billing amounts, successful cloud applies,
or the correctness of every generated provider setting. Existing real-engine
configuration suites remain separate verification.

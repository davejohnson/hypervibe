# Updating selected runtime secrets

`hv_plan scope="secrets"` prepares only explicitly supplied `secretRefs` for
delegated runtime slots in one existing, managed-CI environment. It never loads
bulk dotenv input, generates application secrets, repairs bindings, publishes
workflows, changes backups, advances the applied deployment contract, or deploys.
An omitted scope retains full deployment planning. Backup setup is a separate
explicit scope and is not a release prerequisite.

```js
hv_plan({
  project: "my-app",
  env: "staging",
  scope: "secrets",
  includeEnvFile: false,
  secretRefs: { OPENAI_API_KEY: "dotenv:/absolute/path/.env#OPENAI_API_KEY" }
})
```

Review that plan, then apply its `planId`. The input is frozen and encrypted in
that plan; editing the file afterward does not change an apply. A retry uses a
fresh scoped plan with the explicit reference supplied again. The normal full
planner does not carry deferred secret input through an isolated prerequisite
plan into a later plan.

The shared contract requires complete, exact bound hosting identities; known
selected-key presence/hashes; encrypted plan inputs; and an adapter that can
update only those keys without creating resources or restarting workloads.
Apply revalidates scope, ownership, identities and provider capability. It uses
the existing delegated-secret writer with mandatory deferral, verifies the
selected values before accepting bindings, and reports incomplete writes
honestly. A fresh plan can finish partial updates using the same explicit value
without rewriting services that already match. Provider access remains the
authorization boundary: a declared principal is attribution, not a login ACL.

Secret installation and runtime rollout are separate results. Dispatch the
already accepted workflow with `hv_ci_trigger`, inspect it with `hv_ci_status`,
and verify health afterward. Existing deployment-contract gates remain in
force; a secret-only apply cannot make those prerequisites pass. Backup coverage
and recovery evidence are reported independently from ordinary rollout admission.

## Provider review

Reviewed against official sources on 2026-10-18, before adding admission. The
general `supportsDeferredDeploy` flag permits configuration rollouts and is
insufficient for this contract. Only explicit `supportsDeferredSecretUpdates`
admits this narrower operation. Unsupported below describes Hypervibe's
implementation, not the absence of a native provider feature.

| Hosting provider | Native behavior and scope | Admission in this change |
| --- | --- | --- |
| Railway | Project + environment + service; additive variable upsert with `skipDeploys: true`; verify exact values after acknowledgment. [Variables and rotation](https://docs.railway.com/integrations/api/manage-variables#rotate-secrets), pinned GraphQL schema `VariableCollectionUpsertInput`. | Ready for live validation; real serialized transport and lifecycle tests. |
| Cloud Run | Environment variables belong to a service revision; configuration changes create revisions. [Environment variables](https://docs.cloud.google.com/run/docs/configuring/services/environment-variables). | Unsupported; current writer updates workload revisions. |
| ECS Express | Service ARN in account/region/cluster; updates create a revision and rolling deployment. [UpdateExpressGatewayService](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateExpressGatewayService.html). | Unsupported; current writer delegates to deploy. |
| Azure Container Apps | App secrets can change without a revision, but environment references belong to revisions. [Manage secrets](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets). | Unsupported; current writer delegates to deploy rather than a proven secret-only operation. |
| Fly.io | App-scoped staged secrets can wait for a later Machine update. [Secrets](https://docs.fly.io/apps/secrets). | Unsupported; current writer also updates Machines; staged-secret observation/recovery needs separate implementation. |
| DigitalOcean App Platform | App/component env entries are part of the app spec. [Environment variables](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/). | Unsupported; no proven no-rollout contract in the current app-spec writer. |
| Vercel | Project/account/target-scoped variables affect new deployments. [Secret rotation](https://vercel.com/docs/environment-variables/rotating-secrets). | Unsupported until exact selected-environment and value-verification/retry contracts are covered. |

Tests must pin this named roster against the hosting registry and the adapter
capability flags. Offline schema validation cannot prove provider permissions,
live visibility timing, workload behavior, or successful application use of a
new external credential.

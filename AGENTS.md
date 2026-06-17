# Agent Notes

Hypervibe is an infrastructure creation, migration, and destruction orchestrator.
It is not a loose collection of imperative provider functions.

Treat the desired-state loop as the product center:

1. `hv_spec_set` defines infrastructure intent.
2. `hv_plan` observes live provider state, checks required connections, computes drift, orders dependencies, and surfaces warnings or blocked work.
3. `hv_apply` converges from a specific plan, rejects stale plans, records receipts, and confirm-gates destructive or billable actions.
4. `hv_status` verifies convergence and reports drift.

Desired infrastructure state is repo-backed when Hypervibe runs inside a git worktree:

- `.hypervibe/spec.json` is the committed source of truth for infrastructure shape.
- `.hypervibe/bindings.json` stores non-secret provider identity bindings needed for team members to observe the same live resources.
- Local SQLite remains a cache/history store for revisions, runs, receipts, and local credentials.

When adding capabilities that create, mutate, purchase, migrate, or destroy infrastructure, default to modeling them in the spec and plan/apply flow. Use separate imperative tools only for read-only inspection, explicit operational actions, or narrow escape hatches; they should not become the primary path for lifecycle-managed infrastructure.

Provider credentials and required external connections should be discovered as early as possible from the spec and reported before apply. Prefer `credentialsRef` with exported environment variables or local JSON files; raw credentials in chat are still accepted when the user intentionally chooses that path.

For push deploys, `deploy.trigger: "ci"` is the portable default. It means Hypervibe manages generated GitHub Actions workflows that call provider APIs directly. Do not switch a project to `deploy.trigger: "native"` just to avoid missing CI/package/image credentials; that changes the desired infrastructure contract. Provider-native deploys are an explicit opt-in and may require provider-specific external app access such as the Railway GitHub App.

Do not introduce dependencies on provider CLIs for infrastructure operations. Hypervibe should use its provider adapters and recorded connections so state, audit history, and drift detection stay coherent.

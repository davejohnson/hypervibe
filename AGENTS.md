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

Connection guidance is part of the product contract, not incidental copy. Every provider or secret-manager connection should have a `ConnectionGuidance` entry in `src/domain/services/connection-guidance.ts`, and token/permission errors should route through `formatConnectionGuidance(...)` whenever possible.

When adding or changing token guidance, include all of these details:

- The exact credential kind, including distinctions that matter operationally, such as user token vs account token, classic PAT vs fine-grained PAT, service account JSON vs access token, or read token vs API-management token.
- The official URL where the user creates or reviews that credential. If there are multiple valid token types, include the URL for each and say which use case needs which token.
- The exact scopes, roles, IAM permissions, or product permission toggles required, including resource scoping such as repo, zone, project, account, team, or organization.
- The expected shape/prefix/caveats when helpful, such as token prefixes, one-time-download keys, required companion ids like `accountId`, package-read tokens, or credentials that cannot support a feature.
- A safe `hv_connect` example using `credentialsRef` (`env:...`, `dotenv:/absolute/path/.env#KEY`, `file:/absolute/path`, or a secret-manager ref). Use `credentialsMap` when a provider needs multiple fields.

Tests should fail if new provider guidance omits these basics. Update `src/domain/services/__tests__/connection-guidance.test.ts` and add provider-specific verification-error assertions for ambiguous or commonly miscreated tokens.

For push deploys, `deploy.trigger: "ci"` is the portable default. It means Hypervibe manages generated GitHub Actions workflows that call provider APIs directly. Do not switch a project to `deploy.trigger: "native"` just to avoid missing CI/package/image credentials; that changes the desired infrastructure contract. Provider-native deploys are an explicit opt-in and may require provider-specific external app access such as the Railway GitHub App.

Do not introduce dependencies on provider CLIs for infrastructure operations. Hypervibe should use its provider adapters and recorded connections so state, audit history, and drift detection stay coherent.

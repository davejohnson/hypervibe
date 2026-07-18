# Agent Notes

Read `ARCHITECTURE.md` before changing lifecycle, provider, plan/apply, deploy, database migration, DNS/domain, CI, connection, or secret-handling code. That file is the source of truth for Hypervibe's infrastructure model.

Hypervibe is an infrastructure creation, migration, and destruction orchestrator. It is not a loose collection of imperative provider functions.

Core rules for coding agents:

- Keep the desired-state loop central: `hv_spec_set` defines intent, `hv_plan` computes drift and blocked work, `hv_apply` converges a specific plan, and `hv_status` verifies convergence.
- Lifecycle infrastructure changes belong in spec/plan/apply. Do not hide creates, attaches, purchases, migrations, deploy-source changes, DNS changes, schedules, or destroys inside CI, diagnostics, or helper tools.
- Keep provider behavior behind the provider boundary. Generic plan/apply/services/tools code should route through adapter capabilities and provider registry metadata, not provider-name branches or direct provider adapter imports.
- Report honestly. Do not return success unless provider receipts, health checks, logs, or live observation prove the intended state. Use explicit failed/skipped/pending/blocked receipts for partial progress.
- Work stage-by-stage. After any blocked, failed, pending, or confirmation-required Hypervibe result, stop and report what worked, what failed, and the next decision needed from the user. Do not keep trying alternate tools, bypasses, or provider-specific workarounds unless the user explicitly asks you to investigate broadly or keep iterating.
- Use `hv_inspect` for read-only provider forensics. Use `hv_import` only when the user explicitly wants to adopt existing provider infrastructure into Hypervibe local/repo state.
- Secrets never cross output boundaries. Accept them through `credentialsRef`, encrypted plans, or verified connections; do not print them in tool output, warnings, logs, receipts, specs, or snapshots.
- Prefer `credentialsRef` with exported environment variables, `dotenv:` references, local JSON files, or secret-manager refs when asking users for credentials. Raw credentials in chat are still accepted when the user intentionally chooses that path.
- Token and permission guidance must include the exact credential type, official creation URL, required permissions/scopes, resource scope, caveats, and a safe `hv_connect` example.
- For push deploys, `deploy.trigger: "ci"` is the portable default. Provider-native deploys are explicit opt-in and may require provider-specific external app access.
- Inspect Hypervibe-managed GitHub Actions deploys through `hv_ci_status`: list workflows, then runs, jobs, and bounded log tails as needed, followed by `hv_health` after success. Do not bypass Hypervibe with `gh`, GitHub connectors/apps, browser/UI inspection, or direct GitHub API calls; if `hv_ci_status` is blocked, stop and report its connection/error guidance.
- Do not use temporary release-command changes for one-off data operations. Use declarative `database.seedCommand` for first seed/bootstrap and `hv_db_migrate` for explicit data operations.
- Do not introduce dependencies on provider CLIs for infrastructure operations. Use provider adapters and recorded Hypervibe connections so state, audit history, and drift detection stay coherent.

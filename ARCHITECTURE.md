# Hypervibe Architecture

Hypervibe is an infrastructure creation, migration, and destruction orchestrator.
It is not a loose collection of imperative provider functions.

## Product Model

Treat the desired-state loop as the product center:

1. `hv_spec_set` defines infrastructure intent.
2. `hv_plan` observes live provider state, checks required connections, computes drift, orders dependencies, and surfaces warnings or blocked work.
3. `hv_apply` converges from a specific plan, rejects stale plans, records receipts, and confirm-gates destructive or billable actions.
4. `hv_status` verifies convergence and reports drift.

When adding capabilities that create, mutate, purchase, migrate, deploy, schedule, or destroy infrastructure, default to modeling them in the spec and plan/apply flow. Use separate imperative tools only for read-only inspection, explicit operational actions, or narrow escape hatches; they should not become the primary path for lifecycle-managed infrastructure.

Domain, DNS, registrar, hosting, database, object storage, queues, deploy-source, CI deploy, and recurring job changes are lifecycle infrastructure. Do not hide those mutations inside CI, diagnostics, or helper tools; add them to desired state, compute them in `hv_plan`, and converge them in `hv_apply`.

Read-only provider forensics belong in `hv_inspect`. Adoption of already-existing provider infrastructure into Hypervibe local/repo state belongs in `hv_import` and must be explicit, mapping-driven, and confirmation-gated. Do not use `hv_import` as a generic read tool.

## State Ownership

Desired infrastructure state is repo-backed when Hypervibe runs inside a git worktree:

- `.hypervibe/spec.json` is the committed source of truth for infrastructure shape.
- `.hypervibe/bindings.json` stores non-secret provider identity bindings needed for team members to observe the same live resources.
- Local SQLite is a cache/history/secrets store for revisions, runs, receipts, and local credentials.
- Provider APIs are observed live state.

Do not treat cached local state as proof of convergence when live observation is available.

## Code Map

- `src/tools/`: the pinned `hv_*` MCP tool surface, registered in `src/server.ts` through `ToolContext`; all responses use the `toolSuccess`/`toolError` envelope from `src/tools/respond.ts`.
- `src/domain/spec/`: the desired-state document (`ProjectSpec`), revisioned in the `project_specs` table through `SpecStore`.
- `src/domain/plan/`: the reconciliation engine: observe live state, pure `diffEnvironment`, `ConvergeExecutor`, and the planId handshake.
- `src/adapters/providers/`: provider-owned API integrations and provider-specific lifecycle behavior.
- `src/domain/services/`: orchestration services that sequence capabilities without owning provider API quirks.
- `src/adapters/db/repositories/`: SQLite data access; JSON columns should be validated through `parseJsonColumn`.

Legacy `*.tools.ts` files that still exist but are not registered in `server.ts` are internal helper libraries pending extraction. Do not register them or add new tools there.


## Repository Collaboration

Repository collaboration setup is lifecycle development infrastructure. GitHub issue labels, issue templates, PR templates, branch protection, and deploy-promotion guardrails should be expressed in the project spec and converged through `hv_plan`/`hv_apply`. Do not add one-off setup tools for these paths unless they are read-only inspection or explicit repair operations.

Collaborator invitations are guidance-only by default. If Hypervibe ever mutates repository access, that must be confirm-gated, permission-audited, and represented as desired state rather than hidden inside a helper tool.

## Provider Boundary

Keep provider behavior behind the provider boundary. Generic orchestration code in `src/domain/plan`, shared `src/domain/services`, and shared `src/tools` must not grow provider-name branches or direct imports from `src/adapters/providers/<provider>` just to express hosting behavior.

Provider-specific logic belongs under `src/adapters/providers/<provider>/...` and should be exposed through:

- adapter capabilities,
- provider registry metadata,
- provider-owned helper modules,
- or a narrow provider-owned service.

Provider adapters own provider quirks:

- API endpoints and API-specific request shapes,
- generated provider CI steps,
- credential-to-secret mapping,
- log/build/deploy semantics,
- polling and terminal-state rules,
- verification DNS record shapes,
- retry behavior,
- provider-specific error enrichment.

Generic orchestration owns sequencing and policy:

- ordering dependencies,
- enforcing confirmations,
- freezing encrypted plan inputs,
- routing actions by capability,
- producing provider-neutral receipts,
- and preserving the spec/plan/apply contract.

Product-specific surfaces such as SendGrid email setup or Stripe payments may stay opinionated when they are not part of generic infrastructure reconciliation.

## Platform Bindings

Environments store provider bindings in `platformBindings` using generic keys only:

```json
{
  "provider": "railway",
  "projectId": "...",
  "environmentId": "...",
  "services": {
    "api": {
      "serviceId": "...",
      "url": "...",
      "customDomains": ["..."]
    }
  }
}
```

Provider-specific legacy binding names such as `railwayProjectId` and `railwayEnvironmentId` were migrated away in SQLite migration 7.

## Plan Honesty

Plan honesty beats optimistic UX. `hv_apply`, `hv_deploy`, CI helpers, and provider task runners must not report success unless provider receipts, health checks, logs, or a follow-up observe prove the intended state.

Partial progress should be returned as explicit `succeeded`, `failed`, `skipped`, `pending`, or `blocked` receipts with the actionable next step. Do not hide provider errors behind generic "bootstrap failed" or "problem processing request" messages when logs, trace ids, or step details are available.

Hypervibe should be stage-gated by default. A failed, blocked, pending, or confirmation-required stage is a stop point for autonomous agents: report which stages worked, which stage stopped progress, and what user decision or credential is needed next. Do not encourage agents to keep trying alternate tools, direct provider calls, or one-off workaround paths unless the user explicitly asks for broad investigation or repeated retries.

The shared tool response envelope supports this with `agentInstruction`. Use it to tell agents when to `stop_and_report` or `ask_user`, especially for missing connections, failed receipts, provider errors, pending seed/deploy steps, and confirm-gated actions.

## Connections And Secrets

Provider credentials and required external connections should be discovered as early as possible from the spec and reported before apply. Prefer `credentialsRef` with exported environment variables, `dotenv:` references, local JSON files, or secret-manager refs; raw credentials in chat are still accepted when the user intentionally chooses that path.

Secrets never cross output boundaries. Secret values may be accepted through `credentialsRef`, encrypted into plans, or stored as verified connections, but they must not be printed in tool output, committed specs, warnings, logs, receipts, or test snapshots.

Connection guidance is part of the product contract, not incidental copy. Every provider or secret-manager connection should have a `ConnectionGuidance` entry in `src/domain/services/connection-guidance.ts`, and token/permission errors should route through `formatConnectionGuidance(...)` whenever possible.

When adding or changing token guidance, include all of these details:

- The exact credential kind, including distinctions that matter operationally, such as user token vs account token, classic PAT vs fine-grained PAT, service account JSON vs access token, or read token vs API-management token.
- The official URL where the user creates or reviews that credential. If there are multiple valid token types, include the URL for each and say which use case needs which token.
- The exact scopes, roles, IAM permissions, or product permission toggles required, including resource scoping such as repo, zone, project, account, team, or organization.
- The expected shape, prefix, or caveats when helpful, such as token prefixes, one-time-download keys, required companion ids like `accountId`, package-read tokens, or credentials that cannot support a feature.
- A safe `hv_connect` example using `credentialsRef` (`env:...`, `dotenv:/absolute/path/.env#KEY`, `file:/absolute/path`, or a secret-manager ref). Use `credentialsMap` when a provider needs multiple fields.

Tests should fail if new provider guidance omits these basics. Update `src/domain/services/__tests__/connection-guidance.test.ts` and add provider-specific verification-error assertions for ambiguous or commonly miscreated tokens.

## Delegated Runtime Secrets

Delegated runtime secrets are lifecycle-managed slots, not ordinary environment variables and not provider connections:

- `ProjectSpec.secrets` declares the environment-variable name, responsible principal, target environments, required/optional behavior, and preserve-only drift policy. It never contains a value.
- `hv_plan secretRefs={...}` is the only write input. References are resolved locally, values are encrypted into that specific plan, and the plan action/preview contains only key names and non-secret metadata.
- Declared keys are excluded from deploy env files and rejected from ordinary `envVars` overrides. An owner's local `.env` must never silently become the desired value for a delegated slot.
- Missing, unaccepted, drifted, or newly reassigned required slots produce `inputRequired`. The plan remains inspectable but `hv_apply` must reject it before connection checks or provider mutations.
- A successful provider receipt records `delegatedEnvBindings` metadata in environment bindings: key name, principal, SHA-256 value hash, timestamp, apply run id, and action id. The value itself is never stored in repo bindings or receipts.
- Live observation compares provider hashes against the accepted hash. Matching values are preserved without needing the secret locally. Drift is reported and preserved until a new explicit plan input is supplied.

`.hypervibe/spec.json` and the sanitized `.hypervibe/bindings.json` make this state reconstructible after a local database or checkout is lost. Provider connections and encrypted in-flight plans remain local and must be recreated.

In the no-service model, `principal` is declarative attribution, not authenticated authorization. Git review/branch protection and provider-scoped membership enforce who may change the spec and mutate infrastructure. A local principal or collaborator edit cannot grant a Railway/GCP/GitHub role, but a caller who already holds provider mutation credentials can still change provider state. Do not treat delegated metadata as a centralized ACL or automatically apply unreviewed changes with privileged credentials; authenticated principal enforcement would require a trusted service or signed attestation.

## Deploy Env Files

Local `.env` files are deploy input candidates, not a raw publish list. Prefer `.env.<environment>` over `.env` when present. When an environment deploy/plan uses the default repo convention and `.env` exists but `.env.<environment>` does not, Hypervibe creates `.env.<environment>` from `.env` before loading deploy vars. When both files exist, Hypervibe may copy newly added base `.env` keys into `.env.<environment>`, but it must preserve environment-specific values instead of overwriting them.

Keep env-file handling policy-driven through the environment spec (`envFile.mode`, `include`, `exclude`):

- default to high-confidence runtime keys,
- skip provider/control-plane credentials,
- skip local-looking values such as `localhost`, `127.0.0.1`, `0.0.0.0`, `host.docker.internal`, `.local`, and `.internal`,
- warn with key names for ignored, excluded, or skipped keys,
- surface the env file path in plan previews,
- never let stale local values override Hypervibe-managed infrastructure env vars such as database or queue URLs.

## Runtime Environment Rollouts

Environment-variable desired state is additive/preserve-only by default.
Omission never means deletion because provider observation may be partial and
live variables may be intentionally managed outside ordinary `envVars`.

Deletion uses `EnvironmentSpec.removeEnvVars` as an explicit durable tombstone:

- validate names and reject collisions with `envVars`, env-file includes,
  delegated secret slots, overrides, and Hypervibe-managed database, queue,
  storage, or source-integration keys;
- plan only keys observed live (or locally bound keys when observation is
  unavailable);
- emit key names and presence/absence only, never values;
- require per-action confirmation;
- route apply through the provider adapter's `deleteEnvVars` capability;
- keep the applied-spec hash dependent on successful removal.

Renames are two-release operations. First add the replacement and deploy
compatible code while preserving the old key. Only a later spec may tombstone
the old key. Planning must reject removals while ordinary service
configuration is not converged; provider-side variable deletion can create a
revision or redeploy the current image even when exact-SHA CI owns the next
code release.

For `deploy.strategy: "branch"` with `trigger: "ci"`, generic orchestration
passes a deployment-deferral option only to adapters that declare the
capability. It means provider configuration may converge, but the adapter must
not independently source or build new application code for an already-bound
service:

- Railway stages variable writes with deploys skipped and suppresses its
  explicit service redeploy.
- Cloud Run uses the existing service/job image while reconciling its
  revision-scoped configuration. The exact-SHA workflow remains the next code
  release boundary.

Do not run deploy-status or HTTP health checks against the configuration pass;
the later CI run and `hv_health` own that verification. New resources with no
existing image may still require provider bootstrap before CI can target them,
and receipts must report that honestly.

## CI And Push Deploys

For push deploys, `deploy.trigger: "ci"` is the portable default. It means Hypervibe manages generated GitHub Actions workflows that call provider APIs directly.

The standard team workflow is:

1. short-lived feature branches,
2. pull request into `main`,
3. checks on the pull request,
4. merge to `main` auto-deploys staging,
5. production is manually promoted from `main`, ideally by passing the exact commit SHA that already passed staging.

Do not default to a long-lived `staging` branch. `main` is the accepted-code branch, staging is the deployed preview of `main`, and production is a deliberate manual promotion. Generated production deploy workflows must not run from push events by default; they should use `workflow_dispatch` and support a `commit_sha` input.

Do not switch a project to `deploy.trigger: "native"` just to avoid missing CI, package, or image credentials. That changes the desired infrastructure contract. Provider-native deploys are an explicit opt-in and may require provider-specific external app access such as the Railway GitHub App.

Generated provider CI workflow steps belong under provider-owned modules and are exposed through provider registry metadata. Generic GitHub orchestration should assemble workflows, sync files/secrets, inspect runs/logs, and diagnose failures without owning provider API scripts.

Generated workflows must gate image deployment on the environment-scoped
`HYPERVIBE_APPLIED_SPEC_HASH` GitHub Actions variable. The desired hash covers
only that environment plus its applicable delegated-secret declarations.
`hv_plan` models updating this marker as the final dependency and `hv_apply`
updates it only after every preceding action completes. This preserves
automatic code-only staging deploys while preventing a changed desired-state
contract from deploying before reconciliation. Missing, failed, pending, or
unconfirmed dependencies must leave the previous marker intact.

`hv_ci_status` is the authoritative observation path for Hypervibe-managed GitHub Actions deploys. Agents should use it to inspect workflows, runs, jobs, and bounded log tails, then use `hv_health` after a successful run. They must not bypass it with `gh`, GitHub connectors/apps, browser/UI inspection, or direct GitHub API calls; a blocked `hv_ci_status` result should surface its connection/error guidance and stop the stage.

## Database Tasks And Seed Data

Do not use temporary release-command changes to run one-off data operations. Release commands are durable deploy-time schema configuration.

Provider-to-provider data moves belong in `hv_db_migrate mode="move"`.

Fresh-environment seed/bootstrap data belongs in desired state as `database.seedCommand`. It should plan a visible one-shot seed action, run through the provider-neutral environment task runner during `hv_apply`, and record completion on the database component only after terminal success.

`hv_db_migrate mode="seed"` is only for explicit re-runs or repair operations and must be confirm-gated, masked, and audited.

## New Provider Checklist

New provider support needs a full contract, not a name in an enum. Add or confirm:

- provider registry metadata,
- credential schema,
- connection guidance with exact token type, URL, permissions, and examples,
- adapter capability flags,
- observe behavior and partial-observe semantics,
- diff/apply behavior,
- CI workflow behavior if supported,
- log/build/deploy inspection behavior if supported,
- domain attach behavior if supported,
- database/env-var wiring behavior if supported,
- tests that prove unsupported features fail with clear guidance.

## Tool And CLI Policy

Do not introduce dependencies on provider CLIs for infrastructure operations. Hypervibe should use its provider adapters and recorded connections so state, audit history, and drift detection stay coherent.

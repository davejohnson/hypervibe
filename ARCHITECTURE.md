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

## Project Runtime Desired State

The top-level `runtime` field declares the project runtime used by
Hypervibe-generated build and automation paths. It is a typed contract such as
`{ "kind": "node", "version": "24" }` or
`{ "kind": "python", "version": "3.13" }`; it is not the runtime used to
execute Hypervibe itself.

- A repository-owned Dockerfile remains authoritative and is never rewritten
  from `runtime`. When no Dockerfile exists, generated CI/provider builds use
  the declared runtime image and the matching package manifest conventions.
- Migration setup, project build jobs, and managed checks with no explicit
  same-kind version inherit the project runtime. A check-level version remains
  an intentional override.
- Hypervibe-owned isolated helpers, such as the App Store release runtime, keep
  their own runtime contract and must not inherit project language settings.
- Runtime changes are part of each environment's deployment contract and are
  projected into local service build state during apply. Because hosting APIs
  generally cannot observe the base runtime directly, that drift is reported
  as unverified rather than falsely presented as provider-confirmed.
- Specs that omit `runtime` preserve the historical Node 20 generated-build
  behavior for compatibility. Hypervibe does not silently add the field or
  upgrade existing projects; selecting a new runtime is an explicit spec
  change reviewed through plan/apply.

## Code Map

- `src/application/`: the transport-neutral command registry, command context, result envelope, provider bootstrap, and shared orchestration entrypoint.
- `src/interfaces/mcp/`: the MCP registration/response adapter. It exposes the canonical `hv_*` ids without owning command behavior.
- `src/interfaces/cli/`: the human and JSON CLI adapter. It parses friendly command paths into the same registry used by MCP.
- `src/tools/`: transport-neutral command group declarations retained under their historical filenames while they are moved incrementally; they must not import MCP.
- `src/domain/spec/`: the desired-state document (`ProjectSpec`), revisioned in the `project_specs` table through `SpecStore`.
- `src/domain/plan/`: the reconciliation engine: observe live state, pure `diffEnvironment`, `ConvergeExecutor`, and the planId handshake.
- `src/adapters/providers/`: provider-owned API integrations and provider-specific lifecycle behavior.
- `src/domain/services/`: orchestration services that sequence capabilities without owning provider API quirks.
- `src/adapters/db/repositories/`: SQLite data access; JSON columns should be validated through `parseJsonColumn`.

Legacy `*.tools.ts` files that are not included by `createCommandRegistry` are internal helper libraries pending extraction. Do not expose them through an interface.

## Interface Boundary

MCP and CLI are adapters over one command application layer:

```text
CLI ─┐
     ├─ command registry/context/results ─ domain plan/services ─ providers
MCP ─┘
```

- Define a command once with its canonical id, CLI path, description, Zod input schema, safety metadata, and handler.
- Interface code may parse, render, prompt, and translate protocol envelopes. It must not contain provider calls or infrastructure orchestration.
- The command runner owns validation, error conversion, redaction, and the structured result envelope. Secrets must be redacted before any interface sees a result.
- MCP `structuredContent` and CLI `--json` expose the same redacted command envelope.
- The `hypervibe` no-argument entrypoint remains MCP-compatible. Human CLI commands use explicit arguments; `hypervibe mcp` and `hypervibe-mcp` are explicit MCP entrypoints.
- A future HTTP adapter may use this boundary, but remote auth, locking, state ownership, and secret custody are separate product decisions. Do not introduce an unauthenticated remote interface.


## Repository Collaboration

Repository collaboration setup is lifecycle development infrastructure. GitHub issue labels, issue templates, PR templates, branch protection, and deploy-promotion guardrails should be expressed in the project spec and converged through `hv_plan`/`hv_apply`. Do not add one-off setup tools for these paths unless they are read-only inspection or explicit repair operations.

Collaborator invitations are guidance-only by default. If Hypervibe ever mutates repository access, that must be confirm-gated, permission-audited, and represented as desired state rather than hidden inside a helper tool.

Do not model collaborators as permanent Hypervibe operator/contributor roles.
The current chat task determines the required capability. Any checkout can
read committed desired topology and non-secret bindings, and may check public
bound endpoints without provider credentials. Exact drift, private logs, and
provider mutations require a verified connection on the machine performing
that operation.

Missing provider access is a task boundary, not a reason to grant membership
automatically. Offer either to connect credentials the user already controls
or to prepare a value-free handoff naming the provider, scope, environment,
and blocked task for the person who manages that access. A project owner can
keep provider control and execute the resulting plan; add a collaborator to a
provider only when they truly need independent mutation authority.

This access model does not require a hosted Hypervibe control plane, shared
drift service, or secret relay. API-key transfer is initially an external human
workflow: the key owner may supply it out of band for the infrastructure owner
to store through a safe local reference, or both may use an existing shared
secret manager such as 1Password. Hypervibe records only the delegated slot
and value-free handoff metadata.

## Provider Boundary

Keep provider behavior behind the provider boundary. Generic orchestration code in `src/domain/plan`, shared `src/domain/services`, and shared command modules must not grow provider-name branches or direct imports from `src/adapters/providers/<provider>` just to express hosting behavior.

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

## Reconciliation Safety Invariants

A persisted plan is an authorization boundary, not just a progress preview.
Every provider mutation during `hv_apply` must be attributable to one reviewed,
non-noop action:

- An action handler may mutate only the resource and operation named by that
  action. Shared helpers must not create, repair, attach, deploy, or destroy
  unrelated resources from the wider spec.
- A noop action must cause zero provider mutations. If live state exists but
  Hypervibe lacks its local identity binding, plan an explicit adoption or
  binding-reconciliation action; do not call it noop and do not create a
  replacement during another action.
- Dependencies must be explicit plan edges. If service configuration requires a
  database, queue, storage bucket, domain, or secret first, plan that action and
  make the service action depend on it instead of ensuring the prerequisite
  imperatively.
- Receipts are action-scoped evidence. Do not reuse a whole-environment
  bootstrap result as proof that several distinct actions succeeded.

Observation is tri-state: present, absent, or unknown. Only provider-confirmed
absence may authorize a create based on observed state:

- Permission errors, timeouts, rate limits, server failures, unsupported reads,
  and partial observation are unknown, not absent.
- Never swallow a non-not-found provider error and return `null`, an empty list,
  or `false` that the diff engine will interpret as absence.
- Track observation completeness per capability. Successful hosting observation
  does not prove database, storage, queue, App Store, DNS, or repository-setting
  observation succeeded.
- Match existing resources by durable provider id first. Name matching may
  produce adoption candidates, but multiple matches are ambiguity that must be
  reported and blocked.

Creates, updates, and destroys must be retry-safe:

- Billable and data-bearing actions require exact action-id confirmation.
- Provider deletes must treat already-absent resources as converged, wait for
  realistic asynchronous deletion, and verify terminal absence before removing
  local bindings.
- Multi-resource destruction follows dependency order and stops on failed or
  unknown deletion. Do not delete dependent data, storage, networking, or
  credentials until the owning resource is confirmed absent.
- A failed prerequisite is a stop point inside an orchestration stage. Do not
  keep issuing dependent provider mutations and hope rollback will reconstruct
  the prior state.

Lifecycle changes require contract tests for noop mutation freedom,
action-scoped mutation authority, observation-error preservation, duplicate
identity handling, import round trips, confirmation gating, and idempotent
delete retry. The current audit and repair queue is tracked in
[`docs/reconciliation-safety-backlog.md`](docs/reconciliation-safety-backlog.md).

## Connections And Secrets

Provider credentials and required external connections should be discovered as early as possible from the spec and reported before apply. Prefer `credentialsRef` with exported environment variables, `dotenv:` references, local JSON files, or secret-manager refs; raw credentials in chat are still accepted when the user intentionally chooses that path.

Secrets never cross output boundaries. Secret values may be accepted through `credentialsRef`, encrypted into plans, or stored as verified connections, but they must not be printed in tool output, committed specs, warnings, logs, receipts, or test snapshots.

Provider-declared environment-variable aliases may simplify local credential
references without duplicating secret values. Exact requested names win. When
an exact name is absent, all populated aliases must contain one distinct value
or resolution blocks without returning any value. GitHub declares
`NODE_AUTH_TOKEN`, `HYPERVIBE_GITHUB_TOKEN`, and
`HYPERVIBE_GITHUB_PACKAGES_TOKEN` as one alias group; `NODE_AUTH_TOKEN` is the
recommended combined-token name because npm must resolve it before Hypervibe
starts.

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

Managed database compatibility aliases are per-service desired state through
`services.<name>.databaseEnvAliases`. The spec stores only an alias name and
canonical source (`DATABASE_URL` or `DIRECT_URL`); the resolved
value is derived from the managed component inside plan/apply and never written
to the spec, plan preview, status, receipt, or bindings. Alias keys cannot
collide with ordinary env vars, env-file includes, removal tombstones,
delegated secrets, Stripe-managed keys, or canonical database variables.
Planning and status must diff each alias only on its target service, and
provider reference values may use presence-only comparison where the provider
returns a resolved value instead of the reference expression.

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

### Environment Variable Coverage

Desired state prevents new cross-environment configuration gaps before they
reach providers. A runtime key introduced through ordinary `envVars`, an
`envFile.include` slot, or a delegated secret must be represented in every
non-local environment that shares a desired service with a declaring
environment. Each environment supplies its own value or secret reference;
Hypervibe never copies values between environments.

An environment may list a key in `envVarExceptions` only to document that the
shared key intentionally does not apply there. Retirement tombstones also make
absence explicit. Mixed ordinary/delegated handling for the same key is
invalid. `hv_spec_set` blocks newly introduced gaps and gaps created by adding
a matching environment or service. Pre-existing gaps remain readable and do
not block unrelated spec changes, but are reported until repaired or explicitly
excepted. Provider observation and AI are not required for this guardrail;
`hv_plan` and `hv_apply` continue to own convergence of the accepted spec.

## Stripe Desired State

Stripe sandboxes are isolated environments with their own API keys and object
ids. Model the relationship explicitly through
`environments.<name>.payments.stripe`:

- `payments.stripe.environment` selects a Stripe connection scope and defaults
  to the Hypervibe environment name, so development, staging, and production
  can use distinct Stripe sandboxes/live mode.
- Scoped Stripe connections use `secretKey` plus optional `publishableKey`.
  Legacy global sandbox/live credentials remain a compatibility fallback, but
  cannot represent distinct development and staging sandboxes.
- Runtime credential projection is explicit through
  `payments.stripe.credentials`. Hypervibe-owned products and recurring prices
  are declared under `payments.stripe.catalog.products`; each price declares
  the hosting env key that receives its provider id.
- Named webhook endpoints are declared through `payments.stripe.webhooks`.
  Each webhook owns one HTTPS URL, event set, target service, and hosting env
  key. The Stripe endpoint and its creation-only signing value projection are
  one plan/apply lifecycle action; there is no imperative webhook setup tool.
- Catalog identity resolves by durable provider id first. An unbound exact
  metadata/name/config match is an explicit confirm-gated adoption candidate;
  multiple candidates block instead of choosing one. Unmanaged products and
  prices are untouched.
- Product display fields are mutable. Recurring price amount, currency, and
  interval are immutable: changing them plans a replacement, makes hosting
  consume the replacement, and only then permits confirm-gated archival of the
  previous price. Removal follows the same hosting-before-archive order.
- `hv_plan` observes Stripe catalog values and webhook endpoints internally and
  compares only hashes against hosting observation. Webhook identity resolves
  by a durable bound endpoint id first. URL matches are adoption candidates;
  zero, one, and multiple matches remain distinct plan outcomes.
- Plans, warnings, bindings, receipts, and tool output contain managed key
  names, provider ids, catalog diagnostics, and one-way hashes, never Stripe
  keys, webhook signing values, or resolved runtime values.
- `hv_apply` resolves the Stripe connection again and routes runtime changes
  through the hosting adapter. Webhook creation syncs the returned signing
  value before recording the binding. A failed hosting sync deletes and
  verifies the new endpoint; if rollback cannot be verified, the provider id
  is recorded so the next plan cannot orphan or duplicate it.
- Webhook adoption, replacement/rotation, and deletion require exact action-id
  confirmation. Deletion verifies provider absence before removing the hosting
  variable and local binding. Noop actions make no Stripe or hosting calls.
- For CI-triggered branch deploys, supported adapters defer code deployment so
  the exact-SHA workflow remains the release boundary.

Stripe-managed runtime keys cannot also come from ordinary `envVars`, env-file
includes, delegated secret slots, overrides, or removal tombstones. Removing
or renaming a catalog key is part of its reviewed catalog lifecycle; ordinary
unrelated runtime variables continue to use the two-release retirement process.

## iOS Release Desired State

Bundle IDs, capabilities, TestFlight groups/testers, and release workflows live
under each environment's `ios` desired state. There are no imperative bundle-ID,
TestFlight upload, or TestFlight distribution commands.

- `ios.release` requires a CI-triggered branch deploy. It names the server
  services that gate the mobile release, the repository-relative build command
  and IPA path, build-only GitHub environment secret names, signing provider,
  TestFlight groups, export-compliance answer, and optional beta-review
  submission.
- Hypervibe manages the server deploy workflow, iOS release workflow, and App
  Store Connect credentials through plan/apply. TestFlight upload, processing,
  compliance, declared-group distribution, optional beta review, and release
  evidence use a Hypervibe-owned runtime embedded into the managed workflow;
  the app does not supply submission code. The legacy default `scriptPath` is
  accepted only while existing specs migrate and custom values are rejected.
- Signing is an explicit provider contract. `provider: "project"` preserves the
  compatibility path where the app build owns signing. `provider: "match"`
  makes Hypervibe install existing Match assets read-only into an ephemeral
  keychain before invoking the app-defined build command. Match credentials are
  scoped to that preparation step and cannot also be declared as build-command
  secrets. Certificate/profile creation, rotation, and revocation never happen
  during deploys; they require a separate explicit lifecycle design.
- A successful server deploy writes an artifact whose name and JSON body carry
  the environment, repository, exact full Git SHA, and deployed service set.
  The artifact is emitted only after provider deployment steps succeed.
- The macOS iOS workflow shares the server deploy concurrency key and uses two
  isolated jobs. The build job consumes a specific successful server run,
  validates its evidence, checks out that exact SHA, prepares signing, invokes
  the app-defined build command, validates the IPA identity, and uploads a
  short-lived artifact. A fresh release job receives App Store credentials,
  downloads and revalidates the IPA and server evidence, then runs the managed
  release runtime. It never checks out or executes project code. This job
  boundary prevents an arbitrary build command from modifying the submission
  runtime or inheriting App Store Connect credentials.
- The iOS artifact records separate `mobile.repository`/`mobile.sha` and
  `server.repository`/`server.sha` fields. V1 is monorepo-first and therefore
  requires those repositories and SHAs to match at the workflow gate, while the
  evidence shape leaves a future explicit multi-repo policy possible.
- `hv_ci_status` is the read-only path for workflows, runs, logs, and release
  artifact provenance. `hv_appstore_submit` requires successful managed server
  and iOS evidence artifacts for the same SHA before final review submission.
- Xcode projects, schemes, entitlements, build/test commands, artifact paths,
  App Store metadata/screenshots, and local device operations remain
  project-owned. Hypervibe owns the release envelope around the resulting IPA.

## CI And Push Deploys

For push deploys, `deploy.trigger: "ci"` is the portable default. It means Hypervibe manages generated GitHub Actions workflows that call provider APIs directly.

CI ownership is exclusive. Planning must observe any provider-native repository
source or push trigger that could deploy the same service outside the managed
workflow. A confirmed native source is explicit drift: providers that expose a
safe disconnect capability plan a provider-source disconnect action, while
providers without one block with manual guidance. Unknown source observation
also blocks; it must never be interpreted as disconnected. The CI workflow and
applied-spec marker depend on this reconciliation, and a noop action performs
no provider mutation.

The standard team workflow is:

1. short-lived feature branches,
2. pull request into `main`,
3. checks on the pull request,
4. merge to `main` auto-deploys staging,
5. production is manually promoted from `main`, ideally by passing the exact commit SHA that already passed staging.

Do not default to a long-lived `staging` branch. `main` is the accepted-code branch, staging is the deployed preview of `main`, and production is a deliberate manual promotion. Generated production deploy workflows must not run from push events by default; they should use `workflow_dispatch` and support a `commit_sha` input.

Managed CI rollback is an explicit operational action over that same exact-SHA
release boundary. `hv_rollback` must select only unexpired server-release
evidence emitted by a successful run of the exact managed environment workflow.
After a failed promotion it restores the latest known-good release; after a
successful promotion it selects the previous distinct successful release unless
the caller names another previously verified full SHA. The repository, workflow,
ref, target SHA, source artifact id, source run id, and latest observed workflow
run id are frozen into a persisted rollback plan and re-observed immediately
before dispatch. Any workflow drift, unknown observation, ambiguous evidence,
newer run, or in-progress deployment blocks without mutation. Dispatch is a
pending receipt until `hv_ci_status` proves the workflow succeeded and
`hv_health` proves the endpoint. Rollback never reverses database migrations or
provider-side manual configuration; tool-mode migration steps are skipped during
rollback, while startup/release-command migrations must remain backward-compatible.

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

Generated deployment workflow files are repository infrastructure and must be
delivered through the deterministic `hypervibe/github-infrastructure` branch
and reviewable pull request. Applying file drift returns a pending receipt and
must defer workflow secrets, bindings, and the applied-spec marker until the
reviewed file is present on the default branch.

The deterministic branch must be reusable after merge commits, squash merges,
and rebase merges. A retained branch may be reset to the current default-branch
head only when GitHub proves its exact current SHA was the head of a merged
Hypervibe infrastructure pull request with the canonical title, body marker,
head ref, and base ref. Re-observe the branch immediately before resetting it
and verify the reset before writing files. Closed-unmerged pull requests,
post-merge commits, duplicate open pull requests, ambiguous provenance, and
observation failures must block without branch or file mutations.

GitHub desired state uses capability-level opt-in with exclusive ownership.
Once a capability is enabled, Hypervibe owns and reconciles every generated
file and setting for that capability; individual managed files cannot be
delegated back to the repository. Requiring pull requests therefore owns the
canonical lowercase `.github/pull_request_template.md`. `externalWorkflows`
remains a read-only integration surface because it names workflows Hypervibe
observes but does not manage.

Managed checks default to `changeScope: "application"`. On pull requests they
must keep the workflow and required check alive, classify changed paths through
the read-only GitHub pull-request API, and skip checkout, runtime setup,
dependency installation, application commands, and failure upload only when
every changed path is narrow Hypervibe-owned infrastructure. Empty,
unrecognized, mixed, or renamed-from-application path sets run the full check.
Checks that validate repository infrastructure declare `changeScope: "all"`.
Do not implement this policy with workflow-level `paths-ignore` or commit skip
markers: skipped required workflows can remain pending and block merges, while
selectively skipped job steps preserve the required check result.

Every external workflow consumed by autofix declares a narrow evidence artifact
name/pattern separately from its required paths. The generated consumer filters
the source run by that pattern and treats absent or incomplete required evidence
as non-actionable: it must not invoke the repair agent or publish a patch. A
legacy spec without the artifact pattern remains parseable so it can be repaired,
but GitHub infrastructure reconciliation blocks and the compiled workflow uses a
non-matching sentinel. Unexpected artifact transport or authorization failures
remain errors. Repair summaries and patch files are written outside the checkout
so diagnostic output cannot be included in the proposed source patch.

When a canonical environment has both deployment-workflow drift and other
managed GitHub file drift, apply must combine all known repository files and
the manifest into the same infrastructure pull request. Dependent secrets,
bindings, repository settings, and the applied-spec marker remain deferred
until the reviewed commit is present on the default branch.

`hv_ci_status` is the authoritative observation path for Hypervibe-managed GitHub Actions deploys. Agents should use it to inspect workflows, runs, jobs, and bounded log tails, then use `hv_health` after a successful run. They must not bypass it with `gh`, GitHub connectors/apps, browser/UI inspection, or direct GitHub API calls; a blocked `hv_ci_status` result should surface its connection/error guidance and stop the stage.

## Database Resilience

Provider-managed database resilience is optional desired state under
`database.resilience`. Omitting the block preserves backward compatibility and
means Hypervibe does not manage resilience settings. Within a declared block:

- `availability` owns the provider's zonal/regional HA mode;
- `backups` owns automated-backup count and PITR log retention; and
- `replicas` owns named provider read replicas. Removing a named replica is an
  explicit, confirm-gated deletion. Removing the whole resilience block stops
  management and does not silently reduce protection or delete replicas.

Resilience planning is provider-neutral and capability-driven. Unsupported
providers and incomplete observations produce blocked actions, not fallback
provider branches or inferred absence. A regional-HA action depends on backup
and PITR enablement when those settings are not already live. Cost-increasing
HA, retention, and replica creates are billable actions; retention/HA
reductions and replica deletion require exact action-id confirmation.

Read replicas are provider resources, not backups. Their exact provider ids are
stored in encrypted component bindings with connection material, while the
sanitized environment topology stores only provider ids, regions, and tiers so
repo-backed recovery remains possible. Runtime wiring uses
`DATABASE_READ_URL_<NAME>` and, only when one replica exists,
`DATABASE_READ_URL`. Replica deletion must first remove those variables from
every bound service, then verify provider-terminal absence before pruning the
binding. A noop action performs no provider mutation, and immutable replica
region/tier drift blocks until an explicit replacement lifecycle is supported.

Cloud SQL is the first resilience adapter. It observes and verifies HA,
backup/PITR policy, and replica topology through the SQL Admin API. Restore
drills, provider-to-provider database migration, replica promotion/failover,
and replica replacement are separate future lifecycle slices.

## Database Tasks And Seed Data

Do not use temporary release-command changes to run one-off data operations. Release commands are durable deploy-time schema configuration.

Schema migrations are not an imperative Hypervibe operation. Application
containers should converge schema during startup, or the spec may declare a
durable provider predeploy/release command when startup migration is not
appropriate.

Fresh-environment seed/bootstrap data belongs in desired state as `database.seedCommand`. It should plan a visible one-shot seed action, run through the provider-neutral environment task runner during `hv_apply`, and record completion on the database component only after terminal success.

`hv_db_migrate` must not exist in the command registry, MCP surface, or CLI.
Provider-to-provider data moves are lifecycle operations and must be modeled as
explicit spec/plan/apply actions with dependency edges, data-bearing
confirmation, cutover state, and verification receipts before they are
supported. Database resets likewise belong to desired-state destruction, not
an imperative shortcut. Re-running or repairing seed data requires a new
reviewable desired-state intent; Hypervibe does not expose a generic seed
command runner.

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

The Hypervibe CLI is a supported interface to the same command registry, state store, plan/apply engine, provider adapters, and audit history as MCP. It is not a provider-CLI bypass.

Do not introduce dependencies on provider CLIs for infrastructure operations. Hypervibe should use its provider adapters and recorded connections so state, audit history, and drift detection stay coherent. When an MCP client already has Hypervibe tools, agents should call them directly rather than spawning the Hypervibe CLI.

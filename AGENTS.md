# Hypervibe development instructions

These instructions govern Hypervibe development. Hypervibe orchestrates desired-state
infrastructure creation, migration, and destruction for nontechnical users bringing
applications to the web. Optimize the path from a repository to a working deployment.

The installed user workflow is [skills/hypervibe/SKILL.md](skills/hypervibe/SKILL.md).
Consumers must receive guidance through their installed skill, MCP instructions,
tool descriptions, and contextual results; they do not inherit this file.

For every user-facing page, email, prompt, tool result, approval and error, read
[Who we build and write for](docs/development/product.md#who-we-build-and-write-for).
Our customer can describe the app they want; they should not need to learn cloud
administration or our internal terminology to use Hypervibe.
Any step a person must take in a provider's console (a token, a permission, a
billing choice) comes with a clickable deep link to that exact page or
pre-filled form, from both Hypervibe's results and the agent's replies; never
send people to find settings by hand.

## Working method

- Handle small, reversible development tasks directly; add a formal plan,
  delegation or a long report only when complexity or risk warrants it. Delegate
  substantial independent work only when useful; retain required independent review.
- Keep changes scoped and preserve unrelated edits. Resolve routine reversible
  choices from context; ask only for materially consequential missing decisions
  and reuse authorization within scope.
- Read relevant sections and search likely files first; batch independent reads.
  Keep verbose command logs in a file and show relevant results or failures.
- Consult the relevant runtime/setup guidance before checks. Do not repeat the
  same environment failure without a changed condition. Finish once the requested
  outcome and proportional verification are complete; expand scope only for a
  concrete defect or unmet requirement.
- For behavior changes and bug fixes, follow the
  [evidence and verification method](docs/development/workflow.md#dg-135).
  These development shortcuts do not bypass the product's lifecycle, approval,
  provider-contract or security boundaries below.

## Merge handoff

- Accept the user's report that a PR merged without independently checking it.
- After a successful authorized merge, report the result and link, then stop.
  Do not fetch or pull, compare main, repeat merge checks, run tests, monitor CI or
  deployment, or perform browser smoke checks unless verification was explicitly
  requested.
- If the operation's outcome is ambiguous, make at most one bounded status lookup.
  Queued auto-merge remains queued; do not wait for it to complete.
- Preserve required pre-merge checks, release validation for authorized deployment
  tasks, and independently scheduled reviewers.

## Non-negotiable boundaries

- The central loop is `hv_spec` → `hv_plan` → `hv_apply` → verification. Lifecycle
  creates, adopts, attaches, deploy-source changes, schedules, migrations, and
  destroys belong in that loop. A persisted plan authorizes only its exact current
  non-noop actions and explicit dependencies. Noop means zero provider mutations.
- Observe present/absent/unknown. Only provider-confirmed absence proves absence;
  permission errors, unsupported/partial reads, malformed responses, and timeouts
  remain unknown. Resolve durable provider IDs together with their native scope.
  Names may suggest candidates, but never establish identity, ownership, permissions,
  or adoption authority. Block ambiguity; preserve independent read-only inspection.
- Billable/data-bearing actions require exact action confirmation. Keep account,
  billing, invitation, secret import, and apply approvals distinct. Verify provider
  convergence before dependent effects or removing bindings; destruction follows
  dependencies and stops on failed or unknown deletion.
- MCP and CLI are thin adapters over `src/application`. Define command metadata,
  validation, handling, redaction, and results once; keep both interfaces reachable
  unless architecture explicitly records an exception. Provider behavior belongs
  behind registered capabilities, not provider-name branches in generic orchestration.
- Secret values never cross output boundaries. Accept safe credential references,
  encrypted plans, or verified connections; scrub exact supplied values before any
  interface, persistence, warning, or diagnostic output. Control-plane authority does
  not authorize copying credentials into runtime. Preserve exact repository and
  environment scope and use supported workload identities.
- Use Hypervibe for infrastructure operations. Direct provider APIs/CLIs and other
  connectors must not bypass its plans, state, or blockers. MCP agents use available
  `hv_*` tools directly; the Hypervibe CLI shares the same state and reconciliation.
  The narrow [operator-managed Railway private SSH exception](docs/development/connections.md#dg-034)
  requires explicit user authorization and does not permit infrastructure changes.
- Honor each result's stage and continuation contract. Failed, blocked, pending, or
  confirmation-required work stops dependent work unless an explicit bounded
  continuation or user-authorized investigation applies. Report succeeded, failed,
  skipped, pending, and blocked honestly; a request attempt is not proof of success.

## Read the relevant contracts

[ARCHITECTURE.md](ARCHITECTURE.md) remains the infrastructure model's source of truth.
Before changing an area below, read its architecture sections and detailed rules.
Read additional sections when the task crosses boundaries; a full architecture read
is unnecessary for every task. The topic rules are normative.

| Work being changed | Required guidance |
| --- | --- |
| Onboarding, defaults, setup links, product communication | [Product rules](docs/development/product.md); architecture [Product Model](ARCHITECTURE.md#product-model), [Plan Honesty](ARCHITECTURE.md#plan-honesty) |
| Provider capabilities, API semantics, contract evidence | [Provider evidence](docs/development/provider-evidence.md); architecture [Provider Boundary](ARCHITECTURE.md#provider-boundary); [contract sources](test/provider-contracts/README.md) |
| Spec/plan/apply, naming, identity, observations, import, teardown, runtime configuration | [Lifecycle rules](docs/development/lifecycle.md); architecture [State Ownership](ARCHITECTURE.md#state-ownership), [Platform Bindings](ARCHITECTURE.md#platform-bindings), [Reconciliation Safety Invariants](ARCHITECTURE.md#reconciliation-safety-invariants) |
| Connections, authentication, secrets, IAM, runtime credentials | [Connection rules](docs/development/connections.md); architecture [Connections And Secrets](ARCHITECTURE.md#connections-and-secrets), [Runtime Secrets](ARCHITECTURE.md#runtime-secrets) |
| CI, deployment, promotion, tasks, release evidence, iOS | [CI rules](docs/development/ci.md); architecture [CI And Push Deploys](ARCHITECTURE.md#ci-and-push-deploys), [iOS Release Desired State](ARCHITECTURE.md#ios-release-desired-state) |
| Backups, persistent storage, restore, recovery | [Recovery rules](docs/development/recovery.md); architecture [Database Resilience](ARCHITECTURE.md#database-resilience) |
| Command interfaces, repository workflow, publishing, macOS | [Development workflow](docs/development/workflow.md); architecture [Interface Boundary](ARCHITECTURE.md#interface-boundary), [Tool And CLI Policy](ARCHITECTURE.md#tool-and-cli-policy) |

## Verification and delivery

Match verification to the affected behavior. Documentation-only and editorial
changes need content and link review, not automated tests. For behavior changes,
use the smallest relevant tests or evaluations; reserve broad suites for broad
changes or unresolved uncertainty. Preserve bug regression coverage and required
CI checks, and do not repeat completed checks without a concrete reason.
When testing applies, read the relevant
[verification guidance](docs/development/workflow.md#dg-134).

Do not run the full release gate, bump versions, or publish for every small change.
Follow the detailed workflow rules for an authorized build/release, including the
local MCP runtime, separately deployed helpers, and macOS checks. Never restart or
kill the user's MCP/client processes to activate a build; explain any needed restart.

[The migration audit](docs/development/guidance-migration.json) maps each original
AGENTS rule to retained text and records stale CLAUDE guidance corrections. Preserve
these obligations; make deliberate policy changes explicit in the rule and audit.

# Hypervibe development instructions

These instructions govern Hypervibe development. Hypervibe orchestrates desired-state
infrastructure creation, migration, and destruction for nontechnical users bringing
applications to the web. Optimize the path from a repository to a working deployment.

The installed user workflow is [skills/hypervibe/SKILL.md](skills/hypervibe/SKILL.md).
Consumers must receive guidance through their installed skill, MCP instructions,
tool descriptions, and contextual results; they do not inherit this file.

## Working method

- Keep changes scoped to the requested outcome. Prefer extending or deleting an
  existing path over new layers, speculative configuration, or compatibility
  branches. Preserve unrelated edits and explicit user choices.
- Establish concrete success criteria. State material assumptions and uncertainty;
  resolve routine choices from evidence and ask only when missing information or
  consequential ambiguity prevents a sound decision.
- Existing code, comments, types, mocks, and prior agent conclusions are hypotheses.
  Before a bug fix, identify the affected behavior, the assumption being challenged,
  independent evidence for expected behavior, and a counterexample. Write a boundary
  regression and observe it fail before changing runtime code.
- For provider-facing work, read the [provider evidence rules](docs/development-guidance-provider-evidence.md)
  and [pinned-contract guide](test/provider-contracts/README.md). Review the shared
  contract against every named provider in the affected category before implementing
  an adapter. Use official source or redacted observations; label reconstructed and
  synthetic evidence. Test real clients and serialized transport where applicable.
- Inspect every affected interpretation across spec, plan, apply, observation,
  retries, generated CI, import, and teardown. Fix contradictions within scope and
  reuse existing logic. Preserve accepted identities, bindings, and recovery state.
- At completion, report the challenged assumption, independent evidence,
  counterexample, observed failing/passing checks, and remaining gaps. A reproduced
  bug is not necessarily the cause of a customer incident. Keep this record in the
  PR when applicable; passing offline contracts do not establish live support.

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
| Onboarding, defaults, setup links, product communication | [Product rules](docs/development-guidance-product.md); architecture [Product Model](ARCHITECTURE.md#product-model), [Plan Honesty](ARCHITECTURE.md#plan-honesty) |
| Provider capabilities, API semantics, contract evidence | [Provider evidence](docs/development-guidance-provider-evidence.md); architecture [Provider Boundary](ARCHITECTURE.md#provider-boundary); [contract sources](test/provider-contracts/README.md) |
| Spec/plan/apply, naming, identity, observations, import, teardown, runtime configuration | [Lifecycle rules](docs/development-guidance-lifecycle.md); architecture [State Ownership](ARCHITECTURE.md#state-ownership), [Platform Bindings](ARCHITECTURE.md#platform-bindings), [Reconciliation Safety Invariants](ARCHITECTURE.md#reconciliation-safety-invariants) |
| Connections, authentication, secrets, IAM, runtime credentials | [Connection rules](docs/development-guidance-connections.md); architecture [Connections And Secrets](ARCHITECTURE.md#connections-and-secrets), [Runtime Secrets](ARCHITECTURE.md#runtime-secrets) |
| CI, deployment, promotion, tasks, release evidence, iOS | [CI rules](docs/development-guidance-ci.md); architecture [CI And Push Deploys](ARCHITECTURE.md#ci-and-push-deploys), [iOS Release Desired State](ARCHITECTURE.md#ios-release-desired-state) |
| Backups, persistent storage, restore, recovery | [Recovery rules](docs/development-guidance-recovery.md); architecture [Database Resilience](ARCHITECTURE.md#database-resilience) |
| Command interfaces, repository workflow, publishing, macOS | [Development workflow](docs/development-guidance-workflow.md); architecture [Interface Boundary](ARCHITECTURE.md#interface-boundary), [Tool And CLI Policy](ARCHITECTURE.md#tool-and-cli-policy) |

## Verification and delivery

Run focused `npm test -- <test paths>` checks for the changed behavior and
`npm run typecheck` for TypeScript changes. Regression checks must remain in the
ordinary `npm test` acceptance path; verify both committed CI and desired required
check configuration before claiming CI coverage. Repository files do not prove
live branch-protection enforcement. Execute generated operational programs where
those programs are the boundary; source-string checks alone cannot prove effects.

Do not run the full release gate, bump versions, or publish for every small change.
Follow the detailed workflow rules for an authorized build/release, including the
local MCP runtime, separately deployed helpers, and macOS checks. Never restart or
kill the user's MCP/client processes to activate a build; explain any needed restart.

[The migration audit](docs/development-guidance-migration.json) maps each original
AGENTS rule to retained text and records stale CLAUDE guidance corrections. Preserve
these obligations; make deliberate policy changes explicit in the rule and audit.

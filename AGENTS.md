# Agent Notes

Read `.agents/shared/WORKFLOW.md` and `.agents/project/workflow.md` at task start.
This editable file and `.agents/project/` own local policy; `.agents/shared/`
is a pinned shared bundle, not a mutable remote instruction import. Local safety
rules and explicit owner decisions remain binding.

Hypervibe is an infrastructure creation, migration, and destruction orchestrator,
not a collection of imperative provider functions. Read `ARCHITECTURE.md` before
lifecycle, provider, plan/apply, deploy, migration, DNS, CI, connection or secret work.

## Critical invariants

- Keep the spec → plan → apply → status lifecycle central. Persisted plans are
  mutation authority: mutate only the exact non-noop action and its dependencies.
  Noop means zero provider mutations; unknown observation never means absent.
- Use durable scoped identities, not name guesses. Keep staging data, secrets,
  workload identities and CI credentials isolated from production. Confirm
  billable/data-bearing actions by exact action ID; uncertain deletion preserves
  dependent data and bindings until terminal absence is verified.
- Keep MCP/CLI thin, shared application logic and generic provider capabilities.
  Never bypass blocked Hypervibe operations with provider CLIs, APIs or `gh`.
  Stage-by-stage blocked/pending results require the next owner decision.
- Secrets never cross output boundaries. Preserve origin/destination scope,
  one-time handoff recovery, and separate invitation/import/apply approval.
- Provider fixes need independent contract evidence and a real serialized-boundary
  RED/GREEN regression. Passing mocks do not prove live support.
- Small fixes do not authorize a full release, version bump or publication.
  Confirm before publishing; never kill MCP or Codex to activate a build.

## Read the matching local reference before editing

- Provider-facing capabilities or bugs: `.agents/project/provider-contracts.md`
  and `test/provider-contracts/README.md`; evaluate every affected supported host.
- Reconciliation, resource identity/naming, import, storage or teardown:
  `.agents/project/lifecycle.md` and the provider-contract guidance.
- Connections, secrets, delegated handoffs, dotenv or repository-backed files:
  `.agents/project/credentials.md`; resource changes also use lifecycle guidance.
- CI generation, build/deploy, immutable-source evidence, helper artifacts,
  package release or local runtime updates: `.agents/project/ci-release.md`.
- Backups, restore, recurring recovery or deployment-readiness gates:
  `.agents/project/recovery.md` plus lifecycle and CI guidance as applicable.
- Companion processes, macOS IPC/locks or managed iOS releases:
  `.agents/project/native.md` plus CI guidance for generated workflows.
- Substantive human-facing flows, onboarding, command receipts or explanatory
  copy: `.agents/skills/product-design/SKILL.md`.

Load only relevant references, then follow their required sub-guides. The normal
`npm test` acceptance gate retains regression coverage; use focused local checks
while developing and keep all existing CI/release requirements.

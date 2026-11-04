# Development boundaries and release workflow

Read when changing command/interface boundaries, preparing PRs or releases, or changing the macOS companion.

These are normative maintainer rules, complementary to `ARCHITECTURE.md`,
which remains the infrastructure model's source of truth. Load only the sections
relevant to the task. Paths in code spans are relative to the repository root.

Related contracts: [Interface Boundary](../../ARCHITECTURE.md#interface-boundary), [Provider Boundary](../../ARCHITECTURE.md#provider-boundary), [Tool And CLI Policy](../../ARCHITECTURE.md#tool-and-cli-policy), and [macOS development](../../apps/macos/README.md).

Stable rule IDs preserve the original guidance and are mapped in
[the migration audit](guidance-migration.json). These files are
for developing Hypervibe; the distributed user workflow lives in
[`skills/hypervibe`](../../skills/hypervibe/SKILL.md).

## DG-027

Add the least code needed for the requested behavior. Prefer deleting or extending existing paths over introducing new layers, helpers, configuration, compatibility branches, or abstractions for hypothetical future needs.

## DG-028

Keep MCP and CLI as thin adapters over `src/application`. Define command ids, schemas, descriptions, safety metadata, handlers, redaction, and structured results once; never put provider calls or lifecycle orchestration in an interface.

## DG-029

Every supported command must be reachable through both adapters unless architecture documentation explicitly declares it interface-specific. Contract tests must pin registry/MCP parity and CLI routing.

## DG-073

Keep provider behavior behind the provider boundary. Generic plan/apply/services/tools code should route through adapter capabilities and provider registry metadata, not provider-name branches or direct provider adapter imports.

## DG-116

Do not run Hypervibe's full release gate, bump a version, or publish a release for every small change or merged pull request. Use focused tests while developing small fixes and let them accumulate into a coherent release batch. Run the full release gate and publish only when the batch is actually ready, when the user explicitly requests a release, or when a release is necessary to unblock the current task; confirm with the user before publishing unless they already requested it.

## DG-117

A successful dependency install does not establish a clean security audit. Keep `npm audit --audit-level=high` in the shared release gate, verify compatible lockfile repairs through a fresh `npm ci`, and never bypass findings with `--force` or unreviewed major upgrades. Advisory data changes independently of source; earlier passing checks are not current release evidence.

## DG-118

When a release requires a separately deployed helper artifact, gate package publication on building, testing and verifying that exact helper. Record the registry manifest digest and source revision, verify the consumer's actual pull access, and distinguish an uploaded artifact from a verified release. An image/config ID or authenticated push alone cannot establish a runnable public artifact.

## DG-119

Keep the user's local Codex Hypervibe MCP configuration pointed at the main checkout's `/Users/dave/projects/hypervibe/dist/mcp.js` (`~/projects/hypervibe/dist/mcp.js`). Never repoint it to a worktree, temporary checkout, alternate build output, or installed package, including for testing. Refresh that runtime by rebuilding the main checkout in place; working in another checkout does not authorize changing the local Codex MCP configuration. This rule applies to both global and project-specific Codex MCP configuration.

When building or releasing Hypervibe, update the configured local MCP runtime first and verify that it reports the new version. Never kill or restart Hypervibe MCP or Codex processes to activate a build; tell the user to restart Codex themselves.

## DG-120

On macOS, configure every parent write descriptor used for child-process IPC with `F_SETNOSIGPIPE` before handing it to an async transport. An immediately exiting child must surface an ordinary write/process error instead of terminating the host; keep immediate-exit and crash coverage in the release-gated companion tests.

## DG-121

Release macOS advisory instance locks explicitly with `flock(LOCK_UN)` before closing their descriptor. Keep release-and-immediate-reacquisition coverage in the release-gated companion tests; descriptor close alone is not a sufficiently deterministic handoff across runner architectures.

## DG-122

After creating a pull request, always provide its URL and explicitly offer to open it in the user's browser. Open it only after the user accepts.

## DG-123

When the complete, nonempty pull-request diff is limited to Hypervibe specs or files generated from them, prefix the title with exactly `[hypervibe] `. This includes `.hypervibe/spec.json`, generated bindings, and Hypervibe-generated workflows and support files, even when the spec itself is unchanged. Verify generated ownership from the manifest, generation markers, or declared outputs; a directory or filename alone is not sufficient. Check every changed path against the PR's base branch, including both source and destination paths of renames. PRs that also change application code or unrelated files do not qualify. Apply this rule when creating or retitling a PR.

## DG-134

Match verification to the affected behavior. Documentation-only and editorial
changes that do not affect runtime behavior need content and link review, not
automated tests. For code, configuration, workflow or runtime-prompt changes, use
the smallest relevant tests or evaluations. Preserve meaningful bug regression
coverage and required CI checks. Run broader suites only for broad changes or
unresolved uncertainty; do not repeat completed checks without new changes,
failures or another concrete reason.

Run focused `npm test -- <test paths>` checks for the changed behavior and
`npm run typecheck` for TypeScript changes. Regression checks must remain in the
ordinary `npm test` acceptance path; verify both committed CI and desired required
check configuration before claiming CI coverage. Repository files do not prove
live branch-protection enforcement. Execute generated operational programs where
those programs are the boundary; source-string checks alone cannot prove effects.

## DG-135

Use a direct path for small, reversible development tasks. A formal plan,
delegation or a long report is justified by complexity or risk, not by the fact
that a file changed. Delegate substantial independent work only when it improves
the result; preserve required independent review. Resolve routine reversible
choices from context, ask only for materially consequential missing decisions,
and reuse existing authorization within its agreed scope.

Read only the contract and setup sections relevant to the task. Search likely
files first and batch independent reads. Keep verbose command logs in a file;
show relevant results and failures without discarding the underlying evidence.
Consult existing runtime/setup guidance and pinned versions before running checks.
Do not repeat an unchanged environment failure without evidence that conditions
have changed. Finish when the requested outcome and proportional verification are
complete; expand scope only for a concrete defect or unmet requirement.

The following method applies to behavior changes and bug fixes. It retains the
original evidence requirements; small editorial tasks do not need a bug-fix report.

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
- For provider-facing work, read the [provider evidence rules](provider-evidence.md)
  and [pinned-contract guide](../../test/provider-contracts/README.md). Review the shared
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

## DG-136

- Accept the user's report that a PR merged without independently checking it.
- After a successful authorized merge, report the result and link, then stop.
  Do not fetch or pull, compare main, repeat merge checks, run tests, monitor CI or
  deployment, or perform browser smoke checks unless verification was explicitly
  requested.
- If the operation's outcome is ambiguous, make at most one bounded status lookup.
  Queued auto-merge remains queued; do not wait for it to complete.
- Preserve required pre-merge checks, release validation for authorized deployment
  tasks, and independently scheduled reviewers.

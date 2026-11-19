# Development boundaries and release workflow

Read when changing command/interface boundaries, preparing PRs or releases, or changing the macOS companion.

These are normative maintainer rules, complementary to `ARCHITECTURE.md`,
which remains the infrastructure model's source of truth. Load only the sections
relevant to the task. Paths in code spans are relative to the repository root.

Related contracts: [Interface Boundary](../../ARCHITECTURE.md#interface-boundary), [Provider Boundary](../../ARCHITECTURE.md#provider-boundary), [Tool And CLI Policy](../../ARCHITECTURE.md#tool-and-cli-policy), and [macOS development](../../apps/macos/README.md).

These rules are for developing Hypervibe; the distributed user workflow lives in
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

After creating a pull request, provide its URL. Open it in the browser when the user asks; do not add a confirmation exchange merely to offer to open it.

## DG-123

When the complete, nonempty pull-request diff is limited to Hypervibe specs or files generated from them, prefix the title with exactly `[hypervibe] `. This includes `.hypervibe/spec.json`, generated bindings, and Hypervibe-generated workflows and support files, even when the spec itself is unchanged. Verify generated ownership from the manifest, generation markers, or declared outputs; a directory or filename alone is not sufficient. Check every changed path against the PR's base branch, including both source and destination paths of renames. PRs that also change application code or unrelated files do not qualify. Apply this rule when creating or retitling a PR.

## DG-134

Review content and links for documentation-only changes; no automated suite is
needed. For behavior changes, run focused `npm test -- <test paths>` checks and
`npm run typecheck` for TypeScript. Expand only for affected shared behavior or an
unresolved failure. Reuse passing evidence until relevant code or conditions change.

Keep regressions in ordinary `npm test` and preserve required CI. Check the
committed workflow and desired required-check configuration when adding tests or
changing workflows; reuse established wiring for later fixes.
Do not claim live branch protection from repository files alone. Execute generated
operational programs when they are the changed boundary; string checks cannot
prove their effects. A full release gate belongs to a release, not every patch.

Test runs show a final summary and failure details, suppressing passing-test logs.
For individual test results and all console output, run
`npm test -- <test paths> --reporter=verbose --silent=false`.

## DG-135

Follow the global bug-fix guidance in `~/.codex/guidance/bug-fixes.md` when
available. The repository method remains self-contained: establish expected
behavior independently, challenge the failure assumption with a counterexample,
observe a boundary regression fail before the fix, then verify it passes. Record
that evidence and remaining gaps once in the PR. Do not duplicate the record in
chat, separate reports and each agent handoff.

Trace callers and other paths that interpret the changed state. Fix affected
contradictions within scope; do not audit every lifecycle stage for every patch.
Preserve identities, bindings and recovery state. Provider work also uses the
[provider evidence rules](provider-evidence.md); review affected implementations
when the shared contract changes, not every provider for an adapter-local fix with
unchanged semantics. Label synthetic evidence honestly; passing offline checks
do not establish live support or prove the cause of a customer incident.

Define success as observable user behavior. For a feature across repositories or
providers, integrate one complete path early and extend from that evidence. When
two attempts leave the same step blocked, reassess the diagnosis, identify what
new evidence the next attempt will obtain, and report the actual blocker. Continue
authorized work with a changed approach; do not restart tests or add parallel work
without new evidence. A missing capability is a dependency to resolve within scope,
not automatic permission to start another product project.

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

## DG-137

An upgrade must not break an app that did not change. Existing users run the new
version against what an earlier version produced: saved state and bindings,
generated workflows, build configuration and deployed infrastructure.

- When a change alters anything Hypervibe generates, or how it reads what it
  generated, add a test that runs the new code against the previous version's
  output. Testing new code against new output only does not cover an upgrade.
  The unchanged app must keep working, or Hypervibe must detect the old output
  and say what to do before any paid or irreversible step.
- Clients decode command answers in a fixed shape: the macOS companion,
  hypercloud and installed agents. Every answer a client decodes has a captured
  contract that its own decoder reads in CI
  (`src/tools/__tests__/macos-status.contract.test.ts` and
  `CurrentCoreStatusContractTests`). Add the capture when a client starts
  decoding a new answer. Changing the shape of an existing answer means updating
  the client in the same change, or adding the new shape behind an explicit mode.
- When a message tells the user how to get unblocked, a test follows that
  instruction from a real starting configuration, such as an installer-written
  one, and shows the block clears. Never refuse rollback or recovery with an
  instruction that has not been tested this way.
- Every billable or irreversible provider call has tests for three outcomes:
  success, a definite rejection, and a lost or ambiguous response. Each must
  leave the user with a next step. A lost response is unknown, not absent, and
  never permits repeating the call.

## DG-138

Batching small fixes into one pull request is fine. These changes are not small:

- the release or build pipeline;
- trust, authentication or credentials;
- purchases and other billable calls;
- anything that can refuse an operation that worked before.

Give each one its own pull request so it can be reviewed and reverted alone,
with a live run where one is possible. Say plainly when no live run was done.

For every behavior change, the pull request description names the existing
callers (the macOS companion, hypercloud, generated workflows, installed
clients) and says what happens to an unchanged app on upgrade. Put this under
"Existing behavior or tests changed".

Passing checks do not make a pull request ready. Before calling one ready that
touches the areas above or changes more than about 500 runtime lines, have a
reviewer with fresh context read the diff, and reproduce what it flags.

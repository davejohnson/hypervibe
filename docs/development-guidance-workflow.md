# Development boundaries and release workflow

Read when changing command/interface boundaries, preparing PRs or releases, or changing the macOS companion.

These are normative maintainer rules, complementary to `ARCHITECTURE.md`,
which remains the infrastructure model's source of truth. Load only the sections
relevant to the task. Paths in code spans are relative to the repository root.

Related contracts: [Interface Boundary](../ARCHITECTURE.md#interface-boundary), [Provider Boundary](../ARCHITECTURE.md#provider-boundary), [Tool And CLI Policy](../ARCHITECTURE.md#tool-and-cli-policy), and [macOS development](../apps/macos/README.md).

Stable rule IDs preserve the original guidance and are mapped in
[the migration audit](development-guidance-migration.json). These files are
for developing Hypervibe; the distributed user workflow lives in
[`skills/hypervibe`](../skills/hypervibe/SKILL.md).

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

When building or releasing Hypervibe, update the configured local MCP runtime first and verify that it reports the new version. Never kill or restart Hypervibe MCP or Codex processes to activate a build; tell the user to restart Codex themselves.

## DG-120

On macOS, configure every parent write descriptor used for child-process IPC with `F_SETNOSIGPIPE` before handing it to an async transport. An immediately exiting child must surface an ordinary write/process error instead of terminating the host; keep immediate-exit and crash coverage in the release-gated companion tests.

## DG-121

Release macOS advisory instance locks explicitly with `flock(LOCK_UN)` before closing their descriptor. Keep release-and-immediate-reacquisition coverage in the release-gated companion tests; descriptor close alone is not a sufficiently deterministic handoff across runner architectures.

## DG-122

After creating a pull request, always provide its URL and explicitly offer to open it in the user's browser. Open it only after the user accepts.

## DG-123

When the complete, nonempty pull-request diff is limited to Hypervibe specs or files generated from them, prefix the title with exactly `[hypervibe] `. This includes `.hypervibe/spec.json`, generated bindings, and Hypervibe-generated workflows and support files, even when the spec itself is unchanged. Verify generated ownership from the manifest, generation markers, or declared outputs; a directory or filename alone is not sufficient. Check every changed path against the PR's base branch, including both source and destination paths of renames. PRs that also change application code or unrelated files do not qualify. Apply this rule when creating or retitling a PR.

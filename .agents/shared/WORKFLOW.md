# Shared working agreements

This is a stack-neutral baseline. The project's `AGENTS.md` and task-specific
rules define its architecture, commands, security policy and release process.
Explicit user instructions govern scope. Shared guidance does not authorize
deployments, merges, infrastructure changes or the next task.

## Evidence before implementation

- Establish the user-visible outcome and relevant constraints before choosing
  an implementation. Existing code, comments, fixtures and prior agent claims
  are hypotheses, not proof of intended behavior.
- For a bug, state the failing assumption, independent requirement or contract,
  and a concrete counterexample. Write the relevant boundary regression and
  observe RED before changing runtime code; verify GREEN afterward. Label
  missing evidence instead of inventing a contract.
- Trace other entry points, lifecycle transitions, retries, cache and worker
  consumers of the same state. Fix contradictory interpretations within scope;
  do not start an unrelated architecture project.
- Reuse the owning service and shared policies. Explain why existing mechanisms
  cannot meet the acceptance criteria before adding another subsystem.
- Run focused checks while building and the project's required checks before
  handoff. Do not weaken tests or required CI to make a change pass. Report
  intentionally unrun checks and limits of mock/provider/browser evidence.

## Product work

For new or materially changed human-facing flows, screens, navigation, forms,
onboarding or consequential copy, use the project's product-design skill before
implementation. It defines an outcome-first design pass and a separate clarity
review. Do not turn every backend/library edit into a UI design exercise.

## Safety that survives refactoring

- Preserve local security controls. Viewing must stay read-only; use appropriate
  unsafe HTTP methods for mutations and the project's validated CSRF policy for
  browser writes. UI visibility, CORS and token-shaped headers are not authority.
- Resolve authenticated scope and actual object ownership on the server. Carry
  it through lists, individual objects, exports, files, caches, jobs and retries.
  An ID supplied by the caller does not prove tenant/project access.
- Treat user/provider content as data in DOM, prompts and logs. Keep credentials
  outside source, instructions, tests, screenshots and PR evidence. Use synthetic
  test identities and isolated stores; don't borrow production secrets/data.
- Preserve unrelated work. Use a separate feature branch/worktree when needed.
  Publishing permission is not permission to merge, deploy or release.

## Handoff

Report the outcome, verification and uncertainties. For fixes, include the
challenged assumption, independent evidence, counterexample and observed
RED/GREEN. Passing mocks is not live compatibility or proof of an incident's
cause. For UI work, distinguish functional checks from clarity/usability review.
Give the PR link when publishing was requested. Do not poll remote CI/deployments
unless asked. Suggest an established next task and ask whether to start; a
merge notification is not authorization to begin it.

## Updating this shared copy

Consumers keep this bundle in `.agents/shared`, pinned by `manifest.json` to a
commit in `davejohnson/project-template`. Do not edit the managed files locally.
Edit local policy in `AGENTS.md`, `CLAUDE.md`, `.agents/project/` or the local skill
adapter. Shared improvements belong in `project-template/agent-guidance`, then
an explicit reviewed sync PR. See that repository's `docs/agent-guidance.md`.

# GitHub infrastructure for beginners

Hypervibe can manage repository collaboration, checks, autofix, pull-request
review, code audit, dependency maintenance, and security settings as desired
state. GitHub and OpenAI connections are optional: without them you can still
edit/read the spec, inspect local state and history, use the desktop companion,
and manage every independently connected provider.

GitHub capabilities are opt-in, but ownership is not split after a capability
is enabled. Hypervibe exclusively owns the files and settings generated for
that capability and reconciles manual drift. For example, requiring pull
requests means Hypervibe owns the canonical
`.github/pull_request_template.md`. Disable the capability if the repository
must own that surface itself. `externalWorkflows` is the deliberate exception:
those workflows remain read-only inputs to Hypervibe automation.

## What happens when you apply

1. `hv_spec_set` records the `github` intent.
2. `hv_plan` compares it with GitHub and reports exact blocked actions.
3. `hv_apply` creates or updates one regular pull request named
   `[Hypervibe] Sync GitHub infrastructure` on the deterministic
   `hypervibe/github-infrastructure` branch.
4. A person reviews and merges that pull request. Hypervibe never merges it.
5. A new `hv_plan` verifies the files and proposes settings/secrets that depend
   on the reviewed workflows.

GitHub Actions workflows are files under `.github/workflows/`; GitHub's API
creates commits containing those files rather than creating fileless workflows.
Hypervibe also owns `.github/hypervibe/manifest.json`, which limits cleanup to
files that Hypervibe previously managed.

Generated environment deployment workflows use the same deterministic branch
and pull-request flow. When possible, workflow drift and all other known
repository-file drift are combined into that one infrastructure pull request.
Hypervibe does not sync provider secrets, record workflow bindings, apply
dependent repository settings, or advance the applied desired-state marker
until the reviewed files are present on the repository's default branch.

The canonical pull-request template asks for a summary, related issue, visual
evidence, verification, deployment impact, changed expectations, risks, and
review checks. Projects can add detail in individual pull requests, while the
owned template keeps the required review contract consistent.

## A practical starting spec

Automation ids are your own lowercase slugs. `kind` selects a typed behavior;
frequency belongs in its trigger or schedule rather than in names such as
"nightly audit." The following is a merge patch for an existing project spec:

```json
{
  "github": {
    "repository": "OWNER/REPOSITORY",
    "canonicalEnvironment": "production",
    "actions": {
      "tests": {
        "kind": "check",
        "category": "test",
        "runtime": { "kind": "node", "version": "22" },
        "commands": ["npm test"],
        "triggers": {
          "pullRequest": true,
          "schedule": {
            "cron": "15 4 * * *",
            "timezone": "America/Vancouver"
          }
        }
      },
      "fix-tests": {
        "kind": "autofix",
        "sources": ["tests"]
      },
      "review": {
        "kind": "pull-request-review"
      },
      "audit": {
        "kind": "code-audit",
        "schedule": { "cron": "0 6 * * 1", "timezone": "UTC" }
      }
    },
    "dependencies": {
      "alerts": true,
      "securityUpdates": true,
      "versionUpdates": [
        { "ecosystem": "npm", "directory": "/", "interval": "weekly" }
      ]
    },
    "security": {
      "codeScanning": true,
      "secretScanning": true,
      "pushProtection": true
    }
  }
}
```

Checks also support `lint`, `typecheck`, `build`, `dependency-audit`,
`performance`, and `accessibility` categories. A code audit maintains one issue
per stable finding and closes it after one complete clean audit; failed or
partial audit runs never close findings.

Autofix runs only for a failed run from the same repository on the configured
target branch. It always opens a draft pull request. The generated patch cannot
change `.github/`, `.hypervibe/`, agent instruction files, or `.env` files, and
its validation job receives no OpenAI or live-provider secret. Extra failure
artifacts must be narrow relative result paths; credential-shaped paths and
whole-workspace globs are rejected.

The dependency and security booleans are enable-only controls in this version:
`true` asks Hypervibe to enable and verify the feature; `false` or omission
leaves an existing provider setting alone. Hypervibe does not silently disable
repository security features.

## Connect GitHub

Credential type: a fine-grained GitHub personal access token is recommended.
Create it at [GitHub fine-grained personal access tokens](https://github.com/settings/personal-access-tokens/new).
Choose the repository owner and select only the repositories Hypervibe should
manage. For the full `github` feature set, grant:

- Metadata: read (GitHub adds this automatically)
- Administration: read/write
- Actions: read/write
- Contents: read/write
- Pull requests: read/write
- Issues: read/write
- Secrets: read/write
- Workflows: read/write
- Dependabot alerts: read/write when dependency alerts/updates are enabled
- Code scanning alerts: read/write when code scanning is enabled
- Secret scanning alerts: read/write when secret scanning is enabled

Organization policy can prevent a repository token from enabling Actions,
scanning, or pull-request creation. Hypervibe reports that as blocked rather
than claiming success. GitHub Advanced Security/code scanning can also require
an eligible paid plan for private repositories; enabling it is confirmation-
gated. See [GitHub's fine-grained permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

Store the token in an exported environment variable or local `.env` file—not
in chat or the repository:

```bash
export HYPERVIBE_GITHUB_TOKEN='github_pat_...'
```

Then connect it for exactly one repository:

```text
hv_connect provider="github" scope="OWNER/REPOSITORY" credentialsRef="env:HYPERVIBE_GITHUB_TOKEN"
```

A classic PAT remains useful for legacy/package operations. Private GHCR image
pulls require a classic PAT with `read:packages`; it can be supplied separately
as `packageReadToken`. See [GitHub's PAT guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

## Connect OpenAI (only for AI automations)

Credential type: an OpenAI project API key. A ChatGPT subscription is not an
API credential and API usage is billed separately. Create a project-scoped key
at [OpenAI API keys](https://platform.openai.com/api-keys). The project needs
access to `gpt-5.6-sol`; a restricted key must allow model reads and Responses
API writes. Set a project budget/usage limit before enabling scheduled work.

```bash
export OPENAI_API_KEY='sk-proj-...'
```

```text
hv_connect provider="openai" scope="OWNER/REPOSITORY" credentialsRef="env:OPENAI_API_KEY"
```

Hypervibe syncs the value only into the repository's `OPENAI_API_KEY` Actions
secret. It never appears in specs, plans, logs, receipts, snapshots, workflow
files, or the desktop cache. The Codex job receives no GitHub write token; a
separate job publishes its artifact or draft pull request.

## Allow autofix pull requests

Autofix needs GitHub's repository setting **Allow GitHub Actions to create and
approve pull requests**. Hypervibe plans and applies that setting through the
GitHub API when permitted. If organization policy blocks it, a repository admin
can open **Settings → Actions → General → Workflow permissions** and enable it.
GitHub documents the setting in
[Managing GitHub Actions settings for a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).

## Schedules and dependency intervals

Action schedules use five-field POSIX cron:

```text
minute hour day-of-month month day-of-week
15     4    *            *     *
```

Add an IANA timezone such as `America/Vancouver`; omitted timezones default to
`UTC`. Dependabot is different: its native configuration uses `daily`,
`weekly`, or `monthly` intervals rather than cron.

## Operational controls

- `hv_ci_status` lists workflows, runs, jobs, and bounded log tails through the
  recorded GitHub connection.
- `hv_ci_trigger` performs an explicit manual workflow dispatch.
- `hv_ci_setup` is only a one-release compatibility bridge. It updates desired
  state and tells you to run `hv_plan`; it no longer writes GitHub directly.

Use `hv_status` after a successful deploy workflow to verify the actual service.

## Runtime error visibility

GitHub workflow autofix repairs failed checks; it does not poll production
service logs. Use `hv_errors action="list"` for recent runtime error lines and
`hv_errors action="summary"` for per-service error and deployment health. Both
read through the configured hosting provider connection and do not create
branches or pull requests.

The former environment-level `environments.<env>.autofix` runtime repair agent
has been removed. Existing specs that contain it fail validation with migration
guidance instead of silently losing intent. Scheduled runtime-error alerts or a
desktop error inbox can be added later as a separate desired-state capability.

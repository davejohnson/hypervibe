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

1. `hv_spec` records the `github` intent.
2. `hv_plan` compares it with GitHub and reports exact blocked actions.
3. `hv_apply` creates or updates one regular pull request named
   `[Hypervibe] Sync GitHub infrastructure` on the deterministic
   `hypervibe/github-infrastructure` branch.
4. A person reviews and merges that pull request. Hypervibe never merges it.
5. A new `hv_plan` verifies the files and proposes settings/secrets that depend
   on the reviewed workflows.

You may use GitHub's merge-commit, squash, or rebase option. If GitHub retains
the deterministic branch after the pull request merges, the next apply reuses
it. Hypervibe fast-forwards an ordinary merged branch; for squash or rebase
merges, it resets the branch only after GitHub proves that its exact current
commit belongs to the merged canonical Hypervibe pull request. Extra commits,
closed-unmerged work, duplicate pull requests, or incomplete observation block
instead of being overwritten. Manual branch deletion is not required.

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

## Static sites with GitHub Pages

Pages is project-level desired state. A repository that only publishes a
static site does not need a fake Railway, GCP, or other hosting environment;
use the reserved canonical environment `repository`:

```json
{
  "version": 1,
  "project": "example-site",
  "gitRemoteUrl": "git@github.com:OWNER/REPOSITORY.git",
  "github": {
    "repository": "OWNER/REPOSITORY",
    "canonicalEnvironment": "repository",
    "pages": {
      "sourcePath": "apps/website",
      "branch": "main",
      "customDomain": "example.com"
    }
  },
  "environments": {}
}
```

Hypervibe generates a reviewed workflow using GitHub's supported Pages
artifact actions. The first apply opens the ordinary GitHub infrastructure
pull request; it does not enable Pages or change DNS. After a person merges the
workflow, a new plan can emit two explicit actions: Cloudflare address-record
reconciliation and GitHub Pages configuration with `build_type: workflow`.
Replacing existing address records is confirmation-gated. Apex domains use
GitHub's Pages A records; subdomains use an unproxied CNAME. MX, TXT, and other
unrelated records are outside this action's authority. Once configuration is
verified, Hypervibe dispatches the reviewed Pages workflow and returns pending;
it does not claim publication before the workflow runs.

GitHub may take time to issue the custom-domain certificate. Apply reports a
pending receipt instead of claiming success; rerun `hv_plan` and `hv_apply`
later to enforce HTTPS after GitHub reports the certificate ready. Inspect the
managed workflow through `hv_ci_status`, followed by the live site after the
run succeeds.

Connect Cloudflare with a zone-scoped API token that has Zone read and DNS edit
for the intended zone:

```text
hv_connections provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env#CLOUDFLARE_API_TOKEN"
```

Set `github.pages.enabled` to `false` to tear the site down declaratively. The
reviewed workflow is removed first. A subsequent plan confirmation-gates Pages
deletion and removal of only matching GitHub Pages address records. To replace
or remove an existing custom domain, first disable Pages while retaining that
current `customDomain`; after the teardown verifies, declare the replacement.
Hypervibe blocks a one-step domain swap so the old DNS record is not orphaned.

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

A code audit may add bounded `instructions` for a reviewed repository-specific
contract. When that contract needs current public documentation, declare exact
lowercase hosts in `documentationDomains`. Hypervibe generates a named Codex
profile that extends `:read-only`, activates the network proxy, and permits only
those hosts. It does not give the audit a provider credential or GitHub write
token; the separate issue job remains the only writer. This follows the
[Codex permission-profile contract](https://developers.openai.com/codex/permissions),
where domain rules are enforced only while the network proxy is active.

Audit output distinguishes complete and partial runs. Findings from a partial
run may be published, but prior findings are preserved and the run fails. An
empty result closes prior findings only when the agent explicitly reports that
the complete requested audit succeeded. Fetched pages and repository files are
always evidence, never instructions.

Checks default to `changeScope: "application"`. Pull requests that change only
`.hypervibe` desired state or Hypervibe-managed GitHub files keep the required
check alive but skip checkout, dependency installation, and application
commands. Mixed or unrecognized changes run the complete check. Set
`changeScope: "all"` on a dedicated infrastructure validator that should run
for those files too.

Autofix runs only for a failed run from the same repository on the configured
target branch. It always opens a draft pull request. The generated patch cannot
change `.github/`, `.hypervibe/`, agent instruction files, or `.env` files, and
its validation job receives no OpenAI or live-provider secret. Extra failure
artifacts must be narrow relative result paths; credential-shaped paths and
whole-workspace globs are rejected. External workflow sources must declare both
the artifact name or narrow trailing-wildcard `failureArtifactPattern` and at
least one required path in `failureArtifacts`. Hypervibe passes that pattern to
the artifact downloader, so unrelated artifacts from the failed run are never
fetched. A legacy spec without a pattern remains readable, but reconciliation
blocks until the contract is completed.

```json
{
  "github": {
    "externalWorkflows": {
      "staging-deploy": {
        "workflowName": "Deploy Railway (staging)",
        "failureArtifactPattern": "deploy-staging-failure-evidence",
        "failureArtifacts": ["hypervibe-deploy-failure.log"]
      }
    }
  }
}
```

Missing or incomplete declared evidence is a successful, non-actionable
autofix outcome: the repair agent and patch publication steps do not run.
Artifact transport, authorization, and other unexpected errors still fail the
job. When a patch is produced, both the patch and configured agent's bounded
diagnosis are staged outside the checked-out repository, so the summary cannot
become part of the patch. The summary is included in the draft pull request;
human-facing labels are not tied to one hardcoded model name.

The dependency and security booleans are enable-only controls in this version:
`true` asks Hypervibe to enable and verify the feature; `false` or omission
leaves an existing provider setting alone. Hypervibe does not silently disable
repository security features.

## Connect GitHub

Credential type for the simplest one-token setup: a classic GitHub personal
access token with `repo`, `workflow`, and `read:packages`. Create it with the
[combined Hypervibe scopes](https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages&description=Hypervibe%20CI%20deploys).

For least privilege, use a
[pre-filled fine-grained GitHub personal access token](https://github.com/settings/personal-access-tokens/new?name=Hypervibe%20repository&description=Manage%20one%20repository%20with%20Hypervibe&expires_in=90&actions=write&administration=write&contents=write&environments=write&issues=write&pull_requests=write&secrets=write&actions_variables=write&workflows=write)
for repository management and a separate classic `read:packages` token. Choose
the repository owner and select only the repositories Hypervibe should manage.
The link pre-fills a 90-day expiry and the core permissions below; GitHub still
requires you to choose the resource owner and repositories. Create the package
token from the
[pre-filled GHCR package-read link](https://github.com/settings/tokens/new?scopes=read:packages&description=Hypervibe%20GHCR%20pull).
For the full `github` feature set, grant the fine-grained token:

- Metadata: read (GitHub adds this automatically)
- Administration: read/write
- Actions: read/write
- Contents: read/write
- Pull requests: read/write
- Issues: read/write
- Secrets: read/write
- Workflows: read/write
- Pages: read/write when `github.pages` is declared
- Dependabot alerts: read/write when dependency alerts/updates are enabled
- Code scanning alerts: read/write when code scanning is enabled
- Secret scanning alerts: read/write when secret scanning is enabled

Organization policy can prevent a repository token from enabling Actions,
scanning, or pull-request creation. Hypervibe reports that as blocked rather
than claiming success. GitHub Advanced Security/code scanning can also require
an eligible paid plan for private repositories; enabling it is confirmation-
gated. See [GitHub's fine-grained permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

Store the combined classic token in an exported environment variable or local
`.env` file—not in chat or the repository:

```bash
export NODE_AUTH_TOKEN='ghp_...'
```

Then connect it for exactly one repository:

```text
hv_connections provider="github" scope="OWNER/REPOSITORY" credentialsRef="env:NODE_AUTH_TOKEN"
```

`NODE_AUTH_TOKEN`, `HYPERVIBE_GITHUB_TOKEN`, and
`HYPERVIBE_GITHUB_PACKAGES_TOKEN` are accepted as aliases by Hypervibe; exact
references win and conflicting fallback values block. `NODE_AUTH_TOKEN` is the
recommended single name because npm requires it directly.

For least privilege, a fine-grained repository token can still be supplied as
`apiToken`, with a separate classic `read:packages` PAT as
`packageReadToken`. See [GitHub's PAT guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

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
hv_connections provider="openai" scope="OWNER/REPOSITORY" credentialsRef="env:OPENAI_API_KEY"
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
- CI workflows, collaboration rules, security settings, and iOS release
  workflows are declared in the project spec and reconciled with
  `hv_plan`/`hv_apply`.
- Gated iOS workflows call the repository-owned script declared by
  `ios.release.testflight.scriptPath`; upload/distribution, App Store asset,
  and local Xcode convenience commands are intentionally absent from the
  Hypervibe command surface.

Use `hv_status` after a successful deploy workflow to verify the actual service.

## Runtime error visibility

GitHub workflow autofix repairs failed checks; it does not poll production
service logs. Use `hv_logs source="service" errorsOnly=true` for recent runtime
error lines on a service and `hv_health` for endpoint and deployment health.
Both read through the configured hosting provider connection and do not create
branches or pull requests.

The former environment-level `environments.<env>.autofix` runtime repair agent
has been removed. Existing specs that contain it fail validation with migration
guidance instead of silently losing intent. Scheduled runtime-error alerts or a
desktop error inbox can be added later as a separate desired-state capability.

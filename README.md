# hypervibe

> AI-native infrastructure management. Tell Claude what you need, watch it deploy.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io/)

Hypervibe is an [MCP server](https://modelcontextprotocol.io/) that gives Codex/Claude the ability to manage your infrastructure through natural conversation. Connect your providers once, then deploy, configure, and manage everything by just asking.

```
You: "Deploy my app to staging with a postgres database"

Claude: Creates Railway project, provisions Postgres, wires DATABASE_URL,
        deploys your code, sets up health checks, returns the URL.
```

## Features

**Infrastructure Providers**
- **Railway** - Deploy apps, databases, private S3-compatible storage buckets, cron jobs, queues
- **Cloudflare** - DNS management, domain configuration
- **Stripe** - Payment integration, webhooks, products
- **SendGrid** - Email authentication, domain verification
- **reCAPTCHA** - Bot protection setup

**Secret Managers**
- **HashiCorp Vault** - KV secrets with versioning
- **AWS Secrets Manager** - Native rotation support
- **Doppler** - Simple config management

**Workloads & Queues**
- Services declare `workloadKind: web | worker | cron`. Workers are always-on background consumers (on Cloud Run: internal-only ingress, minimum one instance; they must still listen on `PORT`).
- `queues` in the spec declares named message queues: Cloud Run environments get real Pub/Sub topics + subscriptions (apps receive `QUEUE_TOPIC_*` / `QUEUE_SUBSCRIPTION_*`); Railway environments are postgres-backed (pg-boss model — requires a declared database; apps consume via `DATABASE_URL`). Every queue environment gets `QUEUE_BACKEND` and `QUEUE_NAMES`.
- `storage` declares named private object buckets and an explicit `injectInto` service list. Railway is the first storage provider and works with Railway or cross-provider hosting. Selected services receive the standard `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET_NAME`, `AWS_DEFAULT_REGION`, and `AWS_S3_URL_STYLE` variables; credentials never appear in specs, bindings, plans, or tool output. Bucket deletion is data-bearing and confirmation-gated.

  ```json
  "storage": {
    "documents": {
      "provider": "railway",
      "type": "bucket",
      "region": "sjc",
      "injectInto": ["web", "worker", "cron"]
    }
  }
  ```

  `region` is physical Railway placement (`sjc`, `iad`, `ams`, or `sin`). Railway's S3 credentials still expose signing region `auto`, which Hypervibe passes through as `AWS_DEFAULT_REGION`.

**Developer Experience**
- **Natural language** - No YAML, no clicking through dashboards
- **Auto-wiring** - DATABASE_URL connected automatically
- **Environment management** - Staging, production, PR previews
- **Migration support** - Run Prisma, Drizzle, TypeORM migrations
- **Local development** - Generate Docker Compose for local parity
- **Secret rotation** - Rotate once, propagate to all environments
- **Audit trail** - Track secret access across deploys

## Quick Start

### 1. Install As Codex MCP

```bash
codex mcp add hypervibe -- npx -y @davejohnson/hypervibe@latest
codex mcp list
```

### 2. Install As Claude Code MCP

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "hypervibe": {
      "command": "npx",
      "args": ["-y", "@davejohnson/hypervibe@latest"]
    }
  }
}
```

### 3. Connect Providers

Restart Claude Code, then:

```
You: "Connect to Railway"
Claude: Opens browser for Railway OAuth, saves credentials securely.

You: "Connect Cloudflare with API token xyz..."
Claude: Validates and stores the connection.
```

### 4. Deploy

```
You: "Create a new project called my-app with staging and production environments"
You: "Deploy to staging"
You: "Add a custom domain api.myapp.com"
You: "Run database migrations"
```

### 5. Manage Secrets (Optional)

Connect a secret manager and let hypervibe inject secrets at deploy time:

```
You: "Connect to Vault at https://vault.mycompany.com"
You: "Map DATABASE_URL to vault://secret/data/myapp/db#url"
You: "Deploy to production"
Claude: Resolves secrets from Vault, injects into Railway, deploys.

You: "Rotate the database secret and sync everywhere"
Claude: Rotates in Vault, updates all mapped environments.
```

Secret references use the format: `provider://path[#key][@version]`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code                             │
│                          ▼                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Hypervibe MCP Server                    │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐          │   │
│  │  │ Project  │  │  Deploy  │  │ Secrets  │  ...     │   │
│  │  │  Tools   │  │  Tools   │  │  Tools   │          │   │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘          │   │
│  │       └──────────────┼──────────────┘               │   │
│  │                      ▼                               │   │
│  │  ┌──────────────────────┐  ┌────────────────────┐  │   │
│  │  │  Provider Registry   │  │ Secret Mgr Registry│  │   │
│  │  │ Railway │ Cloudflare │  │ Vault│AWS│Doppler  │  │   │
│  │  └──────────────────────┘  └────────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ▼                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Railway  │  │Cloudflare│  │  Vault   │  │   AWS    │   │
│  │   API    │  │   API    │  │   API    │  │ Secrets  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Available Tools

Hypervibe exposes a focused surface of intent-level `hv_*` tools. The core is a terraform-style loop:

1. `hv_spec_set` — declare the desired state (services, database, storage, domain, email, env vars) as a revisioned spec
2. `hv_plan` — observe live infrastructure, diff against the spec, and get an executable plan
3. `hv_apply planId=...` — converge. Stale plans are rejected; destroying data-bearing resources requires explicit confirmation
4. `hv_status` — see drift between desired and observed state at any time

Around that core: connections (`hv_connect`), deploy/rollback, logs/errors/health, database query/migrate, secrets, domains/DNS, email, payments, CI, App Store/TestFlight, and local dev tools.

- Full generated catalog: `docs/TOOLS.md`
- Regenerate after tool changes: `npm run build && npm run docs:tools`

## Team-Shared Desired State

Hypervibe treats infrastructure as a repo-backed definition, not as one user's private local state. When run from a git worktree, `hv_spec_set` writes the desired infrastructure shape to:

```text
.hypervibe/spec.json
```

Commit that file with the app. It is the shared source of truth for environments, services, cron jobs, databases, delegated secret ownership, domains, email, env vars, deploy strategy, and migrations. When a teammate clones the repo and runs `hv_spec_get`, `hv_plan`, or `hv_status`, Hypervibe reads this file, creates a local project cache if needed, and reports any missing provider connections before apply. The local `project_specs` table is a revision journal behind this file: if `spec.json` is edited outside Hypervibe (or pulled with new changes), the next read adopts it as a new revision and says so in a warning.

Hypervibe also maintains non-secret provider identity bindings in:

```text
.hypervibe/bindings.json
```

This file lets teammates observe and converge the same provider resources instead of planning duplicate projects/services. It is for non-secret IDs such as provider project IDs, environment IDs, service IDs, custom domain bindings, and CI workflow sync metadata. Credentials, tokens, passwords, database URLs, and secret values stay out of the repo and remain local/provider-side.

### Delegated runtime secrets

Use a delegated secret slot when a collaborator, customer, or app owner should supply and rotate a runtime credential without giving it to the repository owner. The spec records the environment-variable name, responsible principal, and target environments, but never the value:

```json
{
  "secrets": {
    "ANTHROPIC_API_KEY": {
      "ownership": "delegated",
      "principal": "github:alice",
      "environments": ["production"],
      "required": true,
      "driftPolicy": "preserve"
    }
  }
}
```

The principal is a non-secret ownership label, not an authenticated Hypervibe identity. Provider membership is still the enforcement boundary: invite Alice to only the Railway/GCP project she needs, keep GitHub review and branch protection enabled, and have her connect her own provider credentials locally. Changing `principal` or a collaborator list in a local checkout does not grant a provider role. Without a hosted control plane, Hypervibe cannot prove that the person supplying a key is `github:alice`; do not auto-apply unreviewed spec changes with an owner/admin credential.

For Anthropic, Alice creates a standard workspace-scoped API key at [Claude Platform API keys](https://platform.claude.com/settings/keys). Claude subscription billing and Claude API billing are separate, so the Platform account/workspace must have API billing configured. She saves the value locally, outside the repository:

```text
# /Users/alice/.config/hypervibe/friend-app.env
ANTHROPIC_API_KEY=...
```

For Railway, she creates her own **Account API token** at [Railway account tokens](https://railway.com/account/tokens), selects **No workspace**, and uses the access granted to her Railway account:

```text
hv_connect provider="railway" credentialsRef="dotenv:/Users/alice/.config/hypervibe/railway.env#HYPERVIBE_RAILWAY_TOKEN"
```

Then she creates and applies a plan without sending either token through chat:

```text
hv_plan project="friend-app" env="production" secretRefs={"ANTHROPIC_API_KEY":"dotenv:/Users/alice/.config/hypervibe/friend-app.env#ANTHROPIC_API_KEY"}
hv_apply project="friend-app" planId="<planId>"
```

The value is resolved on Alice's machine, encrypted into that specific plan, injected into every service in the target environment, and never returned by a tool. Hypervibe records only the principal, a SHA-256 value hash, timestamp, and apply receipt in `.hypervibe/bindings.json`. Ordinary `envVars` and `.env` loading cannot overwrite a delegated key. Missing values, out-of-band drift, or a changed principal produce an inspectable but non-executable plan that preserves the live value until a new explicit `secretRefs` input is supplied.

If a machine or local Hypervibe database is lost, recloning the committed `.hypervibe/spec.json` and `.hypervibe/bindings.json` restores the desired shape and accepted hashes. Provider connections must be reconnected and in-flight plans must be recreated; no runtime secret value is recoverable from the repo.

### Deploy env from `.env`

When `.env.<environment>` or repo `.env` exists, `hv_plan` considers it as a local deploy input. Environment-specific files such as `.env.production` and `.env.staging` win over `.env`. Hypervibe does **not** blindly publish every key. The default policy is `envFile.mode: "runtime"`: Hypervibe syncs high-confidence app runtime keys such as `SENDGRID_API_KEY`, `SESSION_SECRET`, `*_URL`, `*_TOKEN`, `*_SECRET`, `APP_*`, `VITE_*`, and similar names; it skips provider/control-plane credentials such as `RAILWAY_API_TOKEN`, `GITHUB_TOKEN`, and `CLOUDFLARE_API_TOKEN`; it skips local-looking runtime values such as `localhost`, `127.0.0.1`, `0.0.0.0`, `host.docker.internal`, `.local`, and `.internal`; and it reports ignored key names in the plan.

Tune this per environment in `.hypervibe/spec.json`:

```json
{
  "envFile": {
    "mode": "explicit",
    "include": ["SENDGRID_API_KEY", "CUSTOM_WORKER_FLAG"],
    "exclude": ["LOCAL_DEBUG_FLAG"]
  }
}
```

Modes are `runtime` (default), `all`, `explicit`, and `off`. Values loaded from the env file are encrypted into the plan and never printed. The plan warning names the env file path and selected keys so the agent can show the user exactly what source is being applied. Generated infrastructure values such as `DATABASE_URL` still win over stale local `.env` values.

### Database data operations

Do not temporarily change a service `releaseCommand` just to seed or import production data. Release commands are desired deploy configuration for repeatable schema work, such as `migrations: { "mode": "releaseCommand", "command": "npm run db:migrate" }`.

For fresh environments, declare seed/bootstrap data on the database. This is provider-neutral desired state; it works through the normal plan/apply flow for any supported hosting/database target:

```json
{
  "database": {
    "provider": "supabase",
    "engine": "postgres",
    "seedCommand": "npm run db:seed"
  }
}
```

`hv_plan` emits a visible one-shot database seed action. `hv_apply` runs it after the database exists as a one-off command inside the deployed service environment, then records the command hash plus `seededAt` on the database component. The command does not run again unless the command changes.

Use `hv_db_migrate` for operational data work:

- `mode: "move"` copies data from the previous provider database into the current database during a staged migration, using `pg_dump | pg_restore` plus row-count verification. This is the path for moves like Cloud SQL -> Railway Postgres. If the target Railway database is private-only, the confirmed move creates or reuses a Railway TCP proxy so the local PostgreSQL tools can reach it.
- `mode: "seed"` explicitly re-runs a seed/bootstrap command against the target database without changing service config. This is for repair/re-seed operations, not the normal fresh-environment path. Hypervibe sets `DATABASE_URL` and `DIRECT_URL` for that command, masks the URL in output, and confirm-gates the operation.

Example:

```text
hv_db_migrate project="my-app" env="production" mode="seed" command="npm run db:seed"
```

Typical team flow:

1. One person changes infrastructure through Hypervibe, such as adding a cron service.
2. Hypervibe updates `.hypervibe/spec.json` and, after apply, `.hypervibe/bindings.json`.
3. They commit those files.
4. Teammates pull, run `hv_plan`, and see the same desired shape and provider bindings.
5. Each teammate connects their own provider credentials locally with `hv_connect` when needed.

## Provider Credentials

### Cloudflare token permissions

Recommended default for DNS, custom domains, and email routing: use a **Cloudflare Account API Token** plus `accountId`. Cloudflare recommends Account API Tokens for automation credentials that are not associated with a specific user.

Create the recommended Account API Token here:

```text
Cloudflare dashboard -> Manage Account -> Account API Tokens
https://dash.cloudflare.com/?to=/:account/api-tokens
```

Set these permissions and resources:

```text
Permissions:
- Zone -> Zone -> Read
- Zone -> Zone Settings -> Read or Edit
- Zone -> DNS -> Edit
- Zone -> Email Routing Rules -> Edit (for hv_email_setup/hv_email_forwarding)
- Account -> Email Routing Addresses -> Edit (to create/verify forwarding destinations)
- Account -> Account Settings -> Read (lets Hypervibe auto-resolve accountId)

Zone Resources:
- Include -> Specific zone -> example.com
```

Use the generated token secret itself as `CLOUDFLARE_API_TOKEN`; do not use the token name, token id, or legacy Global API Key. New User API Tokens usually start with `cfut_`; Account API Tokens usually start with `cfat_`.

Connect without pasting the token into chat. If the values are in an existing `.env` file, reference the keys directly instead of copying them to a temporary file:

```text
hv_connect provider=cloudflare scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}
```

Hypervibe accepts either a raw token or a copied authorization value such as `Bearer <token>` for Cloudflare.

If Hypervibe needs Cloudflare Registrar/domain purchase, use a **User API Token** instead because Cloudflare Registrar is not compatible with Account API Tokens. Create it under `My Profile -> API Tokens -> Create Token -> Edit zone DNS`, add the same zone permissions above, and connect it without `accountId`:

```text
Cloudflare dashboard -> My Profile -> API Tokens
https://dash.cloudflare.com/profile/api-tokens
```

```text
hv_connect provider=cloudflare scope="example.com" credentialsRef="dotenv:/absolute/path/.env#CLOUDFLARE_API_TOKEN"
```

If the token is valid but Hypervibe cannot confirm zone access during `hv_connect`, the connection is still saved and verified with a warning; `hv_plan`/`hv_apply` will surface any remaining DNS or registrar-specific blockers.

### GitHub token permissions

Recommended: connect without pasting the token into chat by exporting it locally:

```bash
export HYPERVIBE_GITHUB_TOKEN=ghp_...
```

Then call `hv_connect provider=github credentialsRef="env:HYPERVIBE_GITHUB_TOKEN"`. For existing `.env` files, use `credentialsRef="dotenv:/absolute/path/.env#HYPERVIBE_GITHUB_TOKEN"`. For JSON credentials, save the JSON to a local file and use `credentialsRef="file:/absolute/path/to/credentials.json"`. If the user intentionally wants to enter credentials in chat, `credentials={...}` is still accepted.

**Recommended for CI deploys: a classic PAT with `repo`, `workflow`, and `read:packages`**, created by a user with access to the target repositories. Create it from:

```text
https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages&description=Hypervibe%20CI%20deploys
```

That one token can be used for both:

- `apiToken`: GitHub API work such as writing `.github/workflows/*`, reading Actions runs/jobs/logs, triggering workflows, and creating repository secrets.
- `packageReadToken`: durable GHCR image-pull credentials for Railway image deploys.

For an existing `.env` file with one token:

```text
HYPERVIBE_GITHUB_TOKEN=ghp_...
```

Connect it like this:

```text
hv_connect provider=github scope="owner/repo" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"HYPERVIBE_GITHUB_TOKEN","packageReadToken":"HYPERVIBE_GITHUB_TOKEN"}
```

For least privilege, use two classic PATs:

```text
HYPERVIBE_GITHUB_TOKEN=ghp_...             # scopes: repo, workflow
HYPERVIBE_GITHUB_PACKAGES_TOKEN=ghp_...    # scopes: read:packages
```

Then connect:

```text
hv_connect provider=github scope="owner/repo" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"HYPERVIBE_GITHUB_TOKEN","packageReadToken":"HYPERVIBE_GITHUB_PACKAGES_TOKEN"}
```

A token with only `read:packages` is **not** enough for Hypervibe CI deploy setup. It can be used as `packageReadToken`, but the `apiToken` still needs `repo` + `workflow` for classic PATs so Hypervibe can manage workflows and repository secrets.

What hypervibe uses the GitHub token for, and the permission each operation needs:

| Operation | Classic PAT scope | Fine-grained permission |
|---|---|---|
| Commit CI/config files (`hv_ci_setup`: workflows, AI review, SEO files) | `repo` (+ `workflow` for files under `.github/workflows/`) | Contents: read/write |
| List/trigger Actions workflows, read runs/jobs/logs (`hv_ci_status`, `hv_ci_trigger`) | `repo` | Actions: read/write |
| Set/delete Actions repo secrets (`hv_secrets_set target="github"`) | `repo` | Secrets: read/write |
| Branch protection (`hv_ci_setup kind="branch-protection"`) | `repo` + repo admin | Administration: read/write |
| Generated push deploys (`hv_ci_setup kind="deploy-branch"`) | `repo` + `workflow`; add Secrets read/write if Hypervibe should sync provider API tokens | Contents: read/write, Actions: read/write, Secrets: read/write, Environments: read/write |
| Manage the Railway GitHub App's repository access for `deploy.trigger: "native"` selected-repos installs | `repo` + repo admin — **classic PAT only**; GitHub's app-installation APIs do not accept fine-grained PATs | not supported |
| Private repo source fetch for Cloud Run builds | `repo` | Contents: read |

Fine-grained PATs can work for some GitHub API operations when granted the permissions in the table, but GitHub Packages/GHCR package authentication still requires a classic PAT. If you use a fine-grained PAT as `apiToken`, still provide a classic PAT with `read:packages` as `packageReadToken` for Railway GHCR deploys.

### Push deploys

`deploy.strategy: "branch"` defaults to `deploy.trigger: "ci"`. Hypervibe sets up push deploys by writing GitHub Actions workflows that call provider APIs directly; it does not install or depend on provider CLIs.

Typical setup:

- Define the environment with `deploy: { strategy: "branch", branch: "main" }` or an explicit `trigger: "ci"`.
- Run `hv_apply` first so Hypervibe records provider project, environment, and service ID bindings.
- Run `hv_ci_setup kind="deploy-branch" config={"provider":"<provider>"}`.
- Check the returned `requiredSecrets`, `syncedSecrets`, `manualSecrets`, and `requiredVariables`. Hypervibe syncs provider API credentials to GitHub Actions secrets when the provider connection is verified and the GitHub token can write repo secrets.

Provider workflow behavior:

| Provider | Generated GitHub Actions deploy path | Usually synced from verified connection | Manual GitHub values when Hypervibe does not already know IDs |
|---|---|---|---|
| `railway` | Build/push OCI image to GHCR with GitHub's built-in workflow token, update `ServiceInstance.source.image` via Railway GraphQL, then trigger deploy via Railway GraphQL | `RAILWAY_API_TOKEN`; `IMAGE_REGISTRY_USERNAME`/`IMAGE_REGISTRY_TOKEN` from the verified GitHub connection | Variables: `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_IDS` |
| `cloudrun` | Build/push OCI image to Google Artifact Registry, patch Cloud Run services through Google APIs | `GCP_SERVICE_ACCOUNT_JSON`, `GCP_PROJECT_ID`, `GCP_REGION` | Variable: `CLOUDRUN_SERVICE_NAMES`; optional variable: `GCP_ARTIFACT_REPOSITORY` |

Every generated workflow checks the selected environment's committed desired
state before building. Hypervibe stores the last successfully applied
environment contract hash in the environment-scoped GitHub Actions variable
`HYPERVIBE_APPLIED_SPEC_HASH`. Code-only commits retain the same hash and
continue to auto-deploy to staging. A commit that changes the environment
contract stops before image build until the exact commit is reconciled:

1. Check out the target commit.
2. Run `hv_plan` and review the environment plan.
3. Run `hv_apply` so all desired-state actions complete and the final hash
   marker advances.
4. Trigger that commit with `hv_ci_trigger`, inspect it with `hv_ci_status`,
   and verify it with `hv_health`.

The marker is environment-specific: production-only desired-state changes do
not block staging. Production workflows remain manual and enforce the same
reconciliation check for the promoted SHA.

For Railway GHCR deploys, the generated workflow grants `packages: write` and uses `${{ github.actor }}` plus `${{ secrets.GITHUB_TOKEN }}` only for the workflow-time image push. The hosting provider also needs durable image-pull credentials because GitHub's workflow token is short-lived and only exists inside the Actions job. Hypervibe syncs those pull credentials into `IMAGE_REGISTRY_USERNAME` and `IMAGE_REGISTRY_TOKEN` from the verified GitHub connection when it has a login and a package-read-capable `packageReadToken`. Do not use `${{ secrets.GITHUB_TOKEN }}` for `IMAGE_REGISTRY_TOKEN`, and do not use a `read:packages`-only token as the GitHub `apiToken`.

When Hypervibe syncs GitHub Actions secrets, it records only secret names plus local one-way value hashes. If the local provider token changes later, `hv_plan` will report the CI deploy action as needing an update and `hv_apply` will resync the GitHub secret value. Raw secret values are never written to `.hypervibe/spec.json`, `.hypervibe/bindings.json`, or tool output.

To repair a stale GitHub Actions secret without pasting the token into chat, point `hv_secrets_set` at the local source of truth:

```text
hv_secrets_set project="apreskeys.com" target="github" repo="davejohnson/apreskeys.com" key="IMAGE_REGISTRY_TOKEN" secretRef="dotenv:/Users/dave/projects/condoshare/.env#GHCR_TOKEN"
```

For any Hypervibe-managed GitHub Actions deploy, inspect the workflow and logs through Hypervibe itself. Agents should use `hv_ci_status` instead of `gh`, GitHub connectors/apps, browser/UI inspection, or direct GitHub API calls so the verified connection, diagnostics, and audit boundary stay coherent:

```text
hv_ci_status project="apreskeys.com" repo="davejohnson/apreskeys.com" include=["logs"] runId=28272281787
```

If the logs contain `docker buildx imagetools inspect ... ghcr.io ... 403 Forbidden`, the workflow has not reached Railway yet. Fix `IMAGE_REGISTRY_USERNAME` and `IMAGE_REGISTRY_TOKEN` first; Railway will not show a new deploy attempt until GHCR image verification can read the image.

`deploy.trigger: "native"` opts into provider-native repo integrations instead. For Railway native push autodeploys, grant the [Railway GitHub App](https://github.com/apps/railway-app) access in GitHub:

- Install/open the [Railway GitHub App](https://github.com/apps/railway-app/installations/new) and grant it access to the repo. If it is installed for "Only select repositories", add the target repo.
- Make sure at least one Railway project member has connected GitHub and has contributor access to the repo.
- Accept any pending permission updates for the Railway GitHub App in GitHub.
- After permission changes, wait a few minutes for Railway caches to refresh, then rerun `hv_status` or `hv_plan`.
- If Railway still cannot see the repo, disconnect/reconnect the service source in Railway, refresh Add -> GitHub Repository, or reinstall the Railway GitHub App.

### Secret managers

1Password uses a [service account token](https://developer.1password.com/docs/service-accounts/) — grant it only the vault(s) the project should read. Bitwarden Secrets Manager uses a [machine account access token](https://bitwarden.com/help/access-tokens/) plus the organization id. Both integrations are resolve-only: hypervibe reads values at deploy time and never writes them back or stores them locally.

## Configuration

Hypervibe stores data locally:
- **Database**: `~/.hypervibe/hypervibe.db` (SQLite)
- **Secrets**: Encrypted with `~/.hypervibe/.secret-key`

No data is sent to external servers except the providers you connect.

You can override the storage location by setting `HYPERVIBE_DATA_DIR` when launching the MCP server.

## Updating Existing Projects

Hypervibe has three kinds of state to keep current:

- **The installed Hypervibe package** in Codex, Claude, or another MCP client.
- **Local Hypervibe state** in `~/.hypervibe`, especially the SQLite database schema and encrypted provider connections.
- **Repo-backed project state** in `.hypervibe/spec.json` and `.hypervibe/bindings.json`, which should be committed with the app.

The default install command uses `@davejohnson/hypervibe@latest`, so users should not need to know or remember a package-upgrade command. When Codex, Claude, or another MCP client restarts the Hypervibe server, `npx` resolves the latest published package and Hypervibe automatically runs any pending SQLite migrations at startup.

Normal update flow:

1. Restart the MCP client/server so `npx -y @davejohnson/hypervibe@latest` starts the newest published package.
2. In each app repo, pull the latest `.hypervibe/spec.json` and `.hypervibe/bindings.json`, then run `hv_status` or `hv_plan`.
3. Commit any intended changes Hypervibe makes to `.hypervibe/spec.json`, `.hypervibe/bindings.json`, generated CI workflows, or other repo files.

`hv_upgrade` is a diagnostic/repair tool, not a required user ritual. Use it when something looks stale or after changing the MCP install command; it reports the running package version, local SQLite schema version, pending migrations, repo spec/bindings status, and connection counts. If it reports pending SQLite migrations, run `hv_upgrade action="migrate"` and restart the MCP server once more.

Provider credentials remain local and encrypted. Database component bindings (connection URLs, passwords) are also encrypted at rest. The encryption key lives in `~/.hypervibe/.secret-key` (0600); back it up — regenerating it makes previously encrypted data unrecoverable. Set `HYPERVIBE_SECRET_KEY` (64 hex chars) to supply the key externally (CI, containers). Teammates may still need to run `hv_connect` for their own Railway, GitHub, Cloudflare, SendGrid, AWS, or GCP access after installing Hypervibe, but ordinary Hypervibe package and SQLite schema upgrades should happen on restart.

`workloadKind: "job"` was removed from the service spec — it never had run-to-completion deploy semantics. Specs using it fail validation; choose `worker` (always-on, internal-only on Cloud Run with a minimum of one instance — note Cloud Run workers must still listen on `PORT`) or `cron` (scheduled). Railway's observe cannot distinguish `web` from `worker`, so kind drift is not detected there.

Hosting support for Vercel, Render, Heroku, DigitalOcean, and AWS App Runner (plus AWS RDS databases) was removed. Specs that reference those providers no longer validate; move the environment to `railway` or `cloudrun` (databases: `supabase`, `cloudsql`, or `railway`) and re-run `hv_plan`. Stored connections for removed providers can still be deleted with `hv_connect action="remove"`.

The `redis`, `mysql`, and `mongodb` component types were removed — `postgres` is the only provisionable datastore. Existing live Redis/MySQL/MongoDB instances are no longer managed and observe as `unknown` engines.

## Adding New Providers

Providers self-register through the plugin system:

```typescript
// src/adapters/providers/example/example.adapter.ts
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

export class ExampleAdapter implements IProvider {
  // ... implementation
}

providerRegistry.register({
  metadata: {
    name: 'example',
    displayName: 'Example Provider',
    category: 'dns',
    credentialsSchema: ExampleCredentialsSchema,
  },
  factory: (credentials) => new ExampleAdapter(credentials),
});
```

Then import in `server.ts`:
```typescript
import './adapters/providers/example/example.adapter.js';
```

## Philosophy

**Let LLMs handle the fuzzy stuff.** Hypervibe returns raw data and lets your agent interpret it. No complex pattern matching or hardcoded rules—your agent figures out that "prod-us-east" means production.

**Simple shortcuts are fine.** Exact matches for `production`, `staging`, `development` work instantly. Everything else? Claude handles it.

**Two-step flows for safety.** Import and destructive operations show you what will happen first, then ask for confirmation.

## License

Apache 2.0 - See [LICENSE](LICENSE) for details.

---

Built for [Claude Code](https://claude.ai/code). Powered by [MCP](https://modelcontextprotocol.io/).

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
- **Railway** - Deploy apps, databases, Redis, cron jobs
- **Cloudflare** - DNS management, domain configuration
- **Stripe** - Payment integration, webhooks, products
- **SendGrid** - Email authentication, domain verification
- **reCAPTCHA** - Bot protection setup

**Secret Managers**
- **HashiCorp Vault** - KV secrets with versioning
- **AWS Secrets Manager** - Native rotation support
- **Doppler** - Simple config management

**Developer Experience**
- **Natural language** - No YAML, no clicking through dashboards
- **Auto-wiring** - DATABASE_URL, REDIS_URL connected automatically
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

1. `hv_spec_set` — declare the desired state (services, database, domain, email, env vars) as a revisioned spec
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

Commit that file with the app. It is the shared source of truth for environments, services, cron jobs, databases, domains, email, env vars, deploy strategy, and migrations. When a teammate clones the repo and runs `hv_spec_get`, `hv_plan`, or `hv_status`, Hypervibe reads this file, creates a local project cache if needed, and reports any missing provider connections before apply.

Hypervibe also maintains non-secret provider identity bindings in:

```text
.hypervibe/bindings.json
```

This file lets teammates observe and converge the same provider resources instead of planning duplicate projects/services. It is for non-secret IDs such as provider project IDs, environment IDs, service IDs, custom domain bindings, and CI workflow sync metadata. Credentials, tokens, passwords, database URLs, and secret values stay out of the repo and remain local/provider-side.

Typical team flow:

1. One person changes infrastructure through Hypervibe, such as adding a cron service.
2. Hypervibe updates `.hypervibe/spec.json` and, after apply, `.hypervibe/bindings.json`.
3. They commit those files.
4. Teammates pull, run `hv_plan`, and see the same desired shape and provider bindings.
5. Each teammate connects their own provider credentials locally with `hv_connect` when needed.

## Provider Credentials

### Cloudflare token permissions

Recommended default: use a **User API Token**, not an Account API Token, because Hypervibe may need both DNS automation and Cloudflare Registrar/domain-purchase APIs. Account API Tokens can work for DNS when paired with `accountId`, but Cloudflare Registrar is not compatible with Account API Tokens.

Create the recommended User API Token here:

```text
Cloudflare dashboard -> My Profile -> API Tokens -> Create Token -> Edit zone DNS
https://dash.cloudflare.com/profile/api-tokens
```

Set these permissions and resources:

```text
Permissions:
- Zone -> Zone -> Read
- Zone -> DNS -> Edit/Write

Zone Resources:
- Include -> Specific zone -> example.com
```

Use the generated token secret itself as `CLOUDFLARE_API_TOKEN`; do not use the token name, token id, or legacy Global API Key. New User API Tokens usually start with `cfut_`; Account API Tokens usually start with `cfat_`.

Connect without pasting the token into chat. If the value is already exported:

```bash
export CLOUDFLARE_API_TOKEN=...
```

Then call `hv_connect provider=cloudflare scope="example.com" credentialsRef="env:CLOUDFLARE_API_TOKEN"`.

If the value is in an existing `.env` file, reference the key directly instead of copying it to a temporary file:

```text
hv_connect provider=cloudflare scope="example.com" credentialsRef="dotenv:/absolute/path/.env#CLOUDFLARE_API_TOKEN"
```

Hypervibe accepts either a raw token or a copied authorization value such as `Bearer <token>` for Cloudflare.

For an Account API Token, create it under `Manage Account -> Account API Tokens`, include the same zone permissions above, and connect it with `accountId`:

```text
hv_connect provider=cloudflare scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}
```

If the token is valid but Hypervibe cannot confirm zone access during `hv_connect`, the connection is still saved and verified with a warning; `hv_plan`/`hv_apply` will surface any remaining DNS or registrar-specific blockers.

### GitHub token permissions

Recommended: connect without pasting the token into chat by exporting it locally:

```bash
export HYPERVIBE_GITHUB_TOKEN=ghp_...
```

Then call `hv_connect provider=github credentialsRef="env:HYPERVIBE_GITHUB_TOKEN"`. For existing `.env` files, use `credentialsRef="dotenv:/absolute/path/.env#HYPERVIBE_GITHUB_TOKEN"`. For JSON credentials, save the JSON to a local file and use `credentialsRef="file:/absolute/path/to/credentials.json"`. If the user intentionally wants to enter credentials in chat, `credentials={...}` is still accepted.

**Recommended: a classic PAT with the `repo` and `workflow` scopes**, created by a user with **admin access** to the target repositories. That covers everything below.

What hypervibe uses the GitHub token for, and the permission each operation needs:

| Operation | Classic PAT scope | Fine-grained permission |
|---|---|---|
| Commit CI/config files (`hv_ci_setup`: workflows, AI review, Pages CNAME, SEO files) | `repo` (+ `workflow` for files under `.github/workflows/`) | Contents: read/write |
| List/trigger Actions workflows, read runs (`hv_ci_status`, `hv_ci_trigger`) | `repo` | Actions: read/write |
| Set/delete Actions repo secrets (`hv_secrets_set target="github"`) | `repo` | Secrets: read/write |
| Branch protection (`hv_ci_setup kind="branch-protection"`) | `repo` + repo admin | Administration: read/write |
| GitHub Pages (`hv_ci_setup kind="pages"`) | `repo` | Pages: read/write |
| Generated push deploys (`hv_ci_setup kind="deploy-branch"`) | `repo` + `workflow`; add Secrets read/write if Hypervibe should sync provider API tokens | Contents: read/write, Actions: read/write, Secrets: read/write |
| Manage the Railway GitHub App's repository access for `deploy.trigger: "native"` selected-repos installs | `repo` + repo admin — **classic PAT only**; GitHub's app-installation APIs do not accept fine-grained PATs | not supported |
| Private repo source fetch for Cloud Run builds | `repo` | Contents: read |

### Push deploys

`deploy.strategy: "branch"` defaults to `deploy.trigger: "ci"`. Hypervibe sets up push deploys by writing GitHub Actions workflows that call provider APIs directly; it does not install or depend on provider CLIs.

Typical setup:

- Define the environment with `deploy: { strategy: "branch", branch: "main" }` or an explicit `trigger: "ci"`.
- Run `hv_apply` first so Hypervibe records provider project, environment, service ID, and service ARN bindings.
- Run `hv_ci_setup kind="deploy-branch" config={"provider":"<provider>"}`.
- Check the returned `requiredSecrets`, `syncedSecrets`, `manualSecrets`, and `requiredVariables`. Hypervibe syncs provider API credentials to GitHub Actions secrets when the provider connection is verified and the GitHub token can write repo secrets.

Provider workflow behavior:

| Provider | Generated GitHub Actions deploy path | Usually synced from verified connection | Manual GitHub values when Hypervibe does not already know IDs |
|---|---|---|---|
| `railway` | Build/push OCI image to GHCR with GitHub's built-in workflow token, update `ServiceInstance.source.image` via Railway GraphQL, then trigger deploy via Railway GraphQL | `RAILWAY_API_TOKEN`; `IMAGE_REGISTRY_USERNAME`/`IMAGE_REGISTRY_TOKEN` from the verified GitHub connection | Variables: `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_IDS` |
| `cloudrun` | Build/push OCI image to Google Artifact Registry, patch Cloud Run services through Google APIs | `GCP_SERVICE_ACCOUNT_JSON`, `GCP_PROJECT_ID`, `GCP_REGION` | Variable: `CLOUDRUN_SERVICE_NAMES`; optional variable: `GCP_ARTIFACT_REPOSITORY` |
| `apprunner` | Build/push OCI image to ECR, update App Runner services through AWS signed API requests | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | Variable: `APPRUNNER_SERVICE_ARNS`; optional variable: `AWS_ECR_REPOSITORY` |
| `render` | Trigger Render service deploys through the Render API | `RENDER_API_KEY` | Variable: `RENDER_SERVICE_IDS` |
| `digitalocean` | Build/push OCI image to GHCR with GitHub's built-in workflow token, update App Platform services to use that image through the DigitalOcean API, then trigger deployment | `DIGITALOCEAN_ACCESS_TOKEN`; `IMAGE_REGISTRY_USERNAME`/`IMAGE_REGISTRY_TOKEN` from the verified GitHub connection | Variables: `DO_APP_ID`, `DO_SERVICE_NAMES` |
| `heroku` | Build/push OCI image to Heroku Container Registry and release the `web` process through the Heroku API | `HEROKU_API_KEY` | Variable: `HEROKU_APP` |
| `vercel` | Trigger a Vercel deploy hook from GitHub Actions | none | Secret: `VERCEL_DEPLOY_HOOK_URL` |

For Railway and DigitalOcean GHCR deploys, the generated workflow grants `packages: write` and uses `${{ github.actor }}` plus `${{ secrets.GITHUB_TOKEN }}` only for the workflow-time image push. The hosting provider also needs durable image-pull credentials because GitHub's workflow token is short-lived and only exists inside the Actions job. Hypervibe syncs those pull credentials into `IMAGE_REGISTRY_USERNAME` and `IMAGE_REGISTRY_TOKEN` from the verified GitHub connection when it has a login and package-read-capable token. If you prefer least privilege, connect GitHub with `packagesToken`/`packageReadToken` set to a package token with `read:packages`; otherwise Hypervibe falls back to the GitHub connection `apiToken`. Do not use `${{ secrets.GITHUB_TOKEN }}` for `IMAGE_REGISTRY_TOKEN`.

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

Provider credentials remain local and encrypted. Teammates may still need to run `hv_connect` for their own Railway, GitHub, Cloudflare, SendGrid, AWS, or GCP access after installing Hypervibe, but ordinary Hypervibe package and SQLite schema upgrades should happen on restart.

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

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
codex mcp add hypervibe -- npx hypervibe
codex mcp list
```

### 2. Install As Claude Code MCP

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "hypervibe": {
      "command": "npx",
      "args": ["hypervibe"]
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

### Project Management
- `project_create` - Create new projects
- `project_list` - List all projects
- `project_import` - Import existing Railway projects

### Deployment
- `deploy` - Deploy to an environment
- `deploy_status` - Check deployment status
- `deploy_logs` - View deployment logs

### Database
- `db_migrate` - Run migrations (Prisma, Drizzle, TypeORM, etc.)
- `db_url` - Get database connection URL

### DNS (Cloudflare)
- `dns_zones` - List DNS zones
- `dns_records` - Manage DNS records
- `dns_add_domain` - Add custom domains

### Integrations
- `stripe_*` - Products, prices, webhooks
- `sendgrid_*` - Domain authentication, email
- `recaptcha_*` - Site key management

### Secret Management
- `secrets_list` - List secrets from Vault/AWS/Doppler
- `secrets_get` - Get a secret value (masked)
- `secrets_set` - Create or update secrets
- `secrets_map` - Map secrets to env vars for deploy
- `secrets_sync` - Resolve and push to environments
- `secrets_rotate` - Rotate and propagate everywhere
- `secrets_audit` - View access audit log

### Setup & Debugging
- `setup_scan` - Scan for configuration issues
- `setup_fix` - Auto-fix common problems
- `errors_recent` - View recent errors from logs

## Configuration

Hypervibe stores data locally:
- **Database**: `~/.hypervibe/hypervibe.db` (SQLite)
- **Secrets**: Encrypted with `~/.hypervibe/.secret-key`

No data is sent to external servers except the providers you connect.

You can override the storage location by setting `HYPERVIBE_DATA_DIR` when launching the MCP server.

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

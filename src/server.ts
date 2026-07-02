import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Import adapters for auto-registration (must be before registerConnectionTools)
// Hosting platforms
import './adapters/providers/railway/railway.adapter.js';
import './adapters/providers/gcp/cloudrun.adapter.js';

// Database providers (Railway Postgres is handled via the Railway adapter shim in adapterFactory)
import './adapters/providers/supabase/supabase.adapter.js';
import './adapters/providers/gcp/cloudsql.adapter.js';

// Other providers
import './adapters/providers/stripe/stripe.adapter.js';
import './adapters/providers/cloudflare/cloudflare.adapter.js';
import './adapters/providers/sendgrid/sendgrid.adapter.js';
import './adapters/providers/tunnel/tunnel.manager.js';
import './adapters/providers/local/compose.generator.js';
import './adapters/providers/recaptcha/recaptcha.adapter.js';
import './adapters/providers/github/github.adapter.js';
import './adapters/providers/database/database.adapter.js';
import './adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import './adapters/providers/xcode/xcode.adapter.js';

// Secret manager providers
import './adapters/providers/secretmanagers/vault.adapter.js';
import './adapters/providers/secretmanagers/aws-secrets.adapter.js';
import './adapters/providers/secretmanagers/doppler.adapter.js';
import './adapters/providers/secretmanagers/onepassword.adapter.js';
import './adapters/providers/secretmanagers/bitwarden.adapter.js';

import { createToolContext } from './tools/context.js';
import { registerCoreTools } from './tools/core.tools.js';
import { registerLifecycleTools } from './tools/lifecycle.tools.js';
import { registerConnectionsTools } from './tools/connections.tools.js';
import { registerHvDeployTools } from './tools/hv-deploy.tools.js';
import { registerHvObservabilityTools } from './tools/hv-observability.tools.js';
import { registerHvDbTools } from './tools/hv-db.tools.js';
import { registerHvSecretsTools } from './tools/hv-secrets.tools.js';
import { registerHvEmailTools } from './tools/hv-email.tools.js';
import { registerHvPaymentsTools } from './tools/hv-payments.tools.js';
import { registerHvCiTools } from './tools/hv-ci.tools.js';
import { registerHvAppstoreTools } from './tools/hv-appstore.tools.js';
import { registerHvDevxTools } from './tools/hv-devx.tools.js';

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'hypervibe',
      version: '0.1.0',
    },
    {
      instructions: [
        'Hypervibe manages deployment infrastructure (hosting, databases, DNS, email, secrets, CI) through its hv_* tools.',
        'Always use hv_* tools for infrastructure operations. Do NOT shell out to provider CLIs (railway, gcloud, vercel, doppler, op, bws, gh, etc.) or call provider APIs directly: Hypervibe holds the verified credentials, records run/audit history, and keeps its local state in sync — a CLI bypasses all of that and causes state drift.',
        'Core workflow: hv_spec_set (desired state) → hv_plan (diff against live infrastructure, returns planId) → hv_apply planId=... → hv_status / hv_logs / hv_health to verify.',
        'Custom domain and DNS changes must be modeled as desired infrastructure and reconciled through hv_plan/hv_apply. Do not bypass a blocked apply with one-off DNS/provider mutations.',
        'If a capability seems missing, check the other hv_* tools (most have action/target parameters) before reaching for anything outside Hypervibe.',
      ].join('\n'),
    }
  );

  const ctx = createToolContext();

  // The consolidated intent-level tool surface (41 hv_* tools).
  registerCoreTools(server, ctx);
  registerLifecycleTools(server, ctx);
  registerConnectionsTools(server, ctx);
  registerHvDeployTools(server, ctx);
  registerHvObservabilityTools(server, ctx);
  registerHvDbTools(server, ctx);
  registerHvSecretsTools(server, ctx);
  registerHvEmailTools(server, ctx);
  registerHvPaymentsTools(server, ctx);
  registerHvCiTools(server, ctx);
  registerHvAppstoreTools(server, ctx);
  registerHvDevxTools(server, ctx);

  return server;
}

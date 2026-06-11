import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Import adapters for auto-registration (must be before registerConnectionTools)
// Hosting platforms
import './adapters/providers/railway/railway.adapter.js';
import './adapters/providers/digitalocean/digitalocean.adapter.js';
import './adapters/providers/render/render.adapter.js';
import './adapters/providers/vercel/vercel.adapter.js';
import './adapters/providers/heroku/heroku.adapter.js';
import './adapters/providers/aws/apprunner.adapter.js';
import './adapters/providers/gcp/cloudrun.adapter.js';

// Database providers (Railway Postgres is handled via the Railway adapter shim in adapterFactory)
import './adapters/providers/supabase/supabase.adapter.js';
import './adapters/providers/aws/rds.adapter.js';
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

import { registerProjectTools } from './tools/project.tools.js';
import { registerEnvironmentTools } from './tools/environment.tools.js';
import { registerConnectionTools } from './tools/connection.tools.js';
import { registerDeployTools } from './tools/deploy.tools.js';
import { registerRailwayTools } from './tools/railway.tools.js';
import { registerLocalTools } from './tools/local.tools.js';
import { registerRunTools } from './tools/run.tools.js';
import { registerIntegrationTools } from './tools/integration.tools.js';
import { registerStripeTools } from './tools/stripe.tools.js';
import { registerCloudflareTools } from './tools/cloudflare.tools.js';
import { registerSendGridTools } from './tools/sendgrid.tools.js';
import { registerTunnelTools } from './tools/tunnel.tools.js';
import { registerLogsTools } from './tools/logs.tools.js';
import { registerRecaptchaTools } from './tools/recaptcha.tools.js';
import { registerEnvTools } from './tools/env.tools.js';
import { registerDbTools } from './tools/db.tools.js';
import { registerSetupTools } from './tools/setup.tools.js';
import { registerGitHubTools } from './tools/github.tools.js';
import { registerAppStoreTools } from './tools/appstore.tools.js';
import { registerXcodeTools } from './tools/xcode.tools.js';
import { registerVisualizeTools } from './tools/visualize.tools.js';
import { registerAutoFixTools } from './tools/autofix.tools.js';
import { registerSecretsTools } from './tools/secrets.tools.js';
import { registerInfraTools } from './tools/infra.tools.js';
import { registerMarketingTools } from './tools/marketing.tools.js';
import { registerWorkflowTools } from './tools/workflow.tools.js';
import { registerGcpTools } from './tools/gcp.tools.js';
import { registerHealthTools } from './tools/health.tools.js';
import { registerEmailTools } from './tools/email.tools.js';
import { createToolContext } from './tools/context.js';
import { registerCoreTools } from './tools/core.tools.js';
import { registerLifecycleTools } from './tools/lifecycle.tools.js';
import { registerConnectionsTools } from './tools/connections.tools.js';
import { registerHvDeployTools } from './tools/hv-deploy.tools.js';
import { registerHvObservabilityTools } from './tools/hv-observability.tools.js';
import { registerHvDbTools } from './tools/hv-db.tools.js';
import { registerHvSecretsTools } from './tools/hv-secrets.tools.js';
import { registerHvDomainsTools } from './tools/hv-domains.tools.js';
import { registerHvEmailTools } from './tools/hv-email.tools.js';
import { registerHvPaymentsTools } from './tools/hv-payments.tools.js';
import { registerHvCiTools } from './tools/hv-ci.tools.js';
import { registerHvAppstoreTools } from './tools/hv-appstore.tools.js';
import { registerHvDevxTools } from './tools/hv-devx.tools.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'hypervibe',
    version: '0.1.0',
  });

  const ctx = createToolContext();

  // New intent-level surface (hv_*) — replaces the legacy tools below at cutover.
  registerCoreTools(server, ctx);
  registerLifecycleTools(server, ctx);
  registerConnectionsTools(server, ctx);
  registerHvDeployTools(server, ctx);
  registerHvObservabilityTools(server, ctx);
  registerHvDbTools(server, ctx);
  registerHvSecretsTools(server, ctx);
  registerHvDomainsTools(server, ctx);
  registerHvEmailTools(server, ctx);
  registerHvPaymentsTools(server, ctx);
  registerHvCiTools(server, ctx);
  registerHvAppstoreTools(server, ctx);
  registerHvDevxTools(server, ctx);

  // Register all tool groups
  registerProjectTools(server);
  registerEnvironmentTools(server);
  registerConnectionTools(server);
  registerDeployTools(server);
  registerRailwayTools(server);
  registerLocalTools(server);
  registerRunTools(server);
  registerIntegrationTools(server);
  registerStripeTools(server);
  registerCloudflareTools(server);
  registerSendGridTools(server);
  registerTunnelTools(server);
  registerLogsTools(server);
  registerRecaptchaTools(server);
  registerEnvTools(server);
  registerDbTools(server);
  registerSetupTools(server);
  registerGitHubTools(server);
  registerAppStoreTools(server);
  registerXcodeTools(server);
  registerVisualizeTools(server);
  registerAutoFixTools(server);
  registerSecretsTools(server);
  registerInfraTools(server);
  registerMarketingTools(server);
  registerWorkflowTools(server);
  registerGcpTools(server);
  registerHealthTools(server);
  registerEmailTools(server);

  return server;
}

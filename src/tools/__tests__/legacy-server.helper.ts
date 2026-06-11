import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Adapter auto-registration side effects (mirrors src/server.ts).
import '../../adapters/providers/railway/railway.adapter.js';
import '../../adapters/providers/digitalocean/digitalocean.adapter.js';
import '../../adapters/providers/render/render.adapter.js';
import '../../adapters/providers/vercel/vercel.adapter.js';
import '../../adapters/providers/heroku/heroku.adapter.js';
import '../../adapters/providers/aws/apprunner.adapter.js';
import '../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../adapters/providers/supabase/supabase.adapter.js';
import '../../adapters/providers/aws/rds.adapter.js';
import '../../adapters/providers/gcp/cloudsql.adapter.js';
import '../../adapters/providers/stripe/stripe.adapter.js';
import '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import '../../adapters/providers/tunnel/tunnel.manager.js';
import '../../adapters/providers/local/compose.generator.js';
import '../../adapters/providers/recaptcha/recaptcha.adapter.js';
import '../../adapters/providers/github/github.adapter.js';
import '../../adapters/providers/database/database.adapter.js';
import '../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import '../../adapters/providers/xcode/xcode.adapter.js';
import '../../adapters/providers/secretmanagers/vault.adapter.js';
import '../../adapters/providers/secretmanagers/aws-secrets.adapter.js';
import '../../adapters/providers/secretmanagers/doppler.adapter.js';

import { registerConnectionTools } from '../connection.tools.js';
import { registerStripeTools } from '../stripe.tools.js';
import { registerCloudflareTools } from '../cloudflare.tools.js';
import { registerSendGridTools } from '../sendgrid.tools.js';
import { registerTunnelTools } from '../tunnel.tools.js';
import { registerLogsTools } from '../logs.tools.js';
import { registerDbTools } from '../db.tools.js';
import { registerGitHubTools } from '../github.tools.js';
import { registerAppStoreTools } from '../appstore.tools.js';
import { registerHealthTools } from '../health.tools.js';
import { registerEmailTools } from '../email.tools.js';

/**
 * TEST-ONLY: a server exposing the legacy (pre-cutover) tool surface.
 *
 * The production server (src/server.ts) registers only the 42 hv_* tools.
 * Behavioral tests that still exercise legacy tool names use this helper
 * until they are migrated or retired with the legacy files.
 */
export function createLegacyTestServer(): McpServer {
  const server = new McpServer({ name: 'hypervibe-legacy-test', version: '0.0.0' });

  registerConnectionTools(server);
  registerStripeTools(server);
  registerCloudflareTools(server);
  registerSendGridTools(server);
  registerTunnelTools(server);
  registerLogsTools(server);
  registerDbTools(server);
  registerGitHubTools(server);
  registerAppStoreTools(server);
  registerHealthTools(server);
  registerEmailTools(server);

  return server;
}

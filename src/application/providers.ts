/**
 * Provider registration is application bootstrap, not an interface concern.
 * Both MCP and CLI import this module before constructing a command context.
 */

// Hosting platforms
import '../adapters/providers/railway/railway.adapter.js';
import '../adapters/providers/gcp/cloudrun.adapter.js';
import '../adapters/providers/azure/azure-container-apps.adapter.js';
import '../adapters/providers/azure/azure-postgres.adapter.js';
import '../adapters/providers/azure/azure-managed-redis.adapter.js';
import '../adapters/providers/vercel/vercel.adapter.js';
import '../adapters/providers/aws/ecs.adapter.js';

// Database providers
import '../adapters/providers/supabase/supabase.adapter.js';
import '../adapters/providers/gcp/cloudsql.adapter.js';
import '../adapters/providers/aws/rds.adapter.js';
import '../adapters/providers/neon/neon.adapter.js';
import '../adapters/providers/digitalocean/digitalocean.adapter.js';

// Product and infrastructure providers
import '../adapters/providers/stripe/stripe.adapter.js';
import '../adapters/providers/cloudflare/cloudflare.adapter.js';
import '../adapters/providers/sendgrid/sendgrid.adapter.js';
import '../adapters/providers/tunnel/tunnel.manager.js';
import '../adapters/providers/local/compose.generator.js';
import '../adapters/providers/recaptcha/recaptcha.adapter.js';
import '../adapters/providers/github/github.adapter.js';
import '../adapters/providers/openai/openai.adapter.js';
import '../adapters/providers/database/database.adapter.js';
import '../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';

// Secret manager providers
import '../adapters/providers/secretmanagers/vault.adapter.js';
import '../adapters/providers/secretmanagers/aws-secrets.adapter.js';
import '../adapters/providers/secretmanagers/doppler.adapter.js';
import '../adapters/providers/secretmanagers/onepassword.adapter.js';
import '../adapters/providers/secretmanagers/bitwarden.adapter.js';

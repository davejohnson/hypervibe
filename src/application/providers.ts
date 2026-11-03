import '../adapters/providers/credential-validation.js';
/**
 * Provider registration is application bootstrap, not an interface concern.
 * Both MCP and CLI import this module before constructing a command context.
 */

// Hosting platforms
import '../adapters/providers/railway/railway.adapter.js';
import '../adapters/providers/gcp/cloudrun.adapter.js';
import '../adapters/providers/aws/ecs-express.adapter.js';
import '../adapters/providers/azure/azure-container-apps.adapter.js';
import '../adapters/providers/azure/azure-postgres.adapter.js';
import '../adapters/providers/azure/azure-managed-redis.adapter.js';

// Database providers
import '../adapters/providers/gcp/cloudsql.adapter.js';
import '../adapters/providers/gcp/memorystore.adapter.js';
import '../adapters/providers/aws/rds.adapter.js';
import '../adapters/providers/aws/elasticache.adapter.js';
import '../adapters/providers/aws/s3.adapter.js';
import '../adapters/providers/gcp/gcs.adapter.js';
import '../adapters/providers/azure/azure-blob.adapter.js';

// Product and infrastructure providers
import '../adapters/providers/stripe/stripe.adapter.js';
import '../adapters/providers/cloudflare/cloudflare.adapter.js';
import '../adapters/providers/sendgrid/sendgrid.adapter.js';
import '../adapters/providers/github/github.adapter.js';
import '../adapters/providers/database/database.adapter.js';
import '../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';

// Code hosts and CI executors are registered separately from infrastructure.
import './devops-providers.js';

// Secret manager providers
import '../adapters/providers/secretmanagers/aws-secrets.adapter.js';
import '../adapters/providers/secretmanagers/stripe-projects.adapter.js';

import { registerProviderImport } from './import-provider.js';
import { importRailwayProvider } from './provider-imports/railway.js';

registerProviderImport('railway', importRailwayProvider);

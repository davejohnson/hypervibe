export type ProviderImplementationStatus =
  | 'supported'
  | 'ready-for-live'
  | 'planned';

export interface ProviderCredentialField {
  /** Key accepted by the provider's Hypervibe credential schema. */
  field: string;
  /** Environment variable read only by the opt-in live test runner. */
  environmentVariable: string;
  optional?: boolean;
}

export interface HostingProviderContract {
  kind: 'hosting';
  /** Hypervibe provider id used in environments.*.hosting.provider. */
  provider: string;
  vendor: string;
  service: string;
  status: ProviderImplementationStatus;
  credentials: ProviderCredentialField[];
  /** A promotion gate that is specific to this provider, if one exists. */
  implementationNote?: string;
}

export interface DatabaseProviderContract {
  kind: 'database';
  /** Hypervibe provider id used in environments.*.database.provider. */
  provider: string;
  vendor: string;
  service: string;
  engine: 'postgres' | 'mongodb';
  status: ProviderImplementationStatus;
  credentials: ProviderCredentialField[];
  /** Hosting provider used by the end-to-end ProjectSpec fixture. */
  fixtureHostingProvider: string;
  /** A promotion gate that is specific to this provider, if one exists. */
  implementationNote?: string;
}

export interface CacheProviderContract {
  kind: 'cache';
  provider: string;
  vendor: string;
  service: string;
  engine: 'redis';
  status: ProviderImplementationStatus;
  credentials: ProviderCredentialField[];
  /** Hosting provider used by the end-to-end ProjectSpec fixture. */
  fixtureHostingProvider: string;
  /** A promotion gate that is specific to this provider, if one exists. */
  implementationNote?: string;
}

const gcpCredentials: ProviderCredentialField[] = [
  { field: 'projectId', environmentVariable: 'HYPERVIBE_TEST_GCP_PROJECT_ID' },
  { field: 'credentials', environmentVariable: 'HYPERVIBE_TEST_GCP_SERVICE_ACCOUNT_JSON' },
  { field: 'region', environmentVariable: 'HYPERVIBE_TEST_GCP_REGION', optional: true },
];

const awsCredentials: ProviderCredentialField[] = [
  { field: 'accessKeyId', environmentVariable: 'HYPERVIBE_TEST_AWS_ACCESS_KEY_ID' },
  { field: 'secretAccessKey', environmentVariable: 'HYPERVIBE_TEST_AWS_SECRET_ACCESS_KEY' },
  { field: 'region', environmentVariable: 'HYPERVIBE_TEST_AWS_REGION', optional: true },
];

const digitalOceanCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_DIGITALOCEAN_TOKEN' },
  { field: 'containerRegistry', environmentVariable: 'HYPERVIBE_TEST_DIGITALOCEAN_REGISTRY' },
];

const railwayCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_RAILWAY_TOKEN' },
  { field: 'workspaceId', environmentVariable: 'HYPERVIBE_TEST_RAILWAY_WORKSPACE_ID', optional: true },
];

const renderCredentials: ProviderCredentialField[] = [
  { field: 'apiKey', environmentVariable: 'HYPERVIBE_TEST_RENDER_API_KEY' },
  { field: 'ownerId', environmentVariable: 'HYPERVIBE_TEST_RENDER_OWNER_ID' },
  { field: 'registryCredentialId', environmentVariable: 'HYPERVIBE_TEST_RENDER_REGISTRY_CREDENTIAL_ID' },
];

const azureCredentials: ProviderCredentialField[] = [
  { field: 'tenantId', environmentVariable: 'HYPERVIBE_TEST_AZURE_TENANT_ID' },
  { field: 'subscriptionId', environmentVariable: 'HYPERVIBE_TEST_AZURE_SUBSCRIPTION_ID' },
  { field: 'clientId', environmentVariable: 'HYPERVIBE_TEST_AZURE_CLIENT_ID' },
  { field: 'clientSecret', environmentVariable: 'HYPERVIBE_TEST_AZURE_CLIENT_SECRET' },
  { field: 'resourceGroup', environmentVariable: 'HYPERVIBE_TEST_AZURE_RESOURCE_GROUP' },
  { field: 'location', environmentVariable: 'HYPERVIBE_TEST_AZURE_LOCATION' },
];

const azureContainerAppsCredentials: ProviderCredentialField[] = [
  ...azureCredentials,
  { field: 'registryId', environmentVariable: 'HYPERVIBE_TEST_AZURE_REGISTRY_ID' },
  { field: 'registryServer', environmentVariable: 'HYPERVIBE_TEST_AZURE_REGISTRY_SERVER' },
];

const flyCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_FLY_API_TOKEN' },
  { field: 'organizationSlug', environmentVariable: 'HYPERVIBE_TEST_FLY_ORGANIZATION_SLUG' },
  { field: 'region', environmentVariable: 'HYPERVIBE_TEST_FLY_REGION', optional: true },
];

const vercelCredentials: ProviderCredentialField[] = [
  { field: 'accessToken', environmentVariable: 'HYPERVIBE_TEST_VERCEL_ACCESS_TOKEN' },
  { field: 'teamId', environmentVariable: 'HYPERVIBE_TEST_VERCEL_TEAM_ID', optional: true },
];

const neonCredentials: ProviderCredentialField[] = [
  { field: 'apiKey', environmentVariable: 'HYPERVIBE_TEST_NEON_API_KEY' },
  { field: 'organizationId', environmentVariable: 'HYPERVIBE_TEST_NEON_ORGANIZATION_ID', optional: true },
  { field: 'regionId', environmentVariable: 'HYPERVIBE_TEST_NEON_REGION_ID', optional: true },
];

export const hostingProviderContracts: HostingProviderContract[] = [
  {
    kind: 'hosting',
    provider: 'railway',
    vendor: 'Railway',
    service: 'Railway',
    status: 'supported',
    credentials: railwayCredentials,
  },
  {
    kind: 'hosting',
    provider: 'cloudrun',
    vendor: 'Google Cloud',
    service: 'Cloud Run',
    status: 'supported',
    credentials: gcpCredentials,
  },
  {
    kind: 'hosting',
    provider: 'digitalocean',
    vendor: 'DigitalOcean',
    service: 'App Platform',
    status: 'planned',
    credentials: digitalOceanCredentials,
    implementationNote:
      'The registry, credential schema, App Platform adapter, guidance, mocked lifecycle, and exact-SHA CI workflow are implemented. Promotion requires a live harness that can execute the managed GitHub workflow plus a successful create/deploy/noop/destroy run.',
  },
  {
    kind: 'hosting',
    provider: 'ecs',
    vendor: 'AWS',
    service: 'ECS on Fargate',
    status: 'planned',
    credentials: awsCredentials,
  },
  {
    kind: 'hosting',
    provider: 'heroku',
    vendor: 'Heroku',
    service: 'Heroku Platform',
    status: 'planned',
    credentials: [
      { field: 'apiKey', environmentVariable: 'HYPERVIBE_TEST_HEROKU_API_KEY' },
      { field: 'region', environmentVariable: 'HYPERVIBE_TEST_HEROKU_REGION', optional: true },
      { field: 'dynoSize', environmentVariable: 'HYPERVIBE_TEST_HEROKU_DYNO_SIZE', optional: true },
    ],
    implementationNote:
      'The account binding, container-app lifecycle adapter, guidance, mocked lifecycle, and exact-image-ID managed workflow are implemented. Promotion requires a complete live create/release/noop/destroy run through the managed GitHub workflow.',
  },
  {
    kind: 'hosting',
    provider: 'render',
    vendor: 'Render',
    service: 'Render Services',
    status: 'planned',
    credentials: renderCredentials,
    implementationNote:
      'The workspace/registry binding, image-backed service adapter, guidance, mocked lifecycle, and exact-SHA GHCR workflow are implemented. Promotion requires a live harness that executes the managed GitHub workflow plus a successful create/deploy/noop/destroy run.',
  },
  {
    kind: 'hosting',
    provider: 'azure-container-apps',
    vendor: 'Microsoft Azure',
    service: 'Azure Container Apps',
    status: 'planned',
    credentials: azureContainerAppsCredentials,
    implementationNote:
      'The managed-environment and Container App lifecycle adapter, service-principal guidance, mocked safety contracts, native-source guard, and exact-digest ACR workflow are implemented. Promotion requires a live harness that executes the managed GitHub workflow plus a complete create/release/noop/destroy run.',
  },
  {
    kind: 'hosting',
    provider: 'fly',
    vendor: 'Fly.io',
    service: 'Fly Machines',
    status: 'planned',
    credentials: flyCredentials,
  },
  {
    kind: 'hosting',
    provider: 'vercel',
    vendor: 'Vercel',
    service: 'Vercel Projects and Deployments',
    status: 'planned',
    credentials: vercelCredentials,
  },
];

export const databaseProviderContracts: DatabaseProviderContract[] = [
  {
    kind: 'database',
    provider: 'cloudsql',
    vendor: 'Google Cloud',
    service: 'Cloud SQL for PostgreSQL',
    engine: 'postgres',
    status: 'supported',
    credentials: gcpCredentials,
    fixtureHostingProvider: 'cloudrun',
  },
  {
    kind: 'database',
    provider: 'digitalocean',
    vendor: 'DigitalOcean',
    service: 'Managed PostgreSQL',
    engine: 'postgres',
    status: 'planned',
    credentials: digitalOceanCredentials,
    fixtureHostingProvider: 'digitalocean',
    implementationNote:
      'The derived Managed PostgreSQL adapter and mocked lifecycle safety contract are implemented. Promotion remains gated on a live harness for the DigitalOcean managed GitHub workflow and one complete live stack run.',
  },
  {
    kind: 'database',
    provider: 'rds',
    vendor: 'AWS',
    service: 'RDS for PostgreSQL',
    engine: 'postgres',
    status: 'supported',
    credentials: awsCredentials,
    fixtureHostingProvider: 'railway',
  },
  {
    kind: 'database',
    provider: 'railway',
    vendor: 'Railway',
    service: 'Railway PostgreSQL',
    engine: 'postgres',
    status: 'supported',
    credentials: railwayCredentials,
    fixtureHostingProvider: 'railway',
  },
  {
    kind: 'database',
    provider: 'render',
    vendor: 'Render',
    service: 'Render Postgres',
    engine: 'postgres',
    status: 'planned',
    credentials: renderCredentials,
    fixtureHostingProvider: 'render',
    implementationNote:
      'The derived Render Postgres adapter and mocked lifecycle safety contract are implemented. Promotion remains gated on the complete managed-workflow live stack run.',
  },
  {
    kind: 'database',
    provider: 'supabase',
    vendor: 'Supabase',
    service: 'Supabase Postgres',
    engine: 'postgres',
    status: 'supported',
    credentials: [
      { field: 'accessToken', environmentVariable: 'HYPERVIBE_TEST_SUPABASE_ACCESS_TOKEN' },
      { field: 'organizationId', environmentVariable: 'HYPERVIBE_TEST_SUPABASE_ORGANIZATION_ID', optional: true },
    ],
    fixtureHostingProvider: 'railway',
  },
  {
    kind: 'database',
    provider: 'mongodb-atlas',
    vendor: 'MongoDB',
    service: 'Atlas',
    engine: 'mongodb',
    status: 'planned',
    credentials: [
      { field: 'clientId', environmentVariable: 'HYPERVIBE_TEST_MONGODB_ATLAS_CLIENT_ID' },
      { field: 'clientSecret', environmentVariable: 'HYPERVIBE_TEST_MONGODB_ATLAS_CLIENT_SECRET' },
      { field: 'projectId', environmentVariable: 'HYPERVIBE_TEST_MONGODB_ATLAS_PROJECT_ID' },
    ],
    fixtureHostingProvider: 'railway',
  },
  {
    kind: 'database',
    provider: 'azure-postgres',
    vendor: 'Microsoft Azure',
    service: 'Azure Database for PostgreSQL Flexible Server',
    engine: 'postgres',
    status: 'planned',
    credentials: azureCredentials,
    fixtureHostingProvider: 'azure-container-apps',
  },
  {
    kind: 'database',
    provider: 'fly-managed-postgres',
    vendor: 'Fly.io',
    service: 'Fly Managed Postgres',
    engine: 'postgres',
    status: 'planned',
    credentials: flyCredentials,
    fixtureHostingProvider: 'fly',
    implementationNote:
      'Do not implement against flyctl or an undocumented MPG endpoint; promotion requires a supported provider lifecycle API.',
  },
  {
    kind: 'database',
    provider: 'neon',
    vendor: 'Neon',
    service: 'Neon Postgres',
    engine: 'postgres',
    status: 'ready-for-live',
    credentials: neonCredentials,
    fixtureHostingProvider: 'railway',
    implementationNote:
      'The registry, credential schema, adapter, guidance, and mocked lifecycle contract are implemented; promotion requires a successful opt-in live create/noop/destroy run.',
  },
];

export const cacheProviderContracts: CacheProviderContract[] = [
  {
    kind: 'cache',
    provider: 'memorystore',
    vendor: 'Google Cloud',
    service: 'Memorystore for Redis',
    engine: 'redis',
    status: 'planned',
    credentials: gcpCredentials,
    fixtureHostingProvider: 'cloudrun',
  },
  {
    kind: 'cache',
    provider: 'digitalocean',
    vendor: 'DigitalOcean',
    service: 'Managed Valkey/Redis',
    engine: 'redis',
    status: 'planned',
    credentials: digitalOceanCredentials,
    fixtureHostingProvider: 'digitalocean',
    implementationNote:
      'The derived Managed Valkey adapter and mocked lifecycle safety contract are implemented. New clusters use the Valkey engine while observation accepts legacy Redis clusters; promotion remains gated on a live harness for the complete DigitalOcean stack.',
  },
  {
    kind: 'cache',
    provider: 'elasticache',
    vendor: 'AWS',
    service: 'ElastiCache for Valkey/Redis',
    engine: 'redis',
    status: 'planned',
    credentials: awsCredentials,
    fixtureHostingProvider: 'ecs',
  },
  {
    kind: 'cache',
    provider: 'railway',
    vendor: 'Railway',
    service: 'Railway Redis',
    engine: 'redis',
    status: 'ready-for-live',
    credentials: railwayCredentials,
    fixtureHostingProvider: 'railway',
  },
  {
    kind: 'cache',
    provider: 'render',
    vendor: 'Render',
    service: 'Render Key Value',
    engine: 'redis',
    status: 'planned',
    credentials: renderCredentials,
    fixtureHostingProvider: 'render',
    implementationNote:
      'The derived Render Key Value adapter and mocked lifecycle safety contract are implemented. Promotion remains gated on the complete managed-workflow live stack run.',
  },
  {
    kind: 'cache',
    provider: 'upstash',
    vendor: 'Upstash',
    service: 'Redis',
    engine: 'redis',
    status: 'planned',
    credentials: [
      { field: 'apiKey', environmentVariable: 'HYPERVIBE_TEST_UPSTASH_API_KEY' },
      { field: 'email', environmentVariable: 'HYPERVIBE_TEST_UPSTASH_EMAIL' },
    ],
    fixtureHostingProvider: 'railway',
  },
  {
    kind: 'cache',
    provider: 'azure-managed-redis',
    vendor: 'Microsoft Azure',
    service: 'Azure Managed Redis',
    engine: 'redis',
    status: 'planned',
    credentials: azureCredentials,
    fixtureHostingProvider: 'azure-container-apps',
  },
];

export const providerContracts = [
  ...hostingProviderContracts,
  ...databaseProviderContracts,
  ...cacheProviderContracts,
];

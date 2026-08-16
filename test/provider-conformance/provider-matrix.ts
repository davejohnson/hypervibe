export type ProviderImplementationStatus =
  | 'supported'
  | 'ready-for-live'
  | 'planned';

export interface ProviderCredentialField {
  /** Key accepted by the provider's Hypervibe credential schema. */
  field: string;
  /** Environment variable read only by the opt-in live test runner. */
  environmentVariable: string;
  /** Explicit conversion applied by the live runner before writing the credential object. */
  parseAs?: 'json' | 'number' | 'boolean';
  optional?: boolean;
}

export interface ManagedWorkflowFixture {
  /** Environment exercised by the managed workflow. Production keeps deploys manual. */
  environmentName: 'production';
  /** Fixture files that must already be committed in the isolated live repository. */
  fixtureDirectory: string;
  requiredPaths: string[];
  /** Generated workflow filename, consumed through hv_ci_trigger/hv_ci_status. */
  workflow: string;
  /** URL schemes the provider may return for its public health endpoint. */
  publicUrlProtocols: Array<'http:' | 'https:'>;
  serviceName: string;
  service: {
    workloadKind: 'web';
    startCommand?: string;
    healthCheckPath: string;
    public: true;
  };
  /** Optional datastore resources exercised in the same desired-state run. */
  database?: {
    provider: string;
    engine: 'postgres';
  };
  cache?: {
    provider: string;
    engine: 'redis';
  };
}

export interface HostingProviderContract {
  kind: 'hosting';
  /** Hypervibe provider id used in environments.*.hosting.provider. */
  provider: string;
  vendor: string;
  service: string;
  status: ProviderImplementationStatus;
  /** Environment custom-domain lifecycle implemented by Hypervibe today. */
  customDomains: 'managed' | 'unsupported';
  /** Whether the provider certificate path permits proxied traffic DNS. */
  domainTrafficProxy: 'supported' | 'dns-only';
  /** Reversible, provider-verified suspension of every declared workload. */
  maintenance: 'managed' | 'ready-for-live' | 'unsupported';
  credentials: ProviderCredentialField[];
  /** Opt-in managed GitHub workflow live-test profile. */
  managedWorkflow?: ManagedWorkflowFixture;
  /** A promotion gate that is specific to this provider, if one exists. */
  implementationNote?: string;
}

export interface DatabaseProviderContract {
  kind: 'database';
  /** Hypervibe provider id used in environments.*.database.provider. */
  provider: string;
  vendor: string;
  service: string;
  engine: 'postgres';
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

const gcpHostingCredentials = gcpCredentials.filter(({ field }) => field !== 'region');

const awsCredentials: ProviderCredentialField[] = [
  { field: 'accessKeyId', environmentVariable: 'HYPERVIBE_TEST_AWS_ACCESS_KEY_ID' },
  { field: 'secretAccessKey', environmentVariable: 'HYPERVIBE_TEST_AWS_SECRET_ACCESS_KEY' },
  { field: 'region', environmentVariable: 'HYPERVIBE_TEST_AWS_REGION', optional: true },
];

const awsHostingCredentials = awsCredentials.filter(({ field }) => field !== 'region');

const awsNetworkCredentials: ProviderCredentialField[] = [
  ...awsCredentials,
  {
    field: 'subnetIds',
    environmentVariable: 'HYPERVIBE_TEST_AWS_SUBNET_IDS_JSON',
    parseAs: 'json',
  },
  {
    field: 'securityGroupIds',
    environmentVariable: 'HYPERVIBE_TEST_AWS_SECURITY_GROUP_IDS_JSON',
    parseAs: 'json',
  },
];

const digitalOceanCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_DIGITALOCEAN_TOKEN' },
];

const railwayCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_RAILWAY_TOKEN' },
  { field: 'workspaceId', environmentVariable: 'HYPERVIBE_TEST_RAILWAY_WORKSPACE_ID', optional: true },
];

const azureCredentials: ProviderCredentialField[] = [
  { field: 'tenantId', environmentVariable: 'HYPERVIBE_TEST_AZURE_TENANT_ID' },
  { field: 'subscriptionId', environmentVariable: 'HYPERVIBE_TEST_AZURE_SUBSCRIPTION_ID' },
  { field: 'clientId', environmentVariable: 'HYPERVIBE_TEST_AZURE_CLIENT_ID' },
  { field: 'clientSecret', environmentVariable: 'HYPERVIBE_TEST_AZURE_CLIENT_SECRET' },
  { field: 'resourceGroup', environmentVariable: 'HYPERVIBE_TEST_AZURE_RESOURCE_GROUP' },
  { field: 'location', environmentVariable: 'HYPERVIBE_TEST_AZURE_LOCATION' },
];

const azureHostingCredentials: ProviderCredentialField[] = [
  { field: 'tenantId', environmentVariable: 'HYPERVIBE_TEST_AZURE_TENANT_ID' },
  { field: 'subscriptionId', environmentVariable: 'HYPERVIBE_TEST_AZURE_SUBSCRIPTION_ID' },
  { field: 'clientId', environmentVariable: 'HYPERVIBE_TEST_AZURE_CLIENT_ID' },
  { field: 'clientSecret', environmentVariable: 'HYPERVIBE_TEST_AZURE_CLIENT_SECRET' },
];

const vercelCredentials: ProviderCredentialField[] = [
  { field: 'accessToken', environmentVariable: 'HYPERVIBE_TEST_VERCEL_ACCESS_TOKEN' },
  { field: 'teamId', environmentVariable: 'HYPERVIBE_TEST_VERCEL_TEAM_ID', optional: true },
];

export const managedWorkflowGitHubCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_GITHUB_API_TOKEN' },
];

function dockerWebManagedWorkflow(workflow: string): ManagedWorkflowFixture {
  return {
    environmentName: 'production',
    fixtureDirectory: 'test/provider-conformance/fixture',
    requiredPaths: [
      '.hypervibe/spec.json',
      'Dockerfile',
      'package.json',
      'server.mjs',
    ],
    workflow,
    publicUrlProtocols: ['https:'],
    serviceName: 'web',
    service: {
      workloadKind: 'web',
      startCommand: 'node server.mjs',
      healthCheckPath: '/health',
      public: true,
    },
  };
}

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
    customDomains: 'managed',
    domainTrafficProxy: 'supported',
    maintenance: 'managed',
    credentials: railwayCredentials,
  },
  {
    kind: 'hosting',
    provider: 'cloudrun',
    vendor: 'Google Cloud',
    service: 'Cloud Run',
    status: 'supported',
    customDomains: 'managed',
    domainTrafficProxy: 'dns-only',
    maintenance: 'managed',
    credentials: gcpHostingCredentials,
  },
  {
    kind: 'hosting',
    provider: 'ecs',
    vendor: 'AWS',
    service: 'ECS Express Mode',
    status: 'ready-for-live',
    customDomains: 'managed',
    domainTrafficProxy: 'dns-only',
    maintenance: 'unsupported',
    credentials: awsHostingCredentials,
    managedWorkflow: dockerWebManagedWorkflow('deploy-ecs-production.yml'),
    implementationNote:
      'The authentication-only connection, shared default-VPC prerequisite, project-owned ECR/IAM/cluster bootstrap, ECS Express service lifecycle, phased ACM/ALB domain lifecycle, exact-digest CI workflow, and mocked safety contracts are implemented. Promotion requires a successful opt-in live lifecycle run.',
  },
  {
    kind: 'hosting',
    provider: 'azure-container-apps',
    vendor: 'Microsoft Azure',
    service: 'Container Apps',
    status: 'ready-for-live',
    customDomains: 'managed',
    domainTrafficProxy: 'dns-only',
    maintenance: 'managed',
    credentials: azureHostingCredentials,
    managedWorkflow: dockerWebManagedWorkflow('deploy-azure-container-apps-production.yml'),
    implementationNote:
      'The service-principal-only connection, project-owned resource group/ACR/managed-environment bootstrap, managed-identity Container App lifecycle, phased managed-certificate domain lifecycle, exact-digest CI workflow, and mocked safety contracts are implemented. Promotion requires a successful opt-in live lifecycle run.',
  },
  {
    kind: 'hosting',
    provider: 'digitalocean',
    vendor: 'DigitalOcean',
    service: 'App Platform',
    status: 'ready-for-live',
    customDomains: 'managed',
    domainTrafficProxy: 'supported',
    maintenance: 'unsupported',
    credentials: digitalOceanCredentials,
    managedWorkflow: {
      ...dockerWebManagedWorkflow('deploy-digitalocean-production.yml'),
      database: { provider: 'digitalocean', engine: 'postgres' },
      cache: { provider: 'digitalocean', engine: 'redis' },
    },
    implementationNote:
      'The credential schema, App Platform adapter, automatic free Starter registry bootstrap, derived PostgreSQL and Valkey adapters, guidance, mocked lifecycle, exact-SHA CI workflow, and review-gated full-stack managed-workflow live harness are implemented. Promotion requires a successful opt-in create/deploy/noop/update/destroy run against an isolated DigitalOcean team.',
  },
  {
    kind: 'hosting',
    provider: 'vercel',
    vendor: 'Vercel',
    service: 'Vercel Projects and Deployments',
    status: 'ready-for-live',
    customDomains: 'managed',
    domainTrafficProxy: 'supported',
    maintenance: 'ready-for-live',
    credentials: vercelCredentials,
    managedWorkflow: {
      environmentName: 'production',
      fixtureDirectory: 'test/provider-conformance/fixture-vercel',
      requiredPaths: [
        '.hypervibe/spec.json',
        'api/health.js',
        'index.html',
        'package.json',
      ],
      workflow: 'deploy-vercel-production.yml',
      publicUrlProtocols: ['https:'],
      serviceName: 'web',
      service: {
        workloadKind: 'web',
        healthCheckPath: '/api/health',
        public: true,
      },
    },
    implementationNote:
      'The source-less Project lifecycle adapter, personal/team token guidance, mocked safety contracts, exact-ID pause/unpause maintenance contract, native-Git-source guard, exact-file REST deployment workflow, and review-gated managed-workflow live harness are implemented. Maintenance remains ready-for-live until its opt-in entry/noop/exit scenario passes; provider promotion still requires a successful create/deploy/noop/update/destroy run.',
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
    status: 'ready-for-live',
    credentials: digitalOceanCredentials,
    fixtureHostingProvider: 'digitalocean',
    implementationNote:
      'The derived Managed PostgreSQL adapter, mocked lifecycle safety contract, and review-gated full-stack live profile are implemented. Promotion requires one successful complete live stack run.',
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
    provider: 'azure-postgres',
    vendor: 'Microsoft Azure',
    service: 'Azure Database for PostgreSQL Flexible Server',
    engine: 'postgres',
    status: 'planned',
    credentials: azureCredentials,
    fixtureHostingProvider: 'railway',
    implementationNote:
      'The PostgreSQL Flexible Server adapter and mocked lifecycle safety contract remain implemented. Azure Container Apps now provides declarative hosting, but this datastore remains planned until its independent network profile and full-stack live lifecycle pass.',
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
    implementationNote:
      'The registry, private-IP Redis AUTH adapter, durable observation, and mocked lifecycle safety contract are implemented. Live promotion remains blocked until the Cloud Run adapter can declaratively attach VPC egress to the selected authorizedNetwork.',
  },
  {
    kind: 'cache',
    provider: 'digitalocean',
    vendor: 'DigitalOcean',
    service: 'Managed Valkey/Redis',
    engine: 'redis',
    status: 'ready-for-live',
    credentials: digitalOceanCredentials,
    fixtureHostingProvider: 'digitalocean',
    implementationNote:
      'The derived Managed Valkey adapter, mocked lifecycle safety contract, and review-gated full-stack live profile are implemented. New clusters use the Valkey engine while observation accepts legacy Redis clusters; promotion requires one successful complete live stack run.',
  },
  {
    kind: 'cache',
    provider: 'elasticache',
    vendor: 'AWS',
    service: 'ElastiCache for Valkey/Redis',
    engine: 'redis',
    status: 'planned',
    credentials: awsNetworkCredentials,
    fixtureHostingProvider: 'railway',
    implementationNote:
      'The serverless Valkey adapter and mocked lifecycle safety contract remain implemented. Live promotion is blocked until Hypervibe owns a declarative AWS workload-network profile; ECS hosting was removed because it required pre-created infrastructure identifiers.',
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
    provider: 'azure-managed-redis',
    vendor: 'Microsoft Azure',
    service: 'Azure Managed Redis',
    engine: 'redis',
    status: 'planned',
    credentials: azureCredentials,
    fixtureHostingProvider: 'railway',
    implementationNote:
      'The Azure Managed Redis adapter and mocked lifecycle safety contract remain implemented. Azure Container Apps now provides declarative hosting, but this datastore remains planned until its independent network profile and full-stack live lifecycle pass.',
  },
];

export const providerContracts = [
  ...hostingProviderContracts,
  ...databaseProviderContracts,
  ...cacheProviderContracts,
];

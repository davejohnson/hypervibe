import type { ProviderImplementationStatus } from '../../src/domain/registry/provider.registry.js';

export type { ProviderImplementationStatus };

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
  /** Workload kinds covered by the adapter's complete plan/apply/observe/delete lifecycle. */
  workloadKinds: Array<'web' | 'worker' | 'cron'>;
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

export interface StorageProviderContract {
  kind: 'storage';
  provider: string;
  vendor: string;
  service: string;
  status: ProviderImplementationStatus;
  credentials: ProviderCredentialField[];
  /** Hosting connection whose cloud identity may be reused for lifecycle. */
  connectionAlias?: string;
  implementationNote?: string;
}

export interface QueueProviderContract {
  kind: 'queue';
  provider: string;
  vendor: string;
  service: string;
  status: ProviderImplementationStatus;
  credentials: ProviderCredentialField[];
  backend: 'pubsub' | 'postgres';
  resources: 'managed' | 'application-managed';
  implementationNote?: string;
}

export interface LoadBalancerProviderContract {
  kind: 'load-balancer';
  provider: string;
  vendor: string;
  service: string;
  status: ProviderImplementationStatus;
  credentials: ProviderCredentialField[];
  topology: 'monitor-pool-balancer';
  minimumOrigins: number;
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

const digitalOceanCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_DIGITALOCEAN_TOKEN' },
];

const railwayCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_RAILWAY_TOKEN' },
  { field: 'workspaceId', environmentVariable: 'HYPERVIBE_TEST_RAILWAY_WORKSPACE_ID', optional: true },
];

const cloudflareCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_CLOUDFLARE_API_TOKEN' },
  { field: 'accountId', environmentVariable: 'HYPERVIBE_TEST_CLOUDFLARE_ACCOUNT_ID', optional: true },
];

const azureHostingCredentials: ProviderCredentialField[] = [
  { field: 'tenantId', environmentVariable: 'HYPERVIBE_TEST_AZURE_TENANT_ID' },
  { field: 'subscriptionId', environmentVariable: 'HYPERVIBE_TEST_AZURE_SUBSCRIPTION_ID' },
  { field: 'clientId', environmentVariable: 'HYPERVIBE_TEST_AZURE_CLIENT_ID' },
  { field: 'clientSecret', environmentVariable: 'HYPERVIBE_TEST_AZURE_CLIENT_SECRET' },
];

const azureCredentials = azureHostingCredentials;

const vercelCredentials: ProviderCredentialField[] = [
  { field: 'accessToken', environmentVariable: 'HYPERVIBE_TEST_VERCEL_ACCESS_TOKEN' },
  { field: 'teamId', environmentVariable: 'HYPERVIBE_TEST_VERCEL_TEAM_ID', optional: true },
];

const flyCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_FLY_API_TOKEN' },
  { field: 'organizationSlug', environmentVariable: 'HYPERVIBE_TEST_FLY_ORGANIZATION_SLUG' },
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
    status: 'ready-for-live',
    workloadKinds: ['web', 'worker', 'cron'],
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
    status: 'ready-for-live',
    workloadKinds: ['web', 'worker', 'cron'],
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
    workloadKinds: ['web'],
    customDomains: 'managed',
    domainTrafficProxy: 'dns-only',
    maintenance: 'unsupported',
    credentials: awsHostingCredentials,
    managedWorkflow: {
      ...dockerWebManagedWorkflow('deploy-ecs-production.yml'),
      database: { provider: 'rds', engine: 'postgres' },
    },
    implementationNote:
      'The authentication-only connection, shared default-VPC prerequisite, project-owned ECR/IAM/cluster bootstrap, ECS Express service lifecycle, phased ACM/ALB domain lifecycle, exact-digest CI workflow, and mocked safety contracts are implemented. Promotion requires a successful opt-in live lifecycle run.',
  },
  {
    kind: 'hosting',
    provider: 'azure-container-apps',
    vendor: 'Microsoft Azure',
    service: 'Container Apps',
    status: 'ready-for-live',
    workloadKinds: ['web'],
    customDomains: 'managed',
    domainTrafficProxy: 'dns-only',
    maintenance: 'managed',
    credentials: azureHostingCredentials,
    managedWorkflow: dockerWebManagedWorkflow('deploy-azure-container-apps-production.yml'),
    implementationNote:
      'The service-principal-only connection, project-owned resource group/ACR/managed-environment bootstrap, managed-identity Container App lifecycle, phased managed-certificate domain lifecycle, exact-digest CI workflow, and mocked safety contracts are implemented. Promotion requires a successful opt-in live lifecycle run.',
  },
];

export const databaseProviderContracts: DatabaseProviderContract[] = [
  {
    kind: 'database',
    provider: 'cloudsql',
    vendor: 'Google Cloud',
    service: 'Cloud SQL for PostgreSQL',
    engine: 'postgres',
    status: 'ready-for-live',
    credentials: gcpCredentials,
    fixtureHostingProvider: 'cloudrun',
  },
  {
    kind: 'database',
    provider: 'rds',
    vendor: 'AWS',
    service: 'RDS for PostgreSQL',
    engine: 'postgres',
    status: 'ready-for-live',
    credentials: awsHostingCredentials,
    fixtureHostingProvider: 'ecs',
    implementationNote:
      'RDS reuses the ECS connection, exact account/region/default-VPC workload-network binding, and workload security group. Its database security group permits durable PostgreSQL ingress only from that exact ECS workload group; promotion requires a successful complete ECS-hosted live lifecycle.',
  },
  {
    kind: 'database',
    provider: 'railway',
    vendor: 'Railway',
    service: 'Railway PostgreSQL',
    engine: 'postgres',
    status: 'ready-for-live',
    credentials: railwayCredentials,
    fixtureHostingProvider: 'railway',
  },
  {
    kind: 'database',
    provider: 'azure-postgres',
    vendor: 'Microsoft Azure',
    service: 'Azure Database for PostgreSQL Flexible Server',
    engine: 'postgres',
    status: 'ready-for-live',
    credentials: azureCredentials,
    fixtureHostingProvider: 'azure-container-apps',
    implementationNote:
      'The auth-only connection reuse, deterministic Container Apps resource-group placement, explicit public-network/Azure-services firewall contract, encrypted binding, and mocked lifecycle safety contract are implemented. Promotion requires a successful recent Azure Container Apps plus PostgreSQL full-stack live run.',
  },
];

export const cacheProviderContracts: CacheProviderContract[] = [
  {
    kind: 'cache',
    provider: 'memorystore',
    vendor: 'Google Cloud',
    service: 'Memorystore for Redis',
    engine: 'redis',
    status: 'ready-for-live',
    credentials: gcpHostingCredentials,
    fixtureHostingProvider: 'cloudrun',
    implementationNote:
      'The auth-only registry, private-IP Redis AUTH adapter, desired placement drift, existing-network verification, Cloud Run Direct VPC egress, and mocked lifecycle contracts are implemented. Promotion to supported requires a successful recent opt-in live create/noop/update/destroy run.',
  },
  {
    kind: 'cache',
    provider: 'elasticache',
    vendor: 'AWS',
    service: 'ElastiCache for Valkey/Redis',
    engine: 'redis',
    status: 'ready-for-live',
    credentials: awsHostingCredentials,
    fixtureHostingProvider: 'ecs',
    implementationNote:
      'The auth-only ECS connection, project-owned default-VPC workload security group, explicit Express networking, isolated serverless Valkey security group, desired region/size placement, and mocked lifecycle safety contract are implemented. Promotion to supported requires a successful recent opt-in live create/noop/update/destroy run.',
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
    status: 'ready-for-live',
    credentials: azureCredentials,
    fixtureHostingProvider: 'azure-container-apps',
    implementationNote:
      'The auth-only connection reuse, deterministic Container Apps resource-group placement, explicit public-network/TLS/encrypted-client/access-key contract, desired region/size drift, and mocked lifecycle safety contract are implemented. Promotion requires a successful recent Azure Container Apps plus Managed Redis full-stack live run.',
  },
];

export const storageProviderContracts: StorageProviderContract[] = [
  {
    kind: 'storage',
    provider: 's3',
    vendor: 'AWS',
    service: 'Amazon S3',
    status: 'ready-for-live',
    credentials: awsHostingCredentials,
    connectionAlias: 'ecs',
    implementationNote: 'Private bucket creation, scoped observation, streaming data access, workload wiring, rollback, and confirmed teardown are implemented; promotion requires recent live lifecycle evidence.',
  },
  {
    kind: 'storage',
    provider: 'gcs',
    vendor: 'Google Cloud',
    service: 'Cloud Storage',
    status: 'ready-for-live',
    credentials: gcpHostingCredentials,
    connectionAlias: 'cloudrun',
    implementationNote: 'Private bucket creation, scoped observation, streaming data access, workload wiring, and confirmed teardown are implemented; promotion requires recent live lifecycle evidence.',
  },
  {
    kind: 'storage',
    provider: 'azureblob',
    vendor: 'Microsoft Azure',
    service: 'Blob Storage',
    status: 'ready-for-live',
    credentials: azureHostingCredentials,
    connectionAlias: 'azure-container-apps',
    implementationNote: 'Private account/container creation, scoped observation, streaming data access, workload wiring, and confirmed teardown are implemented; promotion requires recent live lifecycle evidence.',
  },
  {
    kind: 'storage',
    provider: 'railway',
    vendor: 'Railway',
    service: 'Railway Buckets',
    status: 'ready-for-live',
    credentials: railwayCredentials,
    implementationNote: 'Private S3-compatible bucket creation, scoped observation, streaming data access, and workload wiring are implemented; promotion requires recent live lifecycle evidence.',
  },
];

export const queueProviderContracts: QueueProviderContract[] = [
  {
    kind: 'queue',
    provider: 'cloudrun',
    vendor: 'Google Cloud',
    service: 'Pub/Sub',
    status: 'ready-for-live',
    credentials: gcpHostingCredentials,
    backend: 'pubsub',
    resources: 'managed',
    implementationNote: 'Topic/subscription lifecycle and workload wiring are implemented through the Cloud Run connection; promotion requires recent live lifecycle evidence.',
  },
  {
    kind: 'queue',
    provider: 'railway',
    vendor: 'Railway',
    service: 'PostgreSQL-backed queues',
    status: 'ready-for-live',
    credentials: railwayCredentials,
    backend: 'postgres',
    resources: 'application-managed',
    implementationNote: 'Queue declarations are wired to the explicitly declared PostgreSQL database; no provider queue resource is invented or mutated.',
  },
];

export const loadBalancerProviderContracts: LoadBalancerProviderContract[] = [
  {
    kind: 'load-balancer',
    provider: 'cloudflare',
    vendor: 'Cloudflare',
    service: 'Cloudflare Load Balancing',
    status: 'ready-for-live',
    credentials: cloudflareCredentials,
    topology: 'monitor-pool-balancer',
    minimumOrigins: 2,
    implementationNote: 'Separate monitor, pool, and hostname load-balancer actions, scoped observation, dependency-ordered reconciliation, and confirmed reverse teardown are implemented; promotion requires the review-gated live profile.',
  },
];

export const providerContracts = [
  ...hostingProviderContracts,
  ...databaseProviderContracts,
  ...cacheProviderContracts,
  ...storageProviderContracts,
  ...queueProviderContracts,
  ...loadBalancerProviderContracts,
];

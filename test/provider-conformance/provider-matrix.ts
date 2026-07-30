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

const awsCredentials: ProviderCredentialField[] = [
  { field: 'accessKeyId', environmentVariable: 'HYPERVIBE_TEST_AWS_ACCESS_KEY_ID' },
  { field: 'secretAccessKey', environmentVariable: 'HYPERVIBE_TEST_AWS_SECRET_ACCESS_KEY' },
  { field: 'region', environmentVariable: 'HYPERVIBE_TEST_AWS_REGION', optional: true },
];

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

const awsEcsCredentials: ProviderCredentialField[] = [
  ...awsCredentials,
  { field: 'ecrRepositoryArn', environmentVariable: 'HYPERVIBE_TEST_AWS_ECR_REPOSITORY_ARN' },
  { field: 'ecrRepositoryUri', environmentVariable: 'HYPERVIBE_TEST_AWS_ECR_REPOSITORY_URI' },
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
  { field: 'executionRoleArn', environmentVariable: 'HYPERVIBE_TEST_AWS_EXECUTION_ROLE_ARN' },
  {
    field: 'taskRoleArn',
    environmentVariable: 'HYPERVIBE_TEST_AWS_TASK_ROLE_ARN',
    optional: true,
  },
  {
    field: 'targetGroupArn',
    environmentVariable: 'HYPERVIBE_TEST_AWS_TARGET_GROUP_ARN',
  },
  {
    field: 'publicUrl',
    environmentVariable: 'HYPERVIBE_TEST_AWS_PUBLIC_URL',
    optional: true,
  },
  {
    field: 'assignPublicIp',
    environmentVariable: 'HYPERVIBE_TEST_AWS_ASSIGN_PUBLIC_IP',
    parseAs: 'boolean',
    optional: true,
  },
  {
    field: 'containerPort',
    environmentVariable: 'HYPERVIBE_TEST_AWS_CONTAINER_PORT',
    parseAs: 'number',
    optional: true,
  },
];

const digitalOceanCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_DIGITALOCEAN_TOKEN' },
  { field: 'containerRegistry', environmentVariable: 'HYPERVIBE_TEST_DIGITALOCEAN_REGISTRY' },
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

const azureContainerAppsCredentials: ProviderCredentialField[] = [
  ...azureCredentials,
  { field: 'registryId', environmentVariable: 'HYPERVIBE_TEST_AZURE_REGISTRY_ID' },
  { field: 'registryServer', environmentVariable: 'HYPERVIBE_TEST_AZURE_REGISTRY_SERVER' },
];

const vercelCredentials: ProviderCredentialField[] = [
  { field: 'accessToken', environmentVariable: 'HYPERVIBE_TEST_VERCEL_ACCESS_TOKEN' },
  { field: 'teamId', environmentVariable: 'HYPERVIBE_TEST_VERCEL_TEAM_ID', optional: true },
];

export const managedWorkflowGitHubCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_GITHUB_API_TOKEN' },
];

function dockerWebManagedWorkflow(
  workflow: string,
  publicUrlProtocols: ManagedWorkflowFixture['publicUrlProtocols'] = ['https:']
): ManagedWorkflowFixture {
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
    publicUrlProtocols,
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
    status: 'ready-for-live',
    credentials: digitalOceanCredentials,
    managedWorkflow: {
      ...dockerWebManagedWorkflow('deploy-digitalocean-production.yml'),
      database: { provider: 'digitalocean', engine: 'postgres' },
      cache: { provider: 'digitalocean', engine: 'redis' },
    },
    implementationNote:
      'The registry, credential schema, App Platform adapter, derived PostgreSQL and Valkey adapters, guidance, mocked lifecycle, exact-SHA CI workflow, and review-gated full-stack managed-workflow live harness are implemented. Promotion requires a successful opt-in create/deploy/noop/update/destroy run against an isolated DigitalOcean team and existing DOCR registry.',
  },
  {
    kind: 'hosting',
    provider: 'ecs',
    vendor: 'AWS',
    service: 'ECS on Fargate',
    status: 'ready-for-live',
    credentials: awsEcsCredentials,
    managedWorkflow: dockerWebManagedWorkflow(
      'deploy-ecs-production.yml',
      ['http:', 'https:']
    ),
    implementationNote:
      'The cluster/service/task-definition lifecycle adapter, prerequisite guidance, mocked safety contracts, exact-digest ECR workflow, and review-gated managed-workflow live harness are implemented. Promotion requires a successful opt-in create/deploy/noop/update/destroy run in an isolated AWS account.',
  },
  {
    kind: 'hosting',
    provider: 'azure-container-apps',
    vendor: 'Microsoft Azure',
    service: 'Azure Container Apps',
    status: 'ready-for-live',
    credentials: azureContainerAppsCredentials,
    managedWorkflow: {
      ...dockerWebManagedWorkflow(
        'deploy-azure-container-apps-production.yml'
      ),
      database: { provider: 'azure-postgres', engine: 'postgres' },
      cache: { provider: 'azure-managed-redis', engine: 'redis' },
    },
    implementationNote:
      'The managed-environment, Container App, PostgreSQL Flexible Server, and Managed Redis lifecycle adapters, service-principal guidance, mocked safety contracts, native-source guard, exact-digest ACR workflow, and review-gated full-stack managed-workflow live harness are implemented. Promotion requires a successful opt-in create/deploy/noop/update/destroy run in an isolated Azure subscription.',
  },
  {
    kind: 'hosting',
    provider: 'vercel',
    vendor: 'Vercel',
    service: 'Vercel Projects and Deployments',
    status: 'ready-for-live',
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
      'The source-less Project lifecycle adapter, personal/team token guidance, mocked safety contracts, native-Git-source guard, exact-file REST deployment workflow, and review-gated managed-workflow live harness are implemented. Promotion requires a successful opt-in create/deploy/noop/update/destroy run.',
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
    status: 'ready-for-live',
    credentials: azureCredentials,
    fixtureHostingProvider: 'azure-container-apps',
    implementationNote:
      'The ARM registry, credential schema, PostgreSQL Flexible Server adapter, Azure-services firewall wiring, and mocked lifecycle safety contract are implemented. Promotion requires one successful complete Azure live stack run.',
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
    status: 'ready-for-live',
    credentials: awsNetworkCredentials,
    fixtureHostingProvider: 'ecs',
    implementationNote:
      'The serverless Valkey adapter, dedicated workload-source security group, durable ARN observation, dependency-ordered teardown, and mocked lifecycle safety contract are implemented. Promotion requires one successful ECS full-stack live run.',
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
      'The ARM registry, credential schema, Azure Managed Redis adapter, encrypted default database wiring, and mocked lifecycle safety contract are implemented. Promotion requires one successful complete Azure live stack run.',
  },
];

export const providerContracts = [
  ...hostingProviderContracts,
  ...databaseProviderContracts,
  ...cacheProviderContracts,
];

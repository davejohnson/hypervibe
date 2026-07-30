import { z } from 'zod';

/** Pre-filled GitHub classic PAT creation URLs, one per token role. */
export const GITHUB_TOKEN_URLS = {
  /** apiToken: workflow/secrets management. */
  api: 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=Hypervibe%20GitHub%20API',
  /** packageReadToken: durable GHCR image pulls. */
  packageRead: 'https://github.com/settings/tokens/new?scopes=read:packages&description=Hypervibe%20GHCR%20pull',
  /** Single-token setup covering both roles. */
  combined: 'https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages&description=Hypervibe%20CI%20deploys',
} as const;

export interface ConnectionGuidance {
  provider: string;
  displayName: string;
  tokenType: string;
  setupUrl?: string;
  setupUrls?: Array<{ label: string; url: string }>;
  permissions: string[];
  credentialExample: string;
  notes?: string[];
}

export interface ConnectionSetupDetails {
  provider: string;
  scope?: string;
  displayName?: string;
  tokenType?: string;
  setupUrls: string[];
  requiredPermissions: string[];
  credentialExample: string;
  notes?: string[];
}

export type CredentialInputKind = 'text' | 'secret' | 'multilineSecret' | 'choice';

/**
 * A provider-neutral description of one credential field. Clients use this to
 * render connection forms without importing provider knowledge or schemas.
 */
export interface CredentialFieldDescriptor {
  name: string;
  label: string;
  required: boolean;
  sensitive: boolean;
  inputKind: CredentialInputKind;
  options?: string[];
  description?: string;
}

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (true) {
    if (current instanceof z.ZodEffects) {
      current = current.innerType();
      continue;
    }
    if (
      current instanceof z.ZodOptional
      || current instanceof z.ZodNullable
      || current instanceof z.ZodDefault
      || current instanceof z.ZodCatch
    ) {
      current = current._def.innerType;
      continue;
    }
    if (current instanceof z.ZodBranded) {
      current = current._def.type;
      continue;
    }
    return current;
  }
}

function credentialFieldLabel(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/);
  const acronyms: Record<string, string> = {
    api: 'API',
    aws: 'AWS',
    gcp: 'GCP',
    id: 'ID',
    json: 'JSON',
    oauth: 'OAuth',
    url: 'URL',
  };
  return words
    .map((word) => acronyms[word.toLowerCase()] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function isSensitiveCredentialField(name: string): boolean {
  if (/(?:kind|mode|type)$/i.test(name)) {
    return false;
  }
  return /(token|key|secret|password|credential|private|connection(?:url|string))/i.test(name);
}

function enumOptions(schema: z.ZodTypeAny): string[] | undefined {
  if (schema instanceof z.ZodEnum) {
    return [...schema.options];
  }
  if (schema instanceof z.ZodNativeEnum) {
    const options = Object.values(schema.enum).filter((value): value is string => typeof value === 'string');
    return [...new Set(options)];
  }
  return undefined;
}

/**
 * Derive a safe form contract from a provider-owned Zod credential schema.
 * Schemas which cannot be represented as an object are intentionally omitted;
 * clients can fall back to credentialsRef for those providers.
 */
export function credentialFieldsFromSchema(
  schema: z.ZodTypeAny
): CredentialFieldDescriptor[] | undefined {
  const objectSchema = unwrapSchema(schema);
  if (!(objectSchema instanceof z.ZodObject)) {
    return undefined;
  }

  return Object.entries(objectSchema.shape).map(([name, rawField]) => {
    const field = rawField as z.ZodTypeAny;
    const unwrapped = unwrapSchema(field);
    const options = enumOptions(unwrapped);
    const sensitive = isSensitiveCredentialField(name);
    const inputKind: CredentialInputKind = options
      ? 'choice'
      : sensitive && /(credentials|private.*key)/i.test(name)
        ? 'multilineSecret'
        : sensitive
          ? 'secret'
          : 'text';
    const description = field.description ?? unwrapped.description;

    return {
      name,
      label: credentialFieldLabel(name),
      required: !field.safeParse(undefined).success,
      sensitive,
      inputKind,
      ...(options ? { options } : {}),
      ...(description ? { description } : {}),
    };
  });
}

const GUIDANCE: Record<string, ConnectionGuidance> = {
  '1password': {
    provider: '1password',
    displayName: '1Password',
    tokenType: '1Password service account token',
    setupUrl: 'https://www.1password.dev/service-accounts/',
    permissions: ['Grant the service account access only to the vaults Hypervibe should read.'],
    credentialExample: 'hv_connect provider="1password" credentialsRef="env:OP_SERVICE_ACCOUNT_TOKEN"',
    notes: ['The token usually starts with ops_.'],
  },
  appstoreconnect: {
    provider: 'appstoreconnect',
    displayName: 'App Store Connect',
    tokenType: 'App Store Connect team API key (keyId + issuerId + .p8 private key)',
    setupUrl: 'https://appstoreconnect.apple.com/access/integrations/api',
    permissions: [
      'Create a Team Key under Users and Access -> Integrations (only Account Holder or Admin can generate one).',
      'App Manager role covers TestFlight groups/testers, builds, metadata, and App Store submissions.',
      'Use Admin role if Hypervibe should register bundle IDs and enable capabilities declared in the ios spec — Certificates, Identifiers & Profiles access requires it.',
    ],
    credentialExample: 'hv_connect provider="appstoreconnect" credentialsRef="file:/absolute/path/appstoreconnect.json"',
    notes: [
      'The JSON must include keyId, issuerId, and privateKey. The .p8 private key can only be downloaded once.',
      'Individual (per-user) keys do not work for provisioning operations; use a Team Key.',
    ],
  },
  'aws-secrets': {
    provider: 'aws-secrets',
    displayName: 'AWS Secrets Manager',
    tokenType: 'AWS IAM access key (accessKeyId/secretAccessKey, plus sessionToken for temporary STS session credentials)',
    setupUrl: 'https://docs.aws.amazon.com/secretsmanager/',
    permissions: [
      'secretsmanager:GetSecretValue and secretsmanager:ListSecrets for read-only resolution (ListSecrets is required for connection verification and hv_secrets_list).',
      'Add secretsmanager:CreateSecret, secretsmanager:PutSecretValue, secretsmanager:DescribeSecret, and secretsmanager:DeleteSecret if Hypervibe should manage secrets, and secretsmanager:RotateSecret for hv_secrets_sync rotation.',
    ],
    credentialExample: 'hv_connect provider="aws-secrets" credentialsRef="file:/absolute/path/aws-secrets.json"',
    notes: ['Credentials come from the connection or the AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN environment variables; profiles, SSO, and instance roles are not read.'],
  },
  'azure-container-apps': {
    provider: 'azure-container-apps',
    displayName: 'Azure Container Apps',
    tokenType: 'Microsoft Entra application service principal (tenantId, clientId, and clientSecret) scoped to one existing Azure subscription/resource group and Azure Container Registry',
    setupUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setupUrls: [
      {
        label: 'Create or review the Microsoft Entra application',
        url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      },
      {
        label: 'Microsoft Entra service-principal setup guide',
        url: 'https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal',
      },
      {
        label: 'Azure Container Apps built-in roles',
        url: 'https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers',
      },
      {
        label: 'Azure Container Registry service-principal authentication',
        url: 'https://learn.microsoft.com/en-us/azure/container-registry/container-registry-auth-service-principal',
      },
    ],
    permissions: [
      'At the exact resource-group scope Hypervibe will manage, assign Container Apps Contributor (role ID 358470bc-b998-42bd-ab17-a7e34c199c0f) for Container App lifecycle and managed-environment joins.',
      'At the same resource-group scope, assign Container Apps ManagedEnvironments Contributor (role ID 57cc5028-e6a7-4284-868d-0611c5923f8d) so Hypervibe can create, observe, and delete its managed environments.',
      'At the exact existing Azure Container Registry resource scope, grant Reader so Hypervibe can verify the durable registry binding.',
      'For a registry using classic Registry RBAC permissions, also grant AcrPush (role ID 8311e382-0749-4cb8-b61a-304f252e45ec). For an ABAC-enabled registry, use Container Registry Repository Writer (role ID 2a1e307c-b015-4ebd-883e-5b7698a07328) instead.',
    ],
    credentialExample: 'hv_connect provider="azure-container-apps" credentialsRef="file:/absolute/path/azure-container-apps.json"',
    notes: [
      'The JSON file must contain tenantId, subscriptionId, clientId, clientSecret, resourceGroup, location, registryId, and registryServer. registryId is the full ARM resource ID of an existing ACR registry; registryServer is its login hostname.',
      'Hypervibe owns its managed environments and Container Apps. It does not create or delete the subscription, resource group, registry, service principal, or role assignments.',
      'The same service principal is synchronized into the managed GitHub workflow, which pushes the full checked-out SHA to the existing registry and releases only already-bound Container App IDs by exact registry digest.',
      'Client secrets expire. Store this JSON outside the repository, rotate the secret before expiry, and reconnect with the replacement value; Hypervibe never prints or persists it in repo state.',
      'Container App service creation is confirmation-gated because the resulting compute and supporting Azure resources can be billable.',
    ],
  },
  'azure-postgres': {
    provider: 'azure-postgres',
    displayName: 'Azure Database for PostgreSQL',
    tokenType: 'Microsoft Entra application service principal (tenantId, clientId, and clientSecret) scoped to one existing Azure subscription/resource group',
    setupUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setupUrls: [
      {
        label: 'Create or review the Microsoft Entra application',
        url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      },
      {
        label: 'Microsoft Entra service-principal setup guide',
        url: 'https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal',
      },
      {
        label: 'PostgreSQL Flexible Server ARM operations',
        url: 'https://learn.microsoft.com/en-us/rest/api/postgresql/',
      },
      {
        label: 'PostgreSQL Flexible Server firewall behavior',
        url: 'https://learn.microsoft.com/en-us/azure/postgresql/security/security-firewall-rules',
      },
    ],
    permissions: [
      'At the exact resource-group scope, grant Microsoft.Resources/subscriptions/resourceGroups/read.',
      'Grant Microsoft.DBforPostgreSQL/flexibleServers/read, write, and delete plus Microsoft.DBforPostgreSQL/flexibleServers/databases/read and write.',
      'Grant Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/read and write so Hypervibe can install the reviewed Azure-services access rule required by Azure-hosted workloads.',
      'Resource-group Contributor is a broader fallback. Prefer a custom role containing only the operations above when your organization supports custom roles.',
    ],
    credentialExample: 'hv_connect provider="azure-postgres" credentialsRef="file:/absolute/path/azure-postgres.json"',
    notes: [
      'The JSON file must contain tenantId, subscriptionId, clientId, clientSecret, resourceGroup, and location. Optional postgresSkuName, postgresSkuTier, postgresVersion, and postgresStorageSizeGb values select the server shape.',
      'Hypervibe creates one Flexible Server, one logical app database, and a firewall rule whose start/end are 0.0.0.0. Microsoft defines that rule as access from Azure services; it includes other customers’ Azure resources, so strong generated database credentials remain essential.',
      'The generated administrator credential and connection URL are encrypted in local component state and never returned in plans, receipts, logs, or repo bindings.',
      'Client secrets expire. Store this JSON outside the repository, rotate before expiry, and reconnect with the replacement value.',
    ],
  },
  'azure-managed-redis': {
    provider: 'azure-managed-redis',
    displayName: 'Azure Managed Redis',
    tokenType: 'Microsoft Entra application service principal (tenantId, clientId, and clientSecret) scoped to one existing Azure subscription/resource group',
    setupUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setupUrls: [
      {
        label: 'Create or review the Microsoft Entra application',
        url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      },
      {
        label: 'Microsoft Entra service-principal setup guide',
        url: 'https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal',
      },
      {
        label: 'Azure Managed Redis built-in role',
        url: 'https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/databases',
      },
      {
        label: 'Azure Managed Redis REST operations',
        url: 'https://learn.microsoft.com/en-us/rest/api/redis/redisenterprisecache/',
      },
    ],
    permissions: [
      'At the exact resource-group scope, assign Azure Managed Redis Contributor (role ID 3015e5ed-6856-4ab3-b2f0-b8492aa30ca6). It creates/manages Managed Redis resources without granting cache data access.',
      'The service principal must be allowed to invoke the database listKeys action so Hypervibe can wire the generated TLS endpoint; confirm that a custom deny assignment does not remove this action.',
      'Also grant Microsoft.Resources/subscriptions/resourceGroups/read at the same scope when it is not already included by the role assignment.',
    ],
    credentialExample: 'hv_connect provider="azure-managed-redis" credentialsRef="file:/absolute/path/azure-managed-redis.json"',
    notes: [
      'The JSON file must contain tenantId, subscriptionId, clientId, clientSecret, resourceGroup, and location. Optional redisSkuName selects the billable cache size and defaults to Balanced_B0.',
      'Hypervibe creates one TLS-only Azure Managed Redis cluster and its default database with access-key authentication enabled. The access key and REDIS_URL are encrypted locally and never enter output or repo state.',
      'Client secrets expire. Store this JSON outside the repository, rotate before expiry, and reconnect with the replacement value.',
    ],
  },
  bitwarden: {
    provider: 'bitwarden',
    displayName: 'Bitwarden Secrets Manager',
    tokenType: 'Bitwarden Secrets Manager machine account access token',
    setupUrl: 'https://bitwarden.com/help/access-tokens/',
    permissions: ['Grant the machine account read access to the projects/secrets Hypervibe should resolve.'],
    credentialExample: 'hv_connect provider="bitwarden" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"accessToken":"BITWARDEN_ACCESS_TOKEN","organizationId":"BITWARDEN_ORGANIZATION_ID"}',
  },
  cloudflare: {
    provider: 'cloudflare',
    displayName: 'Cloudflare',
    tokenType: 'Cloudflare User API Token as apiToken for simple DNS, custom domains, email routing, and Registrar/domain purchase; or Cloudflare Account API Token as apiToken for durable DNS, custom domains, and email routing automation, with a separate User API Token only when that account-token setup also buys domains',
    setupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    setupUrls: [
      {
        label: 'User API Tokens for Registrar/domain purchase',
        url: 'https://dash.cloudflare.com/profile/api-tokens',
      },
      {
        label: 'Account API Tokens for DNS/custom domains/email routing',
        url: 'https://dash.cloudflare.com/?to=/:account/api-tokens',
      },
    ],
    permissions: [
      'For the simplest setup, create a Cloudflare User API Token in Cloudflare Dashboard -> My Profile -> API Tokens at https://dash.cloudflare.com/profile/api-tokens and map it as apiToken/CLOUDFLARE_API_TOKEN. That one token can manage DNS, custom domains, and email routing, and when granted Registrar permissions it can also register domains.',
      'For durable team/service automation that should not be tied to one user, create a Cloudflare Account API Token in Cloudflare Dashboard -> Manage Account -> Account API Tokens at https://dash.cloudflare.com/?to=/:account/api-tokens and map it as apiToken/CLOUDFLARE_API_TOKEN plus accountId/CLOUDFLARE_ACCOUNT_ID.',
      'For DNS/custom domains with either token type: grant Zone -> Zone -> Read.',
      'For DNS/custom domains with either token type: grant Zone -> DNS -> Edit.',
      'For Railway/custom-domain verification and some zone lookups: grant Zone -> Zone Settings -> Read or Edit.',
      'For DNS/custom domains with either token type: Zone Resources must be Include -> Specific zone -> the target domain, for example hlspropertycare.com.',
      'For email routing only: grant Zone -> Email Routing Rules -> Edit.',
      'For email routing only: grant Account -> Email Routing Addresses -> Edit.',
      'For accountId auto-resolution: grant Account -> Account Settings -> Read; otherwise pass accountId/CLOUDFLARE_ACCOUNT_ID explicitly.',
      'For Registrar/domain purchase: grant Registrar write permissions on a Cloudflare User API Token. If apiToken is already that User API Token, no second token is needed. If apiToken is an Account API Token, add a User API Token as registrarApiToken/CLOUDFLARE_REGISTRAR_API_TOKEN because Account API Tokens cannot be used for Registrar.',
    ],
    credentialExample: 'single User API Token: hv_connect provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}; account-token setup that also buys domains: hv_connect provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID","registrarApiToken":"CLOUDFLARE_REGISTRAR_API_TOKEN"}',
    notes: [
      'Create user tokens in Cloudflare Dashboard -> My Profile -> API Tokens at https://dash.cloudflare.com/profile/api-tokens; create account tokens in Cloudflare Dashboard -> Manage Account -> Account API Tokens at https://dash.cloudflare.com/?to=/:account/api-tokens.',
      'User API Tokens are fine for DNS, custom domains, and email routing, and are the simplest path when Hypervibe may also register domains. New user tokens use the documented cfut_ prefix.',
      'Account API Tokens are for durable service-principal style automation that should survive an individual user leaving the account. New account tokens use the documented cfat_ prefix (older tokens are unprefixed and still work). Cloudflare lists Registrar as NOT supported by Account API Tokens, so account-token setups need a User API Token only for Registrar/domain purchase.',
      'If the spec does not purchase/register domains, omit registrarApiToken. If apiToken is a User API Token with Registrar permissions, omit registrarApiToken even when registering domains.',
      'For either token type, use Create Token, start from the Edit zone DNS template when available, then confirm the permissions above for the target zone. Cloudflare token verification only proves the token is active, not that it has these permissions — missing permissions surface at apply time.',
      'Use the token secret itself as apiToken/CLOUDFLARE_API_TOKEN; do not use the token name or token id. Do not use the legacy Global API Key.',
    ],
  },
  cloudrun: {
    provider: 'cloudrun',
    displayName: 'Google Cloud Run',
    tokenType: 'Google Cloud service account JSON key',
    setupUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    permissions: [
      'Grant roles/run.admin on the target Google Cloud project so Hypervibe can create/update Cloud Run services and jobs.',
      'Grant roles/iam.serviceAccountUser on the runtime service account.',
      'Grant roles/cloudbuild.builds.editor so Hypervibe can run Cloud Build builds.',
      'Grant roles/artifactregistry.admin when Hypervibe should create the Docker repository; roles/artifactregistry.writer is enough if the repository already exists.',
      'Grant roles/serviceusage.serviceUsageAdmin so Hypervibe can auto-enable required APIs.',
      'Grant roles/cloudsql.client when using Cloud SQL, plus roles/cloudsql.admin if Hypervibe provisions the instance.',
      'Grant roles/cloudscheduler.admin when using cron jobs.',
      'Grant roles/pubsub.editor when using queues.',
      'Grant roles/logging.viewer and roles/logging.viewAccessor for logs.',
    ],
    credentialExample: 'hv_connect provider="cloudrun" credentialsRef="file:/absolute/path/cloudrun.json"',
    notes: [
      'Run hv_connect action="prepare" when Hypervibe should enable APIs and grant these roles from one-time admin credentials.',
      'Google recommends short-lived credentials over long-lived service account JSON keys; if you use a JSON key, rotate it and grant only the roles above.',
    ],
  },
  cloudsql: {
    provider: 'cloudsql',
    displayName: 'Google Cloud SQL',
    tokenType: 'Google Cloud service account JSON key',
    setupUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    permissions: [
      'Grant roles/cloudsql.viewer to the connected service account so connection verification can list and inspect Cloud SQL instances.',
      'Grant roles/cloudsql.client to the connected service account so hv_db_query can open its operation-scoped authenticated connector.',
      'Also grant roles/cloudsql.admin when Hypervibe should create or delete Cloud SQL instances and logical databases through hv_plan/hv_apply.',
      'The Cloud Run runtime service account separately needs roles/cloudsql.client when deployed services connect through /cloudsql.',
      'The sqladmin.googleapis.com API must already be enabled — hv_connect provider="cloudrun" action="prepare" enables it.',
    ],
    credentialExample: 'hv_connect provider="cloudsql" credentialsRef="file:/absolute/path/cloudsql.json"',
  },
  memorystore: {
    provider: 'memorystore',
    displayName: 'Google Cloud Memorystore',
    tokenType: 'Google Cloud service account JSON key scoped to one project and existing VPC network',
    setupUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    permissions: [
      'Grant roles/redis.viewer for connection verification and live observation of Memorystore instances.',
      'Grant roles/redis.admin when Hypervibe should create and delete Memorystore instances through hv_plan/hv_apply.',
      'Grant serviceusage.services.use on the target project (roles/serviceusage.serviceUsageConsumer is the standard role) and enable redis.googleapis.com before connecting.',
      'The Cloud Run runtime separately needs a declarative VPC egress path to the authorizedNetwork. The current Cloud Run adapter does not create that path, so the Cloud Run + Memorystore full-stack live profile remains blocked.',
    ],
    credentialExample: 'hv_connect provider="memorystore" credentialsRef="file:/absolute/path/memorystore.json"',
    notes: [
      'The JSON must include projectId, credentials (the service-account JSON as a string), and region. authorizedNetwork may select an existing full VPC resource name; it defaults to projects/<projectId>/global/networks/default.',
      'Hypervibe creates private-IP Redis with AUTH enabled and transit encryption disabled. Access is limited by the selected VPC, so never treat the resulting REDIS_URL as internet reachable.',
      'Google recommends short-lived credentials over service-account JSON keys. If a key is required, rotate it and grant only the project roles above.',
    ],
  },
  database: {
    provider: 'database',
    displayName: 'External database',
    tokenType: 'database connection URL',
    permissions: ['Use a database user with the least privileges required for the intended hv_db query or migration operation.'],
    credentialExample: 'hv_connect provider="database" credentialsRef="dotenv:/absolute/path/.env#DATABASE_URL"',
  },
  digitalocean: {
    provider: 'digitalocean',
    displayName: 'DigitalOcean',
    tokenType: 'DigitalOcean personal access token (PAT, normally prefixed dop_v1_)',
    setupUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    permissions: [
      'For Managed PostgreSQL and Valkey observation, grant database:read and database:view_credentials on the DigitalOcean team that owns the clusters.',
      'For Managed PostgreSQL and Valkey lifecycle through hv_plan/hv_apply, also grant database:create, database:update, and database:delete.',
      'DigitalOcean requires regions:read, sizes:read, and actions:read alongside non-read database scopes so Hypervibe can validate regions/sizes and observe asynchronous actions.',
      'When DigitalOcean App Platform hosting is enabled, also grant app:read, app:create, app:update, and app:delete; omit those app scopes for a database/cache-only connection.',
      'For exact-SHA App Platform CI deploys, grant registry:read and registry:update on the team that owns the existing DOCR registry named by containerRegistry.',
    ],
    credentialExample: 'hv_connect provider="digitalocean" credentialsRef="file:/absolute/path/digitalocean.json"',
    notes: [
      'Create the PAT at https://cloud.digitalocean.com/account/api/tokens with Custom Scopes for least privilege. Full Access is a broader fallback, not the recommended default.',
      'For App Platform CI, the JSON credential file must contain apiToken and containerRegistry. Hypervibe verifies the registry but never creates a registry implicitly because registry subscriptions can be billable.',
      'DigitalOcean shows a PAT only once. Store it in a dotenv file or secret manager instead of chat; Hypervibe accepts DIGITALOCEAN_TOKEN and HYPERVIBE_DIGITALOCEAN_TOKEN.',
      'Token scopes cannot be changed after creation, and the token cannot exceed its creator\'s DigitalOcean team role. Create a replacement token if scopes or team access are wrong.',
    ],
  },
  ecs: {
    provider: 'ecs',
    displayName: 'Amazon ECS on Fargate',
    tokenType: 'AWS IAM user access key (accessKeyId and secretAccessKey) for one commercial-partition account and region; the same scoped key is synchronized to managed GitHub Actions',
    setupUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    setupUrls: [
      {
        label: 'Create or review the IAM access key',
        url: 'https://console.aws.amazon.com/iam/home#/security_credentials',
      },
      {
        label: 'AWS access-key security guidance',
        url: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html',
      },
      {
        label: 'Amazon ECS API permissions reference',
        url: 'https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonelasticcontainerservice.html',
      },
      {
        label: 'Amazon ECR repository push permissions',
        url: 'https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-push-iam.html',
      },
    ],
    permissions: [
      'For ECS observation and lifecycle: ecs:ListAccountSettings, ecs:ListClusters, ecs:DescribeClusters, ecs:CreateCluster, ecs:DeleteCluster, ecs:ListServices, ecs:DescribeServices, ecs:CreateService, ecs:UpdateService, ecs:DeleteService, ecs:RegisterTaskDefinition, ecs:DescribeTaskDefinition, ecs:ListTaskDefinitions, ecs:DeregisterTaskDefinition, ecs:DeleteTaskDefinitions, ecs:ListTasks, ecs:DescribeTasks, ecs:TagResource, and ecs:ListTagsForResource.',
      'For the existing private ECR repository and exact-digest managed workflow: ecr:GetAuthorizationToken on Resource="*", plus ecr:DescribeRepositories, ecr:BatchCheckLayerAvailability, ecr:GetDownloadUrlForLayer, ecr:BatchGetImage, ecr:InitiateLayerUpload, ecr:UploadLayerPart, ecr:CompleteLayerUpload, and ecr:PutImage on the exact repository ARN.',
      'For read-only network prerequisite verification: ec2:DescribeSubnets and ec2:DescribeSecurityGroups. Hypervibe does not create, modify, or delete the VPC, subnets, or security groups.',
      'For an existing public Application Load Balancer target: elasticloadbalancing:DescribeTargetGroups, elasticloadbalancing:DescribeLoadBalancers, elasticloadbalancing:DescribeListeners, and elasticloadbalancing:DescribeRules. Hypervibe does not create, modify, or delete the load balancer, listener rules, or target group.',
      'For existing ECS task roles: iam:GetRole and iam:PassRole on the exact execution-role ARN and optional task-role ARN. Restrict iam:PassedToService to ecs-tasks.amazonaws.com.',
    ],
    credentialExample: 'hv_connect provider="ecs" credentialsRef="file:/absolute/path/aws-ecs.json"',
    notes: [
      'The JSON must include accessKeyId, secretAccessKey, region, ecrRepositoryArn, ecrRepositoryUri, subnetIds (a JSON array), securityGroupIds (a JSON array), and executionRoleArn. Public web services also require targetGroupArn. Set publicUrl to the externally routed HTTP(S) origin when the target is not the default HTTP listener action, including HTTPS-only listeners; taskRoleArn and assignPublicIp are optional.',
      'The existing ECR repository, VPC subnets, security groups, IAM roles, and optional Application Load Balancer target group stay externally owned. Hypervibe owns only its ECS cluster, ECS services, and task-definition revisions.',
      'Scope ECS create/update/delete permissions to the intended Hypervibe cluster, service, and task-definition-family ARN patterns where AWS supports resource-level authorization. ECS list/account-setting actions require Resource="*", and cross-cluster service observation must remain available so Hypervibe can prove the external target group is not already attached elsewhere.',
      'A public target group must use target type ip, be in the subnet/security-group VPC, and be routed by an HTTP or HTTPS listener on one active internet-facing Application Load Balancer. One target group cannot be shared implicitly by multiple Hypervibe services.',
      'The selected subnets need outbound access to ECR and application dependencies, and the security group must allow the load balancer to reach containerPort while permitting required egress. Hypervibe verifies identity and VPC scope but does not modify these external network rules.',
      'Both configured IAM roles must trust ecs-tasks.amazonaws.com for sts:AssumeRole. The execution role also needs the usual private-ECR pull permissions (ecr:GetAuthorizationToken, ecr:BatchCheckLayerAvailability, ecr:GetDownloadUrlForLayer, and ecr:BatchGetImage); Hypervibe verifies the trust relationship but cannot prove every attached role policy before a task runs.',
      'Enable the ECS serviceLongArnFormat account setting before connecting. Durable long-form service ARNs are required so Hypervibe can prove exact cluster and service identity.',
      'Service creation is billable and exact-action confirmation-gated. Apply creates a zero-task bootstrap service; the managed workflow builds the full checked-out Git SHA, publishes it to the existing repository, resolves the ECR digest, and scales only already-bound services to one task.',
      'This adapter currently supports the commercial aws partition and static IAM access keys. Keep the credential file outside the repository, rotate the key regularly, and reconnect after rotation; support for temporary STS/OIDC credentials requires a separate credential lifecycle.',
    ],
  },
  elasticache: {
    provider: 'elasticache',
    displayName: 'Amazon ElastiCache',
    tokenType: 'AWS IAM access key (accessKeyId/secretAccessKey, plus sessionToken for temporary STS credentials) scoped to one account, region, and VPC',
    setupUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    permissions: [
      'For verification and observation: elasticache:DescribeServerlessCaches, ec2:DescribeSubnets, and ec2:DescribeSecurityGroups.',
      'For lifecycle management through hv_plan/hv_apply: elasticache:CreateServerlessCache, elasticache:DeleteServerlessCache, elasticache:AddTagsToResource, ec2:CreateSecurityGroup, ec2:AuthorizeSecurityGroupIngress, ec2:DeleteSecurityGroup, and ec2:CreateTags.',
      'If the account has never used ElastiCache, allow iam:CreateServiceLinkedRole only when iam:AWSServiceName equals elasticache.amazonaws.com, or have an administrator create that service-linked role first.',
    ],
    credentialExample: 'hv_connect provider="elasticache" credentialsRef="file:/absolute/path/elasticache.json"',
    notes: [
      'The JSON must include accessKeyId, secretAccessKey, region, at least two subnetIds in distinct availability zones, and one or more securityGroupIds used by the workloads that connect to the cache.',
      'Hypervibe creates a dedicated managed security group that accepts TCP 6379 only from the declared workload security groups, then creates a TLS-only serverless Valkey cache in those subnets.',
      'Deletion waits for provider-confirmed cache absence before removing the managed security group. Cache deletion is data-bearing and exact-action confirmation remains required.',
      'Prefer temporary STS credentials. Scope mutation permissions to the intended account, region, VPC, and Hypervibe-tagged resources where AWS supports resource-level conditions.',
    ],
  },
  doppler: {
    provider: 'doppler',
    displayName: 'Doppler',
    tokenType: 'Doppler service token (read-only by default; create with read/write if Hypervibe should write secrets)',
    setupUrl: 'https://docs.doppler.com/docs/service-tokens',
    permissions: [
      'Create a service token scoped to the project/config Hypervibe should read.',
      'If Hypervibe should write or delete secrets (hv_secrets_set target="manager"), create the service token with read/write access.',
    ],
    credentialExample: 'hv_connect provider="doppler" credentialsRef="env:DOPPLER_TOKEN"',
    notes: ['Service tokens start with dp.st. and are scoped to a single config.'],
  },
  github: {
    provider: 'github',
    displayName: 'GitHub',
    tokenType: 'classic GitHub personal access token with repo, workflow, and read:packages for the one-token setup; or a fine-grained repository token plus a separate classic package-read PAT for least privilege',
    setupUrl: GITHUB_TOKEN_URLS.combined,
    setupUrls: [
      { label: 'Create recommended combined classic token', url: GITHUB_TOKEN_URLS.combined },
      { label: 'Create recommended fine-grained repository token', url: 'https://github.com/settings/personal-access-tokens/new' },
      { label: 'Create optional classic GHCR package token', url: GITHUB_TOKEN_URLS.packageRead },
      { label: 'GitHub fine-grained permission reference', url: 'https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens' },
    ],
    permissions: [
      'Select the repository owner and only the repositories Hypervibe should manage. Grant Metadata read; Administration read/write; Actions read/write; Contents read/write; Issues read/write; Pull requests read/write; Secrets read/write; and Workflows read/write.',
      'When enabled in desired state, also grant Dependabot alerts read/write, Code scanning alerts read/write, and Secret scanning alerts read/write. Organization policy and product entitlement can still block these settings; Hypervibe reports that without claiming success.',
      'For the one-token classic PAT setup, grant repo, workflow, and read:packages. Hypervibe uses it for API management and package/image reads.',
      `For private GHCR image pulls, packageReadToken must have read:packages — create it here: ${GITHUB_TOKEN_URLS.packageRead}. This can be the same classic PAT only when that PAT also has repo + workflow + read:packages.`,
    ],
    credentialExample: 'export NODE_AUTH_TOKEN="<classic PAT with repo, workflow, read:packages>"; hv_connect provider="github" scope="owner/repository" credentialsRef="env:NODE_AUTH_TOKEN"',
    notes: [
      'NODE_AUTH_TOKEN, HYPERVIBE_GITHUB_TOKEN, and HYPERVIBE_GITHUB_PACKAGES_TOKEN are accepted as aliases when resolving GitHub credentials. Use NODE_AUTH_TOKEN when npm also needs the token.',
      'An explicitly referenced variable wins. If it is absent and multiple aliases contain different values, Hypervibe blocks instead of guessing.',
      'A read:packages-only token cannot manage repository infrastructure; use it only as packageReadToken.',
      'Fine-grained PAT responses do not expose classic OAuth scopes. Hypervibe verifies identity and discovers missing endpoint permissions during plan/apply.',
      `A classic apiToken remains supported for compatibility and needs repo + workflow (${GITHUB_TOKEN_URLS.api}); security endpoints may also need security_events.`,
    ],
  },
  heroku: {
    provider: 'heroku',
    displayName: 'Heroku',
    tokenType: 'Heroku Platform API bearer token (prefer a revocable OAuth direct-authorization token with global scope for durable automation)',
    setupUrl: 'https://dashboard.heroku.com/account',
    setupUrls: [
      {
        label: 'Heroku Account Settings API key',
        url: 'https://dashboard.heroku.com/account',
      },
      {
        label: 'Heroku OAuth direct authorization',
        url: 'https://devcenter.heroku.com/articles/oauth#direct-authorization',
      },
    ],
    permissions: [
      'Heroku direct authorizations expose the Platform API global scope; Heroku does not offer an app-scoped permission set for this token type.',
      'The Heroku user behind the token must be allowed to list, create, inspect, configure, release, scale, and delete apps in the intended account/team.',
      'The same token authenticates the managed GitHub workflow to registry.heroku.com and authorizes exact-image formation releases.',
    ],
    credentialExample: 'export HEROKU_API_KEY="<Heroku bearer token>"; hv_connect provider="heroku" credentialsRef="env:HEROKU_API_KEY"',
    notes: [
      'The Account Settings API key is available only for non-SSO users, is account-wide, and is invalidated by a password change. Use a separately revocable direct authorization for durable automation when possible.',
      'Federated/SSO users cannot issue non-expiring direct authorizations. Heroku recommends a separate non-federated automation user invited only to the intended organization when a long-lived integration token is required.',
      'For JSON credentials, apiKey is required; region defaults to us and dynoSize defaults to basic. HEROKU_API_KEY and HYPERVIBE_HEROKU_API_KEY are accepted aliases.',
      'The default basic dyno is billable once the managed workflow releases and scales a process to one. Hypervibe marks service creation billable and requires the exact reviewed action id before apply.',
      'Store the token in an exported variable, dotenv file, or secret manager. It grants broad account access and must never be committed or printed.',
    ],
  },
  openai: {
    provider: 'openai',
    displayName: 'OpenAI API',
    tokenType: 'OpenAI project API key stored as apiKey (not a ChatGPT subscription or browser session)',
    setupUrl: 'https://platform.openai.com/api-keys',
    permissions: [
      'Create the key in the OpenAI project that should pay for and audit Hypervibe coding automation.',
      'The project must have access to gpt-5.6-sol and the key must allow model reads plus Responses API writes.',
      'Scope the key to this project and keep it out of the repository; Hypervibe syncs it only as the OPENAI_API_KEY Actions secret.',
    ],
    credentialExample: 'hv_connect provider="openai" scope="owner/repository" credentialsRef="env:OPENAI_API_KEY"',
    notes: [
      'OpenAI API billing is separate from ChatGPT plans. Set project budgets and usage limits in the OpenAI Platform before enabling scheduled AI automation.',
      'The key is never included in specs, plans, logs, snapshots, or workflow files.',
    ],
  },
  local: {
    provider: 'local',
    displayName: 'Local Docker',
    tokenType: 'local Docker socket path',
    permissions: ['The local user must be able to access the Docker socket.'],
    credentialExample: 'hv_connect provider="local" credentials={"dockerSocket":"/var/run/docker.sock"}',
  },
  rds: {
    provider: 'rds',
    displayName: 'Amazon RDS',
    tokenType: 'AWS IAM access key (accessKeyId/secretAccessKey, plus sessionToken for temporary STS credentials)',
    setupUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    permissions: [
      'For verification and observation: rds:DescribeDBInstances, ec2:DescribeVpcs, ec2:DescribeSecurityGroups, and ec2:DescribeSecurityGroupRules.',
      'For operation-scoped hv_db_query access: ec2:AuthorizeSecurityGroupIngress and ec2:RevokeSecurityGroupIngress on the database security group.',
      'For lifecycle management through hv_plan/hv_apply: rds:CreateDBInstance, rds:DeleteDBInstance, rds:AddTagsToResource, ec2:CreateSecurityGroup, ec2:DeleteSecurityGroup, and ec2:CreateTags.',
    ],
    credentialExample: 'hv_connect provider="rds" credentialsRef="file:/absolute/path/rds.json"',
    notes: [
      'The JSON must include accessKeyId, secretAccessKey, and region; include sessionToken for temporary STS credentials, plus vpcId/dbSubnetGroupName when the region has no suitable default VPC.',
      'Scope RDS mutation permissions to the intended DB instance ARNs and EC2 mutation permissions to security groups in the intended account, region, and VPC. AWS describe actions generally require Resource="*".',
      'Hypervibe-created RDS instances are publicly addressable but start with no public ingress. hv_db_query adds only the current caller IPv4 /32 and removes it after the query. Private-only RDS requires a durable VPC/SSM path declared outside this diagnostic call.',
      'Prefer temporary STS credentials. IAM user secret access keys are shown only once when created and should be rotated regularly.',
    ],
  },
  railway: {
    provider: 'railway',
    displayName: 'Railway',
    tokenType: 'Railway Account API token (create with "No workspace" selected)',
    setupUrl: 'https://railway.com/account/tokens',
    permissions: [
      'Account tokens act with your access across workspaces; Hypervibe needs one that can create projects, services, environments, variables, databases, domains, and deployments in the target workspace.',
    ],
    credentialExample: 'hv_connect provider="railway" credentialsRef="dotenv:/absolute/path/.env#HYPERVIBE_RAILWAY_TOKEN"',
    notes: [
      'Create the token at https://railway.com/account/tokens and select "No workspace" so it is an account token. Hypervibe verifies with the GraphQL me query, which Railway documents as unusable with workspace or project tokens — workspace-scoped tokens fail verification.',
      'Do NOT use a Project token (from a project\'s settings page): project tokens are scoped to one environment, use a different auth header, and cannot call the account-level API Hypervibe needs.',
      'If multiple workspaces are visible, include workspaceId: credentialsMap={"apiToken":"HYPERVIBE_RAILWAY_TOKEN","workspaceId":"RAILWAY_WORKSPACE_ID"} so projects are created in the right workspace.',
    ],
  },
  render: {
    provider: 'render',
    displayName: 'Render',
    tokenType: 'Render personal API key plus the target workspace ID (tea-...; a legacy own-... ID resolves to the user default workspace)',
    setupUrl: 'https://dashboard.render.com/u/settings#api-keys',
    permissions: [
      'Render API keys are not scope-selectable and inherit access to every workspace your Render user belongs to; use ownerId to pin Hypervibe to the one intended workspace.',
      'The Render user must be allowed to read, create, update, and delete services, Postgres instances, and Key Value instances in that workspace for the lifecycle capabilities declared in the spec.',
      'For exact-SHA CI deploys, create a GitHub Container Registry credential in the target Render workspace and pass its durable ID as registryCredentialId; Hypervibe verifies and reuses it but never creates or rotates it implicitly.',
    ],
    credentialExample: 'hv_connect provider="render" credentialsRef="file:/absolute/path/render.json"',
    notes: [
      'Create the API key under Render Account Settings -> API Keys at https://dashboard.render.com/u/settings#api-keys. Render shows the key only once.',
      'Find the workspace ID on the workspace Settings page. The JSON must contain apiKey and ownerId; add registryCredentialId when Render hosting uses the managed exact-SHA GitHub Actions workflow.',
      'Create the registry credential under Workspace Settings -> Container Registry Credentials for GitHub Container Registry. Its GitHub token needs read:packages for the private image repository; scope the GitHub account/repository as narrowly as possible.',
      'Store the API key and registry credential ID in a local JSON or dotenv reference instead of chat. RENDER_API_KEY and HYPERVIBE_RENDER_API_KEY are accepted API-key aliases.',
    ],
  },
  vercel: {
    provider: 'vercel',
    displayName: 'Vercel',
    tokenType: 'Vercel personal access token created under the Personal Account and scoped to the intended personal account or Team (new tokens normally use the vcp_ prefix)',
    setupUrl: 'https://vercel.com/account/settings/tokens',
    setupUrls: [
      {
        label: 'Create or review Vercel personal access tokens',
        url: 'https://vercel.com/account/settings/tokens',
      },
      {
        label: 'Vercel access-token and Team-scope guidance',
        url: 'https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token',
      },
      {
        label: 'Vercel roles and extended permissions',
        url: 'https://vercel.com/docs/rbac/access-roles',
      },
    ],
    permissions: [
      'For a Team scope, use an Owner or Member token identity, or a Developer/Contributor identity granted Create Project, Full Production Deployment, and Environment Variable Manager permissions for the intended Team.',
      'Hypervibe needs REST access to read/create/delete Projects, read and upsert/delete Project environment variables, upload deployment files, and create/read production Deployments.',
      'Scope the token to only the intended Vercel Team when possible and include that immutable teamId in the connection JSON; omit teamId only for a personal-account deployment scope.',
    ],
    credentialExample: 'hv_connect provider="vercel" credentialsRef="file:/absolute/path/vercel.json"',
    notes: [
      'The JSON must contain accessToken and may contain teamId. Find the immutable Team ID under Team Settings -> General; Hypervibe records only a non-secret team:<id> or user:<id> binding.',
      'VERCEL_ACCESS_TOKEN, VERCEL_TOKEN, and HYPERVIBE_VERCEL_ACCESS_TOKEN are accepted aliases when resolving a scalar accessToken. Use a JSON file or credentialsMap when teamId is required.',
      'Hypervibe creates source-less Vercel Projects and deploys exact checked-out Git files through the REST API. If a bound Project has a Vercel-native Git link, CI reconciliation blocks until that link is manually disconnected.',
      'The Vercel hosting slice supports public web projects built by Vercel framework/static auto-detection. It rejects workers, cron jobs, release commands, arbitrary long-lived start commands, and build/Dockerfile overrides it cannot honestly apply.',
      'Project creation and production deployments may consume metered build/function resources. Hypervibe confirmation-gates service creation and never creates Projects from the managed CI workflow.',
    ],
  },
  recaptcha: {
    provider: 'recaptcha',
    displayName: 'reCAPTCHA',
    tokenType: 'Google reCAPTCHA site key and legacy secret key',
    setupUrl: 'https://console.cloud.google.com/security/recaptcha',
    permissions: ['Create a key for the correct reCAPTCHA version and allow the target domains.'],
    credentialExample: 'hv_connect provider="recaptcha" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"siteKey":"RECAPTCHA_SITE_KEY","secretKey":"RECAPTCHA_SECRET_KEY"}',
    notes: [
      'Classic reCAPTCHA keys were migrated into Google Cloud; create keys in the Google Cloud console (Security -> reCAPTCHA), then use the site key plus the "Legacy secret key" from Key details -> Integration so the classic siteverify API keeps working.',
      'Keys assessed only via the reCAPTCHA Enterprise API are not supported by this integration.',
    ],
  },
  sendgrid: {
    provider: 'sendgrid',
    displayName: 'SendGrid',
    tokenType: 'SendGrid API key (Restricted Access for least privilege; Full Access is the reliable choice during setup)',
    setupUrl: 'https://app.sendgrid.com/settings/api_keys',
    permissions: [
      'Grant mail.send so Hypervibe can sync a runtime SENDGRID_API_KEY that can send transactional email.',
      'For domain authentication: whitelabel.read, whitelabel.create, whitelabel.update (SendGrid still names these scopes "whitelabel" even though the UI says Sender Authentication).',
      'For single-sender verification: SendGrid publishes no restricted scope for the /verified_senders API — use a Full Access key for this path; hypervibe checks user.email.* as a best-effort signal.',
      'For event webhook setup: user.webhooks.event.settings.read and user.webhooks.event.settings.update.',
      'For inbound parse (email forwarding): user.webhooks.parse.settings read/create/delete.',
    ],
    credentialExample: 'hv_connect provider="sendgrid" credentialsRef="dotenv:/absolute/path/.env#SENDGRID_API_KEY"',
    notes: [
      'Setup needs mail.send plus EITHER domain authentication OR sender verification — not necessarily all scopes.',
      'Full Access is acceptable during setup; rotate to a narrower runtime key after sender/domain authorization if desired. Note some restricted keys cannot call GET /v3/scopes, which fails verification even for usable keys.',
    ],
  },
  stripe: {
    provider: 'stripe',
    displayName: 'Stripe',
    tokenType: 'Stripe environment key pair: secretKey (sk_test_... for a named sandbox, sk_live_... for production) and optional publishableKey (pk_test_.../pk_live_...). Legacy global sandboxSecretKey/liveSecretKey fields remain supported. Restricted keys (rk_...) are not accepted',
    setupUrl: 'https://dashboard.stripe.com/apikeys',
    permissions: [
      'The key must be able to read the account, read/write Products and Prices, read/write Customers, and read/write Webhook Endpoints. A standard secret key covers all of these.',
      'Create a separate scoped connection for each isolated Stripe sandbox and for production; the scope should match payments.stripe.environment (normally development, staging, or production).',
    ],
    credentialExample: 'hv_connect provider="stripe" scope="staging" credentialsRef="file:/absolute/path/stripe-staging.json" where the JSON is {"secretKey":"<sk_test_...>","publishableKey":"<pk_test_...>"}',
    notes: [
      'Open the intended named sandbox first, then create/reveal its keys in the Stripe Dashboard (https://dashboard.stripe.com/test/apikeys). Stripe sandbox access/key guidance: https://docs.stripe.com/sandboxes/dashboard/manage-access. Keys are isolated to that sandbox.',
      'For an existing dotenv file, use credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"secretKey":"STRIPE_SECRET_KEY","publishableKey":"STRIPE_PUBLISHABLE_KEY"}; omit publishableKey from both the spec credential projection and credentialsMap if it is unavailable.',
      'A global legacy connection can still carry sandboxSecretKey/sandboxPublishableKey plus liveSecretKey/livePublishableKey, but separate scoped connections are required when development and staging use different Stripe sandboxes.',
    ],
  },
  supabase: {
    provider: 'supabase',
    displayName: 'Supabase',
    tokenType: 'Supabase personal access token',
    setupUrl: 'https://supabase.com/dashboard/account/tokens',
    permissions: [
      'Personal access tokens are not permission-scoped: they carry your full account privileges. Your account must be an Owner or Administrator of the target organization to create projects (Developer/Read-only roles cannot).',
      'Include organizationId when multiple organizations are visible.',
    ],
    credentialExample: 'hv_connect provider="supabase" credentialsRef="dotenv:/absolute/path/.env#SUPABASE_ACCESS_TOKEN"',
  },
  neon: {
    provider: 'neon',
    displayName: 'Neon',
    tokenType: 'Neon personal API key or organization API key with project create/read/delete access (not a project-scoped organization key)',
    setupUrl: 'https://console.neon.tech/app/settings/api-keys',
    permissions: [
      'Use a personal API key for personal projects, or a personal API key with organizationId / an organization API key for organization projects; the identity must be allowed to create, read, and delete projects in the target account or organization.',
      'Do not use a project-scoped organization API key: Neon limits it to one existing project and explicitly prevents destructive project operations such as project deletion.',
    ],
    credentialExample: 'hv_connect provider="neon" credentialsRef="dotenv:/absolute/path/.env#NEON_API_KEY"',
    notes: [
      'organizationId is required when a personal API key should manage organization-owned projects; use credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiKey":"NEON_API_KEY","organizationId":"NEON_ORGANIZATION_ID"} in that case. Omit it for personal projects or when an organization API key already infers the organization.',
      'regionId is optional and uses Neon region IDs such as aws-us-west-2. The API key token is shown only when created, so store it in a dotenv file or secret manager instead of chat.',
    ],
  },
  tunnel: {
    provider: 'tunnel',
    displayName: 'Tunnel',
    tokenType: 'optional ngrok auth token or local cloudflared setup',
    setupUrl: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/',
    permissions: ['cloudflared quick tunnels need no API token; ngrok requires an auth token for authenticated tunnels (create: https://dashboard.ngrok.com/get-started/your-authtoken).'],
    credentialExample: 'hv_connect provider="tunnel" credentialsRef="file:/absolute/path/tunnel.json"',
  },
  vault: {
    provider: 'vault',
    displayName: 'HashiCorp Vault',
    tokenType: 'Vault token or AppRole role_id/secret_id',
    setupUrl: 'https://developer.hashicorp.com/vault/docs/secrets/kv/kv-v2',
    permissions: [
      'read on <mount>/data/<path> and list on <mount>/metadata/<path> for the KV v2 secrets Hypervibe should resolve.',
      'Add create/update on <mount>/data/<path> if Hypervibe should write secrets, and delete on <mount>/metadata/<path> if it should delete them (deletion removes all versions).',
      "auth/token/lookup-self is used for verification; it is included in Vault's default policy.",
    ],
    credentialExample: 'hv_connect provider="vault" credentialsRef="file:/absolute/path/vault.json"',
  },
};

export function getConnectionGuidance(provider: string): ConnectionGuidance | undefined {
  return GUIDANCE[provider];
}

function credentialExample(guidance: ConnectionGuidance, scope?: string): string {
  if (!scope) {
    return guidance.credentialExample;
  }
  switch (guidance.provider) {
    case 'cloudflare':
      return guidance.credentialExample.replaceAll('scope="example.com"', `scope="${scope}"`);
    case 'github':
      return guidance.credentialExample.replace('provider="github"', `provider="github" scope="${scope}"`);
    case 'database':
      return guidance.credentialExample.replace('provider="database"', `provider="database" scope="${scope}"`);
    case 'appstoreconnect':
      return guidance.credentialExample.replace('provider="appstoreconnect"', `provider="appstoreconnect" scope="${scope}"`);
    default:
      return guidance.credentialExample;
  }
}

export function connectionSetupDetails(
  provider: string,
  options: { scope?: string } = {}
): ConnectionSetupDetails {
  const guidance = getConnectionGuidance(provider);
  if (!guidance) {
    return {
      provider,
      ...(options.scope ? { scope: options.scope } : {}),
      setupUrls: [],
      requiredPermissions: [],
      credentialExample: `hv_connect provider="${provider}" credentialsRef="env:NAME"`,
      notes: [
        'Run hv_connections_list to see the provider schema and credential fields.',
        'Prefer credentialsRef="env:NAME", credentialsRef="dotenv:/absolute/path/.env#KEY", or credentialsRef="file:/absolute/path" so secrets do not enter chat.',
      ],
    };
  }

  const setupUrls = guidance.setupUrls?.length
    ? guidance.setupUrls.map((entry) => `${entry.label}: ${entry.url}`)
    : guidance.setupUrl ? [guidance.setupUrl] : [];

  return {
    provider,
    ...(options.scope ? { scope: options.scope } : {}),
    displayName: guidance.displayName,
    tokenType: guidance.tokenType,
    setupUrls,
    requiredPermissions: guidance.permissions,
    credentialExample: credentialExample(guidance, options.scope),
    ...(guidance.notes?.length ? { notes: guidance.notes } : {}),
  };
}

export function formatConnectionGuidance(
  provider: string,
  options: { scope?: string; intro?: string } = {}
): string {
  const guidance = getConnectionGuidance(provider);
  const scopeText = options.scope ? ` for ${options.scope}` : '';
  if (!guidance) {
    return [
      options.intro ?? `Confirm the ${provider} credential type and permissions${scopeText}.`,
      'Use hv_connections_list to see the provider schema and use credentialsRef="env:NAME" or credentialsRef="dotenv:/absolute/path/.env#KEY" where possible.',
    ].join(' ');
  }

  const parts = [
    options.intro ?? `Confirm the ${guidance.displayName} credential type and permissions${scopeText}.`,
    `Token/credential type: ${guidance.tokenType}.`,
    guidance.setupUrls?.length
      ? `Create or review it here: ${guidance.setupUrls.map((entry) => `${entry.label}: ${entry.url}`).join('; ')}.`
      : guidance.setupUrl ? `Create or review it here: ${guidance.setupUrl}.` : undefined,
    `Required permissions: ${guidance.permissions.join(' ')}`,
    guidance.notes?.length ? `Notes: ${guidance.notes.join(' ')}` : undefined,
    `Connect with: ${credentialExample(guidance, options.scope)}.`,
  ].filter(Boolean);
  return parts.join(' ');
}

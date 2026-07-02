export interface ConnectionGuidance {
  provider: string;
  displayName: string;
  tokenType: string;
  setupUrl?: string;
  permissions: string[];
  credentialExample: string;
  notes?: string[];
}

const GUIDANCE: Record<string, ConnectionGuidance> = {
  '1password': {
    provider: '1password',
    displayName: '1Password',
    tokenType: '1Password service account token',
    setupUrl: 'https://developer.1password.com/docs/service-accounts/',
    permissions: ['Grant the service account access only to the vaults Hypervibe should read.'],
    credentialExample: 'hv_connect provider="1password" credentialsRef="env:OP_SERVICE_ACCOUNT_TOKEN"',
    notes: ['The token usually starts with ops_.'],
  },
  appstoreconnect: {
    provider: 'appstoreconnect',
    displayName: 'App Store Connect',
    tokenType: 'App Store Connect API key',
    setupUrl: 'https://appstoreconnect.apple.com/access/api',
    permissions: ['Admin role is recommended for TestFlight, build, capability, and app-management operations.'],
    credentialExample: 'hv_connect provider="appstoreconnect" credentialsRef="file:/absolute/path/appstoreconnect.json"',
    notes: ['The JSON must include keyId, issuerId, and privateKey. The .p8 private key can only be downloaded once.'],
  },
  'aws-secrets': {
    provider: 'aws-secrets',
    displayName: 'AWS Secrets Manager',
    tokenType: 'AWS IAM access key or default AWS credential chain',
    setupUrl: 'https://docs.aws.amazon.com/secretsmanager/',
    permissions: [
      'secretsmanager:GetSecretValue and secretsmanager:DescribeSecret for read-only secret resolution.',
      'Add secretsmanager:ListSecrets, secretsmanager:CreateSecret, secretsmanager:PutSecretValue, secretsmanager:UpdateSecret, and secretsmanager:DeleteSecret if Hypervibe should manage secrets.',
    ],
    credentialExample: 'hv_connect provider="aws-secrets" credentialsRef="file:/absolute/path/aws-secrets.json"',
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
    tokenType: 'Cloudflare Account API Token for DNS, custom domains, and email routing; Cloudflare User API Token for Registrar/domain purchase',
    setupUrl: 'https://dash.cloudflare.com/?to=/:account/api-tokens',
    permissions: [
      'Zone -> Zone -> Read.',
      'Zone -> Zone Settings -> Read or Edit.',
      'Zone -> DNS -> Edit/Write.',
      'Zone Resources: Include -> Specific zone -> the target domain.',
    ],
    credentialExample: 'hv_connect provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}',
    notes: [
      'Recommended for ordinary DNS/custom-domain/email work: create an Account API Token from Cloudflare Dashboard -> Manage Account -> Account API Tokens: https://dash.cloudflare.com/?to=/:account/api-tokens. Account tokens usually start with cfat_ and Hypervibe also needs accountId/CLOUDFLARE_ACCOUNT_ID.',
      'For Registrar/domain purchase: create a User API Token from Cloudflare Dashboard -> My Profile -> API Tokens: https://dash.cloudflare.com/profile/api-tokens. User tokens usually start with cfut_. Cloudflare Registrar is not supported by Account API Tokens.',
      'For either token type, use Create Token, start from the Edit zone DNS template when available, then confirm Zone -> Zone -> Read, Zone -> Zone Settings -> Read or Edit, and Zone -> DNS -> Edit/Write for the target zone.',
      'Use the token secret itself as apiToken/CLOUDFLARE_API_TOKEN; do not use the token name or token id. Do not use the legacy Global API Key.',
    ],
  },
  cloudrun: {
    provider: 'cloudrun',
    displayName: 'Google Cloud Run',
    tokenType: 'Google Cloud service account JSON key',
    setupUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    permissions: [
      'roles/run.admin',
      'roles/iam.serviceAccountUser',
      'roles/cloudbuild.builds.editor',
      'roles/artifactregistry.admin',
      'roles/cloudsql.client when using Cloud SQL',
      'roles/cloudscheduler.admin when using cron jobs',
      'roles/logging.viewer and roles/logging.viewAccessor for logs',
    ],
    credentialExample: 'hv_connect provider="cloudrun" credentialsRef="file:/absolute/path/cloudrun.json"',
    notes: ['Run hv_connect action="prepare" when Hypervibe should enable APIs and grant these roles from one-time admin credentials.'],
  },
  cloudsql: {
    provider: 'cloudsql',
    displayName: 'Google Cloud SQL',
    tokenType: 'Google Cloud service account JSON key',
    setupUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    permissions: ['roles/cloudsql.admin', 'roles/cloudsql.client', 'roles/serviceusage.serviceUsageAdmin if Hypervibe should enable required APIs.'],
    credentialExample: 'hv_connect provider="cloudsql" credentialsRef="file:/absolute/path/cloudsql.json"',
  },
  database: {
    provider: 'database',
    displayName: 'External database',
    tokenType: 'database connection URL',
    permissions: ['Use a database user with the least privileges required for the intended hv_db query or migration operation.'],
    credentialExample: 'hv_connect provider="database" credentialsRef="dotenv:/absolute/path/.env#DATABASE_URL"',
  },
  doppler: {
    provider: 'doppler',
    displayName: 'Doppler',
    tokenType: 'Doppler service token',
    setupUrl: 'https://docs.doppler.com/docs/service-tokens',
    permissions: ['Create a service token scoped to the project/config Hypervibe should read.'],
    credentialExample: 'hv_connect provider="doppler" credentialsRef="env:DOPPLER_TOKEN"',
  },
  github: {
    provider: 'github',
    displayName: 'GitHub',
    tokenType: 'classic personal access token for Hypervibe GitHub API operations; optional second classic PAT for GHCR package reads',
    setupUrl: 'https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages&description=Hypervibe%20CI%20deploys',
    permissions: [
      'For CI deploy management, apiToken must have repo and workflow so Hypervibe can create/update .github/workflows files, read Actions runs/jobs/logs, trigger workflows, and manage repository secrets for private repos.',
      'For Railway GHCR image pulls, packageReadToken must have read:packages. This can be the same classic PAT only when that PAT also has repo + workflow + read:packages.',
      'If using a fine-grained PAT for apiToken, grant Contents read/write, Workflows write, Actions write, and Secrets write on the target repo; GHCR package access still requires a classic PAT because fine-grained PATs do not support Packages.',
    ],
    credentialExample: 'hv_connect provider="github" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"HYPERVIBE_GITHUB_TOKEN","packageReadToken":"HYPERVIBE_GITHUB_PACKAGES_TOKEN"}',
    notes: [
      'A read:packages-only token is not enough for CI deploy setup because it cannot write workflows or repository secrets.',
      'For the simplest setup, create one classic PAT with repo, workflow, and read:packages, then map both apiToken and packageReadToken to the same .env variable.',
      'For least privilege, use two classic PATs: HYPERVIBE_GITHUB_TOKEN with repo + workflow, and HYPERVIBE_GITHUB_PACKAGES_TOKEN with read:packages.',
    ],
  },
  local: {
    provider: 'local',
    displayName: 'Local Docker',
    tokenType: 'local Docker socket path',
    permissions: ['The local user must be able to access the Docker socket.'],
    credentialExample: 'hv_connect provider="local" credentials={"dockerSocket":"/var/run/docker.sock"}',
  },
  railway: {
    provider: 'railway',
    displayName: 'Railway',
    tokenType: 'Railway Account token or Workspace token',
    setupUrl: 'https://railway.app/account/tokens',
    permissions: ['Token must have write access to the target workspace/project so Hypervibe can create projects, services, variables, databases, and deployments.'],
    credentialExample: 'hv_connect provider="railway" credentialsRef="dotenv:/absolute/path/.env#HYPERVIBE_RAILWAY_TOKEN"',
  },
  recaptcha: {
    provider: 'recaptcha',
    displayName: 'reCAPTCHA',
    tokenType: 'Google reCAPTCHA site key and secret key',
    setupUrl: 'https://www.google.com/recaptcha/admin',
    permissions: ['Create a key for the correct reCAPTCHA version and allow the target domains.'],
    credentialExample: 'hv_connect provider="recaptcha" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"siteKey":"RECAPTCHA_SITE_KEY","secretKey":"RECAPTCHA_SECRET_KEY"}',
  },
  sendgrid: {
    provider: 'sendgrid',
    displayName: 'SendGrid',
    tokenType: 'SendGrid Restricted Access API key',
    setupUrl: 'https://app.sendgrid.com/settings/api_keys',
    permissions: [
      'mail.send.',
      'For domain authentication: whitelabel.read, whitelabel.create, whitelabel.update.',
      'For sender verification: user.email.read, user.email.create, user.email.update.',
      'For event webhook setup: user.webhooks.event.settings.read and user.webhooks.event.settings.update.',
    ],
    credentialExample: 'hv_connect provider="sendgrid" credentialsRef="dotenv:/absolute/path/.env#SENDGRID_API_KEY"',
    notes: ['Full Access is acceptable during setup; rotate to a narrower runtime key after sender/domain authorization if desired.'],
  },
  stripe: {
    provider: 'stripe',
    displayName: 'Stripe',
    tokenType: 'Stripe secret key or restricted key',
    setupUrl: 'https://dashboard.stripe.com/apikeys',
    permissions: [
      'Read account for verification.',
      'Products and Prices read/write for price sync.',
      'Customers read/delete for customer cleanup tools.',
      'Webhook Endpoints read/write/delete for webhook setup.',
    ],
    credentialExample: 'hv_connect provider="stripe" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"sandboxSecretKey":"STRIPE_SECRET_KEY"}',
  },
  supabase: {
    provider: 'supabase',
    displayName: 'Supabase',
    tokenType: 'Supabase personal access token',
    setupUrl: 'https://supabase.com/dashboard/account/tokens',
    permissions: ['Token must be able to list organizations and create/read/update projects in the target organization. Include organizationId when multiple organizations are visible.'],
    credentialExample: 'hv_connect provider="supabase" credentialsRef="dotenv:/absolute/path/.env#SUPABASE_ACCESS_TOKEN"',
  },
  tunnel: {
    provider: 'tunnel',
    displayName: 'Tunnel',
    tokenType: 'optional ngrok auth token or local cloudflared setup',
    setupUrl: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/',
    permissions: ['cloudflared quick tunnels need no API token; ngrok requires an auth token for authenticated tunnels.'],
    credentialExample: 'hv_connect provider="tunnel" credentialsRef="file:/absolute/path/tunnel.json"',
  },
  vault: {
    provider: 'vault',
    displayName: 'HashiCorp Vault',
    tokenType: 'Vault token or AppRole role_id/secret_id',
    setupUrl: 'https://developer.hashicorp.com/vault/docs',
    permissions: ['Token/AppRole policy must allow auth/token/lookup-self plus read/list on the KV paths Hypervibe should resolve. Add create/update/delete only if Hypervibe should manage secrets.'],
    credentialExample: 'hv_connect provider="vault" credentialsRef="file:/absolute/path/vault.json"',
  },
  xcode: {
    provider: 'xcode',
    displayName: 'Xcode',
    tokenType: 'local Xcode installation and Apple signing credentials in Keychain',
    permissions: ['Install Xcode command line tools and ensure the local Apple account/certificates/provisioning profiles can build/sign the app.'],
    credentialExample: 'hv_connect provider="xcode" credentials={}',
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
      return guidance.credentialExample.replace('scope="example.com"', `scope="${scope}"`);
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
    guidance.setupUrl ? `Create or review it here: ${guidance.setupUrl}.` : undefined,
    `Required permissions: ${guidance.permissions.join(' ')}`,
    guidance.notes?.length ? `Notes: ${guidance.notes.join(' ')}` : undefined,
    `Connect with: ${credentialExample(guidance, options.scope)}.`,
  ].filter(Boolean);
  return parts.join(' ');
}

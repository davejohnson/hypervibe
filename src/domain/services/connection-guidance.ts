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
  apprunner: {
    provider: 'apprunner',
    displayName: 'AWS App Runner',
    tokenType: 'AWS IAM access key for an IAM user or role',
    setupUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    permissions: [
      'App Runner service management permissions for the target account/region, such as apprunner:ListServices, apprunner:DescribeService, apprunner:CreateService, apprunner:UpdateService, and apprunner:DeleteService.',
      'iam:PassRole if App Runner service roles are used.',
    ],
    credentialExample: 'hv_connect provider="apprunner" credentialsRef="file:/absolute/path/aws-apprunner.json"',
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
    tokenType: 'Cloudflare Account API Token for durable DNS/email automation; User API Token only when Account API Tokens are unsupported',
    setupUrl: 'https://dash.cloudflare.com/?to=/:account/api-tokens',
    permissions: [
      'Zone -> Zone -> Read.',
      'Zone -> Zone Settings -> Read or Edit.',
      'Zone -> DNS -> Edit/Write.',
      'Zone Resources: Include -> Specific zone -> the target domain.',
    ],
    credentialExample: 'hv_connect provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}',
    notes: [
      'Create Account API Tokens from Manage Account -> Account API Tokens when possible; Cloudflare recommends them for credentials not associated with users.',
      'For User API Tokens, use My Profile -> API Tokens -> Create Token -> Edit zone DNS and add Zone Settings. Do not use the legacy Global API Key.',
      'Cloudflare Registrar/domain purchase is not supported by Account API Tokens; use a User API Token if Hypervibe needs to buy domains.',
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
  digitalocean: {
    provider: 'digitalocean',
    displayName: 'DigitalOcean',
    tokenType: 'DigitalOcean personal access token',
    setupUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    permissions: ['Write scope is required for App Platform and database create/update/delete operations; read-only tokens are not enough.'],
    credentialExample: 'hv_connect provider="digitalocean" credentialsRef="env:DIGITALOCEAN_ACCESS_TOKEN"',
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
    tokenType: 'classic personal access token',
    setupUrl: 'https://github.com/settings/tokens',
    permissions: [
      'repo for private repository contents, secrets, branch protection, and GitHub Pages operations.',
      'workflow to create or update GitHub Actions workflows.',
      'read:packages for package/image pull credentials; write:packages only if Hypervibe must push packages with the PAT.',
    ],
    credentialExample: 'hv_connect provider="github" credentialsRef="dotenv:/absolute/path/.env#HYPERVIBE_GITHUB_TOKEN"',
    notes: ['Fine-grained PATs may not work for every Hypervibe GitHub operation yet; classic PATs are the safest default.'],
  },
  heroku: {
    provider: 'heroku',
    displayName: 'Heroku',
    tokenType: 'Heroku API key',
    setupUrl: 'https://dashboard.heroku.com/account/applications',
    permissions: ['Use an API key for a Heroku user/team member allowed to create and manage the target apps, add-ons, config vars, builds, and domains.'],
    credentialExample: 'hv_connect provider="heroku" credentialsRef="env:HEROKU_API_KEY"',
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
  rds: {
    provider: 'rds',
    displayName: 'AWS RDS',
    tokenType: 'AWS IAM access key for an IAM user or role',
    setupUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    permissions: [
      'rds:DescribeDBInstances for verification/read.',
      'Add rds:CreateDBInstance, rds:ModifyDBInstance, rds:DeleteDBInstance, rds:AddTagsToResource, and rds:ListTagsForResource if Hypervibe should manage databases.',
    ],
    credentialExample: 'hv_connect provider="rds" credentialsRef="file:/absolute/path/aws-rds.json"',
  },
  render: {
    provider: 'render',
    displayName: 'Render',
    tokenType: 'Render API key',
    setupUrl: 'https://dashboard.render.com/u/settings#api-keys',
    permissions: ['Use an API key for a Render owner/member allowed to create and manage services, env vars, deploys, databases, and domains.'],
    credentialExample: 'hv_connect provider="render" credentialsRef="env:RENDER_API_KEY"',
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
  vercel: {
    provider: 'vercel',
    displayName: 'Vercel',
    tokenType: 'Vercel access token',
    setupUrl: 'https://vercel.com/account/tokens',
    permissions: ['Token must have access to the target personal account or team. Include teamId when deploying to a team. It must be able to create/update projects, env vars, deployments, domains, and cron configuration.'],
    credentialExample: 'hv_connect provider="vercel" credentialsRef="env:VERCEL_TOKEN"',
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

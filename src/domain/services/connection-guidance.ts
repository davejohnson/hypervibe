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
  permissions: string[];
  credentialExample: string;
  notes?: string[];
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
      'Use Admin role if Hypervibe should also register bundle IDs and enable capabilities (hv_appid_register and the ios spec section) — Certificates, Identifiers & Profiles access requires it.',
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
      'Zone -> DNS -> Edit.',
      'Zone -> Email Routing Rules -> Edit (required for hv_email_setup/hv_email_forwarding rules).',
      'Account -> Email Routing Addresses -> Edit (required to create/verify forwarding destination addresses).',
      'Account -> Account Settings -> Read (lets Hypervibe auto-resolve accountId; otherwise pass accountId explicitly).',
      'Registrar write permissions on the account (only for domain purchase via the Registrar API).',
      'Zone Resources: Include -> Specific zone -> the target domain.',
    ],
    credentialExample: 'hv_connect provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}',
    notes: [
      'Recommended for ordinary DNS/custom-domain/email work: create an Account API Token from Cloudflare Dashboard -> Manage Account -> Account API Tokens: https://dash.cloudflare.com/?to=/:account/api-tokens. New account tokens use the documented cfat_ prefix (older tokens are unprefixed and still work). Hypervibe also needs accountId/CLOUDFLARE_ACCOUNT_ID.',
      'For Registrar/domain purchase: Cloudflare lists Registrar as NOT supported by Account API Tokens; create a User API Token with Registrar write permissions from My Profile -> API Tokens: https://dash.cloudflare.com/profile/api-tokens. New user tokens use the documented cfut_ prefix. The Registrar registration API is beta: premium domains and some TLDs are unsupported, and the account needs a billing profile and default registrant contact.',
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
      'roles/run.admin',
      'roles/iam.serviceAccountUser (on the runtime service account)',
      'roles/cloudbuild.builds.editor',
      'roles/artifactregistry.admin (Hypervibe creates the Docker repository; artifactregistry.writer is enough if the repo already exists)',
      'roles/serviceusage.serviceUsageAdmin so Hypervibe can auto-enable required APIs',
      'roles/cloudsql.client when using Cloud SQL (plus roles/cloudsql.admin if Hypervibe provisions the instance)',
      'roles/cloudscheduler.admin when using cron jobs',
      'roles/pubsub.editor when using queues',
      'roles/logging.viewer and roles/logging.viewAccessor for logs',
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
      'roles/cloudsql.admin (instance and database create/delete).',
      'roles/cloudsql.client is needed by the Cloud Run runtime service account for the /cloudsql socket, not by this connection.',
      'The sqladmin.googleapis.com API must already be enabled — hv_connect provider="cloudrun" action="prepare" enables it.',
    ],
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
    tokenType: 'classic personal access token for Hypervibe GitHub API operations; optional second classic PAT for GHCR package reads',
    setupUrl: 'https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages&description=Hypervibe%20CI%20deploys',
    permissions: [
      `For CI deploy management, apiToken must have repo and workflow so Hypervibe can create/update .github/workflows files, read Actions runs/jobs/logs, trigger workflows, and manage repository secrets for private repos. Create it here: ${GITHUB_TOKEN_URLS.api}`,
      `For Railway GHCR image pulls, packageReadToken must have read:packages — create it here: ${GITHUB_TOKEN_URLS.packageRead}. This can be the same classic PAT only when that PAT also has repo + workflow + read:packages.`,
      'If using a fine-grained PAT for apiToken, grant Contents read/write, Workflows write, Actions write, and Secrets write on the target repo; add Pages write for GitHub Pages custom domains and Administration write for branch protection. GHCR package access still requires a classic PAT (GitHub: "GitHub Packages only supports authentication using a personal access token (classic)"). Hypervibe cannot pre-check fine-grained permissions (no scopes header), so missing permissions surface at apply time.',
    ],
    credentialExample: 'hv_connect provider="github" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"HYPERVIBE_GITHUB_TOKEN","packageReadToken":"HYPERVIBE_GITHUB_PACKAGES_TOKEN"}',
    notes: [
      'A read:packages-only token is not enough for CI deploy setup because it cannot write workflows or repository secrets.',
      `For the simplest setup, create one classic PAT with repo, workflow, and read:packages (${GITHUB_TOKEN_URLS.combined}), then map both apiToken and packageReadToken to the same .env variable.`,
      `For least privilege, use two classic PATs: HYPERVIBE_GITHUB_TOKEN with repo + workflow (${GITHUB_TOKEN_URLS.api}), and HYPERVIBE_GITHUB_PACKAGES_TOKEN with read:packages (${GITHUB_TOKEN_URLS.packageRead}).`,
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
      'mail.send.',
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
    tokenType: 'Stripe secret key(s): sandboxSecretKey (sk_test_...) and/or liveSecretKey (sk_live_...). Restricted keys (rk_...) are not accepted by the credential schema',
    setupUrl: 'https://dashboard.stripe.com/apikeys',
    permissions: [
      'The key must be able to read the account, read/write Products and Prices, read/write Customers, and read/write Webhook Endpoints. A standard secret key covers all of these.',
    ],
    credentialExample: 'hv_connect provider="stripe" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"sandboxSecretKey":"STRIPE_SANDBOX_SECRET_KEY","liveSecretKey":"STRIPE_LIVE_SECRET_KEY"}',
    notes: [
      'Sandbox keys come from the sandbox dashboard (https://dashboard.stripe.com/test/apikeys) and start with sk_test_; live keys start with sk_live_. Either or both can be connected; hv_stripe_sync between sandbox and live requires both.',
      'Verification uses the live key when both are configured, otherwise the sandbox key.',
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
    setupUrl: 'https://developer.hashicorp.com/vault/docs/secrets/kv/kv-v2',
    permissions: [
      'read on <mount>/data/<path> and list on <mount>/metadata/<path> for the KV v2 secrets Hypervibe should resolve.',
      'Add create/update on <mount>/data/<path> if Hypervibe should write secrets, and delete on <mount>/metadata/<path> if it should delete them (deletion removes all versions).',
      "auth/token/lookup-self is used for verification; it is included in Vault's default policy.",
    ],
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

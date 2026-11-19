export interface CredentialRole {
  issuer: string;
  sourceVariable: string;
  credentialKey?: string;
  destinationRole: 'provider-management' | 'package-read' | 'application-runtime';
  description: string;
  permissions: string[];
  creationUrl: string;
}

const roles: Record<string, CredentialRole[]> = {
  github: [
    { issuer: 'GitHub', sourceVariable: 'HYPERVIBE_GITHUB_TOKEN', credentialKey: 'apiToken', destinationRole: 'provider-management',
      description: 'GitHub API token for repository and workflow management through the Hypervibe connection', permissions: ['repo', 'workflow'],
      creationUrl: 'https://github.com/settings/tokens/new?scopes=repo,workflow' },
    { issuer: 'GitHub', sourceVariable: 'HYPERVIBE_GITHUB_PACKAGES_TOKEN', credentialKey: 'packageReadToken', destinationRole: 'package-read',
      description: 'GitHub Packages read token for private package and image pulls. GitHub issues GITHUB_TOKEN per job. A build may receive this package credential as NODE_AUTH_TOKEN',
      permissions: ['read:packages'], creationUrl: 'https://github.com/settings/tokens/new?scopes=read:packages' },
  ],
  sendgrid: [
    { issuer: 'SendGrid', sourceVariable: 'HYPERVIBE_SENDGRID_API_KEY', credentialKey: 'apiKey', destinationRole: 'provider-management',
      description: 'Manage the selected sender, domain or webhook through the Hypervibe connection. Select the permissions for that operation.',
      permissions: [], creationUrl: 'https://app.sendgrid.com/settings/api_keys' },
    { issuer: 'SendGrid', sourceVariable: 'SENDGRID_API_KEY', destinationRole: 'application-runtime',
      description: 'Send email from the declared application runtime.', permissions: ['mail.send'], creationUrl: 'https://app.sendgrid.com/settings/api_keys' },
  ],
  railway: [
    { issuer: 'Railway', sourceVariable: 'HYPERVIBE_RAILWAY_TOKEN', credentialKey: 'apiToken', destinationRole: 'provider-management',
      description: 'Manage deployments through the selected Railway workspace connection.', permissions: ['selected workspace access'],
      creationUrl: 'https://railway.com/account/tokens' },
  ],
};

export function connectionRoles(provider: string, selected?: readonly string[]): CredentialRole[] {
  return (roles[provider] ?? []).filter(role => !selected || (role.credentialKey && selected.includes(role.credentialKey)));
}

export function localConnectionRoleInputs(provider: string) {
  return connectionRoles(provider).flatMap(role => role.credentialKey ? [{
    envKey: role.sourceVariable, credentialKeys: [role.credentialKey], comment: role.description,
  }] : []);
}

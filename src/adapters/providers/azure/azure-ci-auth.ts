import type { GitHubOidcContext } from '../../../domain/ports/engine-ci.port.js';
import type { EngineCiBinding } from '../../../domain/spec/engine-ci-binding.js';
import { githubOidcToken } from '../github/github-oidc.js';
import { AZURE_SCOPES, type AzureTokenProvider } from './azure-ops.client.js';

/** Federated access only. No fallback to client secrets, local CLI or stored connections. */
export class AzureCiTokens implements AzureTokenProvider {
  private cached?: { value: string; expires: number };
  readonly redact: string[];
  constructor(private readonly binding: EngineCiBinding, private readonly context: GitHubOidcContext, readonly fetchImpl: typeof fetch = fetch) {
    this.redact = [context.requestToken];
  }
  async get(scope: string): Promise<string> {
    if (scope !== AZURE_SCOPES.arm) throw new Error('This CI release can request only Azure Resource Manager access.');
    if (this.cached && this.cached.expires > Date.now() + 5 * 60_000) return this.cached.value;
    const azure = this.binding.azure;
    if (!azure) throw new Error('Azure CI identity is missing.');
    const assertion = await githubOidcToken(this.context, 'api://AzureADTokenExchange', this.fetchImpl); this.redact.push(assertion);
    const response = await this.fetchImpl(`https://login.microsoftonline.com/${azure.tenantId}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(20_000),
      body: new URLSearchParams({ client_id: azure.clientId, scope, grant_type: 'client_credentials', client_assertion: assertion,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' }).toString(),
    });
    const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (!response.ok || typeof body.access_token !== 'string' || !body.access_token || typeof body.expires_in !== 'number' || body.expires_in <= 0) throw new Error('Azure did not issue a usable federated release token.');
    this.redact.push(body.access_token); this.cached = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}

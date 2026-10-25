import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';

export const AZURE_HOST_FEDERATION_AUDIENCE = 'api://AzureADTokenExchange';
export interface AzureFederatedAuthentication {
  tenantId: string;
  /** Customer writer UAMI client id, never the installer or runtime reader. */
  clientId: string;
  /** Must mint from the independently verified hosted Google service identity. */
  getGoogleIdToken: (audience: string, signal: AbortSignal) => Promise<string>;
}

/** No cache, refresh credential, customer secret, or ambient credential chain. */
export function createAzureFederatedTokenProvider(authentication: AzureFederatedAuthentication,
  options: { fetch?: typeof fetch; deadlineMs?: number } = {}) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(authentication.tenantId) || !uuid.test(authentication.clientId)
    || typeof authentication.getGoogleIdToken !== 'function') throw new DestinationBoundaryError('invalid_input');
  const request = options.fetch ?? fetch;
  return async (scope: string, signal: AbortSignal): Promise<string> => {
    if (!['https://management.azure.com/.default', 'https://vault.azure.net/.default'].includes(scope)) {
      throw new DestinationBoundaryError('invalid_input');
    }
    const budget = new DestinationBudget({ signal, deadlineMs: options.deadlineMs });
    try {
      const assertion = await budget.wait(authentication.getGoogleIdToken(AZURE_HOST_FEDERATION_AUDIENCE, budget.signal));
      if (typeof assertion !== 'string' || !assertion || assertion.length > 65_536 || /[\r\n]/.test(assertion)) {
        throw new DestinationBoundaryError('access_denied');
      }
      if (budget.signal.aborted) throw new DestinationBoundaryError('deadline_exceeded');
      const response = await budget.wait(request(`https://login.microsoftonline.com/${authentication.tenantId}/oauth2/v2.0/token`, {
        method: 'POST', redirect: 'error', signal: budget.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: authentication.clientId, scope, grant_type: 'client_credentials',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion }).toString(),
      }));
      if (!response.ok || response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw new DestinationBoundaryError(response.status === 400 || response.status === 401 || response.status === 403
          ? 'access_denied' : 'provider_unavailable');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new DestinationBoundaryError('invalid_response');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await budget.wait(reader.read());
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1_048_576) throw new DestinationBoundaryError('invalid_response');
          chunks.push(chunk.value);
        }
        const token: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!token || typeof token !== 'object' || Array.isArray(token)) throw new DestinationBoundaryError('invalid_response');
        const result = token as Record<string, unknown>;
        if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 65_536
          || /[\r\n]/.test(result.access_token) || typeof result.token_type !== 'string'
          || result.token_type.toLowerCase() !== 'bearer' || !Number.isSafeInteger(result.expires_in)
          || (result.expires_in as number) <= 0) throw new DestinationBoundaryError('invalid_response');
        return result.access_token;
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error instanceof DestinationBoundaryError ? error : new DestinationBoundaryError('invalid_response');
      } finally { reader.releaseLock(); }
    } catch (error) {
      throw error instanceof DestinationBoundaryError ? error : new DestinationBoundaryError('provider_unavailable');
    } finally { budget.close(); }
  };
}

import type { AzureSecretDestination, SecretDestination, SecretDestinationDriver, SecretDestinationObservation } from '../../../domain/ports/secret-destination.port.js';
import { attemptScopeTag, authorizeDestinationWrite, bounded, delivered, deliveryFailure, DestinationBoundaryError, DestinationBudget,
  destinationJson, failureCode, parseAttempt, parseDestination } from '../secret-destination-http.js';

const API_VERSION = '2025-07-01';
const ARM_VERSION = '2023-07-01';
export interface AzureSecretDestinationAuthentication {
  tenantId: string;
  subscriptionId: string;
  getAccessToken: (scope: string, signal: AbortSignal) => Promise<string>;
}
export interface AzureSecretDestinationOptions { fetch?: typeof fetch }
interface VersionMetadata { version: string; enabled: boolean; tags: Record<string, unknown> }

export function createAzureSecretDestinationDriver(authentication: AzureSecretDestinationAuthentication,
  options: AzureSecretDestinationOptions = {}): SecretDestinationDriver {
  const request = options.fetch ?? fetch;
  const scope = (input: SecretDestination): AzureSecretDestination => {
    const destination = parseDestination(input);
    if (destination.provider !== 'azure-key-vault' || destination.tenantId.toLowerCase() !== authentication.tenantId.toLowerCase()
      || destination.subscriptionId.toLowerCase() !== authentication.subscriptionId.toLowerCase()) {
      throw new DestinationBoundaryError('scope_mismatch');
    }
    return destination;
  };
  const base = (destination: AzureSecretDestination) => `https://${destination.vaultName}.vault.azure.net`;
  const secretPath = (destination: AzureSecretDestination) => `/secrets/${destination.secretName}`;
  const vaultId = (destination: AzureSecretDestination) => `/subscriptions/${destination.subscriptionId}/resourceGroups/${destination.resourceGroup}/providers/Microsoft.KeyVault/vaults/${destination.vaultName}`;
  const verifyVault = async (destination: AzureSecretDestination, budget: DestinationBudget) => {
    const token = await budget.wait(authentication.getAccessToken('https://management.azure.com/.default', budget.signal));
    const result = await destinationJson(request, budget, `https://management.azure.com${vaultId(destination)}?api-version=${ARM_VERSION}`, token);
    const properties = result.properties as Record<string, unknown> | undefined;
    if (typeof result.id !== 'string' || result.id.toLowerCase() !== vaultId(destination).toLowerCase()
      || !properties || typeof properties.tenantId !== 'string' || properties.tenantId.toLowerCase() !== destination.tenantId.toLowerCase()
      || properties.vaultUri !== `${base(destination)}/`) throw new DestinationBoundaryError('invalid_response');
  };
  const parseVersion = (destination: AzureSecretDestination, input: unknown): VersionMetadata => {
    if (!input || typeof input !== 'object') throw new DestinationBoundaryError('invalid_response');
    const item = input as Record<string, unknown>;
    if (typeof item.id !== 'string') throw new DestinationBoundaryError('invalid_response');
    let url: URL;
    try { url = new URL(item.id); } catch { throw new DestinationBoundaryError('invalid_response'); }
    const prefix = `${secretPath(destination)}/`.toLowerCase();
    if (url.origin !== base(destination) || url.username || url.password || url.search || url.hash
      || !url.pathname.toLowerCase().startsWith(prefix)) throw new DestinationBoundaryError('invalid_response');
    const version = url.pathname.slice(prefix.length);
    if (!/^[a-f0-9]{32}$/.test(version)) throw new DestinationBoundaryError('invalid_response');
    const attributes = item.attributes as Record<string, unknown> | undefined;
    if (item.tags !== undefined && (!item.tags || typeof item.tags !== 'object' || Array.isArray(item.tags))) {
      throw new DestinationBoundaryError('invalid_response');
    }
    return { version, enabled: attributes?.enabled === true, tags: (item.tags ?? {}) as Record<string, unknown> };
  };
  const versions = async (destination: AzureSecretDestination, budget: DestinationBudget, token: string): Promise<VersionMetadata[]> => {
    const path = `${secretPath(destination)}/versions`;
    let url = `${base(destination)}${path}?api-version=${API_VERSION}&maxresults=25`;
    const seenPages = new Set<string>();
    const seenVersions = new Set<string>();
    const records: VersionMetadata[] = [];
    for (let page = 0; page < 20; page++) {
      if (seenPages.has(url)) throw new DestinationBoundaryError('invalid_response');
      seenPages.add(url);
      let response: Record<string, unknown>;
      try { response = await destinationJson(request, budget, url, token); }
      catch (error) {
        // The vault was independently observed. An absent exact name is eligible
        // for its reviewed first SET; no vault or IAM resource is created here.
        if (page === 0 && error instanceof DestinationBoundaryError && error.status === 404) return [];
        throw error;
      }
      if (!Array.isArray(response.value)) throw new DestinationBoundaryError('invalid_response');
      for (const raw of response.value) {
        const version = parseVersion(destination, raw);
        if (seenVersions.has(version.version)) throw new DestinationBoundaryError('invalid_response');
        seenVersions.add(version.version); records.push(version);
      }
      if (response.nextLink === undefined || response.nextLink === null || response.nextLink === '') return records;
      if (typeof response.nextLink !== 'string' || response.nextLink.length > 8192) throw new DestinationBoundaryError('invalid_response');
      let next: URL;
      try { next = new URL(response.nextLink); } catch { throw new DestinationBoundaryError('invalid_response'); }
      if (next.origin !== base(destination) || next.pathname.toLowerCase() !== path.toLowerCase()
        || next.username || next.password || next.hash || next.searchParams.get('api-version') !== API_VERSION
        || [...next.searchParams.keys()].some(key => !['api-version', 'maxresults', '$skiptoken'].includes(key))) {
        throw new DestinationBoundaryError('invalid_response');
      }
      url = next.toString();
    }
    throw new DestinationBoundaryError('invalid_response');
  };
  return {
    async observe(input, callOptions) {
      return bounded<SecretDestinationObservation>(callOptions, async budget => {
        const destination = scope(input);
        await verifyVault(destination, budget);
        const token = await budget.wait(authentication.getAccessToken('https://vault.azure.net/.default', budget.signal));
        return { status: 'present' as const, hasVersions: (await versions(destination, budget, token)).length > 0 };
      }, error => error instanceof DestinationBoundaryError && error.status === 404 ? { status: 'absent' as const }
        : { status: 'unknown' as const, code: failureCode(error) });
    },
    async deliver(input, value, callOptions) {
      let writeStarted = false;
      return bounded(callOptions, async budget => {
        const attempt = parseAttempt(input, value);
        const destination = scope(attempt.destination);
        await verifyVault(destination, budget);
        const token = await budget.wait(authentication.getAccessToken('https://vault.azure.net/.default', budget.signal));
        if ((await versions(destination, budget, token)).length) throw new DestinationBoundaryError('destination_initialized');
        const tags = { hypervibeAttemptId: attempt.attemptId, hypervibeScope: attemptScopeTag(attempt) };
        await authorizeDestinationWrite(budget, callOptions);
        writeStarted = true;
        const result = await destinationJson(request, budget, `${base(destination)}${secretPath(destination)}?api-version=${API_VERSION}`, token,
          { method: 'PUT', body: JSON.stringify({ value, tags, attributes: { enabled: true } }) });
        const version = parseVersion(destination, result);
        if (!version.enabled || version.tags.hypervibeAttemptId !== tags.hypervibeAttemptId
          || version.tags.hypervibeScope !== tags.hypervibeScope) throw new DestinationBoundaryError('invalid_response');
        return delivered(destination, version.version);
      }, error => deliveryFailure(error, writeStarted));
    },
    async reconcile(input, callOptions) {
      return bounded(callOptions, async budget => {
        const attempt = parseAttempt(input);
        const destination = scope(attempt.destination);
        await verifyVault(destination, budget);
        const token = await budget.wait(authentication.getAccessToken('https://vault.azure.net/.default', budget.signal));
        const matches = (await versions(destination, budget, token)).filter(version => version.tags.hypervibeAttemptId === attempt.attemptId
          && version.tags.hypervibeScope === attemptScopeTag(attempt));
        if (matches.length !== 1) return { status: 'unknown' as const, code: matches.length ? 'attempt_ambiguous' as const : 'attempt_not_found' as const };
        if (!matches[0].enabled) return { status: 'unknown' as const, code: 'invalid_response' as const };
        return delivered(destination, matches[0].version);
      }, error => ({ status: 'unknown', code: failureCode(error) }));
    },
  };
}

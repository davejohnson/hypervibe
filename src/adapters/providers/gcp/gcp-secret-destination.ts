import type { GcpSecretDestination, SecretDestinationDriver, SecretDestination, SecretDestinationObservation } from '../../../domain/ports/secret-destination.port.js';
import { authorizeDestinationWrite, bounded, delivered, deliveryFailure, DestinationBoundaryError, DestinationBudget, destinationJson,
  failureCode, parseAttempt, parseDestination } from '../secret-destination-http.js';
import { assertGcpProjectIdentity } from './gcp-project-identity.js';

export interface GcpSecretDestinationAuthentication {
  projectId: string;
  projectNumber: string;
  /** A trusted host supplies explicitly selected credentials; no ambient ADC. */
  getAccessToken: (signal: AbortSignal) => Promise<string>;
}
export interface GcpSecretDestinationOptions { fetch?: typeof fetch }

export function createGcpSecretDestinationDriver(authentication: GcpSecretDestinationAuthentication,
  options: GcpSecretDestinationOptions = {}): SecretDestinationDriver {
  const request = options.fetch ?? fetch;
  const scope = (input: SecretDestination): GcpSecretDestination => {
    const destination = parseDestination(input);
    if (destination.provider !== 'gcp-secret-manager' || destination.projectId !== authentication.projectId
      || destination.projectNumber !== authentication.projectNumber) throw new DestinationBoundaryError('scope_mismatch');
    return destination;
  };
  const name = (destination: GcpSecretDestination) => `projects/${destination.projectNumber}/secrets/${destination.secretId}`;
  const inspect = async (destination: GcpSecretDestination, budget: DestinationBudget, token: string) => {
    // A service account may have access to more than its own project. Its
    // email, and a successful numeric secret lookup, do not bind the approved
    // human-readable project ID to that number. Verify the native project first.
    await assertGcpProjectIdentity({ request, budget, token, projectId: destination.projectId, projectNumber: destination.projectNumber });
    const resource = name(destination);
    const secret = await destinationJson(request, budget, `https://secretmanager.googleapis.com/v1/${resource}`, token);
    if (secret.name !== resource) throw new DestinationBoundaryError('invalid_response');
    const seen = new Set<string>();
    let pageToken: string | undefined;
    let hasVersions = false;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ pageSize: '100' });
      if (pageToken) query.set('pageToken', pageToken);
      const result = await destinationJson(request, budget, `https://secretmanager.googleapis.com/v1/${resource}/versions?${query}`, token);
      // Protobuf JSON omits empty repeated fields; {} is a valid empty list.
      if (result.versions !== undefined && !Array.isArray(result.versions)) throw new DestinationBoundaryError('invalid_response');
      for (const item of (result.versions ?? []) as unknown[]) {
        if (!item || typeof item !== 'object' || !('name' in item) || typeof item.name !== 'string'
          || !item.name.startsWith(`${resource}/versions/`) || !/^[1-9]\d*$/.test(item.name.slice(`${resource}/versions/`.length))) {
          throw new DestinationBoundaryError('invalid_response');
        }
        hasVersions = true;
      }
      if (result.nextPageToken === undefined || result.nextPageToken === '') return { hasVersions };
      if (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 4096 || seen.has(result.nextPageToken)) {
        throw new DestinationBoundaryError('invalid_response');
      }
      pageToken = result.nextPageToken; seen.add(pageToken);
    }
    throw new DestinationBoundaryError('invalid_response');
  };
  return {
    async observe(input, callOptions) {
      return bounded<SecretDestinationObservation>(callOptions, async budget => {
        const destination = scope(input);
        const token = await budget.wait(authentication.getAccessToken(budget.signal));
        return { status: 'present' as const, ...(await inspect(destination, budget, token)) };
      }, error => error instanceof DestinationBoundaryError && error.status === 404
        ? { status: 'absent' as const } : { status: 'unknown' as const, code: failureCode(error) });
    },
    async deliver(input, value, callOptions) {
      let writeStarted = false;
      return bounded(callOptions, async budget => {
        const attempt = parseAttempt(input, value);
        const destination = scope(attempt.destination);
        const token = await budget.wait(authentication.getAccessToken(budget.signal));
        if ((await inspect(destination, budget, token)).hasVersions) throw new DestinationBoundaryError('destination_initialized');
        await authorizeDestinationWrite(budget, callOptions);
        writeStarted = true;
        const result = await destinationJson(request, budget, `https://secretmanager.googleapis.com/v1/${name(destination)}:addVersion`, token,
          { method: 'POST', body: JSON.stringify({ payload: { data: Buffer.from(value, 'utf8').toString('base64') } }) });
        const prefix = `${name(destination)}/versions/`;
        if (typeof result.name !== 'string' || !result.name.startsWith(prefix) || result.state !== 'ENABLED') {
          throw new DestinationBoundaryError('invalid_response');
        }
        return delivered(destination, result.name.slice(prefix.length));
      }, error => deliveryFailure(error, writeStarted));
    },
    async reconcile(input, callOptions) {
      return bounded(callOptions, async () => {
        const attempt = parseAttempt(input); scope(attempt.destination);
        // No native operation marker exists. Metadata cannot correlate a lost receipt.
        return { status: 'unknown' as const, code: 'reconciliation_unavailable' as const };
      }, error => deliveryFailure(error, false));
    },
  };
}

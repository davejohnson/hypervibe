import { z } from 'zod';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { gcpSecretDestinationSchema, type SecretDestination } from '../../../domain/ports/secret-destination.port.js';
import { secretContainerIntentSchema, secretContainerOwnerSchema, secretContainerScopeDigest, type SecretContainerObservation,
  type SecretDestinationSetup } from '../../../domain/ports/secret-destination-lifecycle.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { bounded, DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { assertGcpProjectIdentity } from './gcp-project-identity.js';

export function createGcpSecretContainerSetup(authentication: { projectId: string; getAccessToken: () => Promise<string> },
  options: { fetch?: typeof fetch } = {}): SecretDestinationSetup {
  const request = options.fetch ?? fetch;
  function scope(environment: Parameters<SecretDestinationSetup['observe']>[0], input: SecretDestination) {
    const destination = gcpSecretDestinationSchema.parse(input);
    const hosting = parseHostingBindings(environment);
    if (destination.projectId !== authentication.projectId || hosting.provider !== 'cloudrun'
      || hosting.projectId && hosting.projectId !== authentication.projectId) throw new DestinationBoundaryError('scope_mismatch');
    return destination;
  }
  async function inspect(destination: z.infer<typeof gcpSecretDestinationSchema>, budget: DestinationBudget, token: string): Promise<SecretContainerObservation> {
    await assertGcpProjectIdentity({ request, budget, token, projectId: destination.projectId, projectNumber: destination.projectNumber });
    const resource = `projects/${destination.projectNumber}/secrets/${destination.secretId}`;
    let secret: Record<string, unknown>;
    try { secret = await destinationJson(request, budget, `https://secretmanager.googleapis.com/v1/${resource}`, token); }
    catch (error) {
      if (error instanceof DestinationBoundaryError && error.status === 404) return { state: 'absent' };
      throw error;
    }
    if (secret.name !== resource || !z.string().datetime().safeParse(secret.createTime).success) throw new DestinationBoundaryError('invalid_response');
    const labels = z.record(z.string(), z.string()).parse(secret.labels ?? {});
    let pageToken: string | undefined; const seen = new Set<string>(); let hasVersions = false;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ pageSize: '100', ...(pageToken ? { pageToken } : {}) });
      const result = await destinationJson(request, budget, `https://secretmanager.googleapis.com/v1/${resource}/versions?${query}`, token);
      if (result.versions !== undefined && !Array.isArray(result.versions)) throw new DestinationBoundaryError('invalid_response');
      for (const version of (result.versions ?? []) as any[]) {
        if (!version || typeof version.name !== 'string' || !version.name.startsWith(resource + '/versions/')
          || !/^[1-9]\d*$/.test(version.name.slice((resource + '/versions/').length))) throw new DestinationBoundaryError('invalid_response');
        hasVersions = true;
      }
      if (result.nextPageToken === undefined || result.nextPageToken === '') return {
        state: 'present', resource, createTime: secret.createTime as string, hasVersions,
        ...(labels['hv-secret-scope'] ? { scopeDigest: labels['hv-secret-scope'] } : {}),
        ...(labels['hv-secret-attempt'] ? { attemptId: labels['hv-secret-attempt'] } : {}),
      };
      if (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 4096 || seen.has(result.nextPageToken)) throw new DestinationBoundaryError('invalid_response');
      pageToken = result.nextPageToken; seen.add(pageToken);
    }
    throw new DestinationBoundaryError('invalid_response');
  }
  const unknown = (): SecretContainerObservation => ({ state: 'unknown', reason: 'Secret container state or scope could not be verified. No replacement or retry is authorized.' });
  return {
    providers: ['gcp-secret-manager'],
    discover(environment, input) {
      return bounded<Awaited<ReturnType<SecretDestinationSetup['discover']>>>(undefined, async budget => {
        const keys = z.array(secretContainerOwnerSchema.shape.key).min(1).max(100).parse(input.keys);
        const owner = secretContainerOwnerSchema.parse({ repository: input.repository, environment: input.environment, key: keys[0] });
        const hosting = parseHostingBindings(environment);
        if (hosting.provider !== 'cloudrun' || hosting.projectId && hosting.projectId !== authentication.projectId
          || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(authentication.projectId)) throw new DestinationBoundaryError('scope_mismatch');
        const token = await budget.wait(authentication.getAccessToken());
        // CRM v1 explicitly accepts the connected project ID and returns its
        // numeric identity. No search/list or token-wide scope inference.
        const project = await destinationJson(request, budget,
          `https://cloudresourcemanager.googleapis.com/v1/projects/${authentication.projectId}`, token);
        if (project.projectId !== authentication.projectId || project.lifecycleState !== 'ACTIVE'
          || typeof project.projectNumber !== 'string' || !/^[1-9]\d*$/.test(project.projectNumber)) throw new DestinationBoundaryError('scope_mismatch');
        const destinations = Object.fromEntries(keys.map(key => [key, gcpSecretDestinationSchema.parse({
          provider: 'gcp-secret-manager', projectId: authentication.projectId, projectNumber: project.projectNumber,
          secretId: resourceName(`${owner.environment}-${key}`, { scope: [owner.repository, owner.environment, key] }),
        })]));
        return { state: 'known' as const, destinations };
      }, () => ({ state: 'unknown' as const, reason: 'The connected project scope could not be verified. No destinations were proposed.' }));
    },
    observe(environment, input) {
      return bounded(undefined, async budget => {
        const destination = scope(environment, input);
        const token = await budget.wait(authentication.getAccessToken());
        return inspect(destination, budget, token);
      }, unknown);
    },
    create(environment, input, options) {
      return bounded(undefined, async budget => {
        const intent = secretContainerIntentSchema.parse(input);
        const destination = scope(environment, intent.destination);
        const token = await budget.wait(authentication.getAccessToken());
        if ((await inspect(destination, budget, token)).state !== 'absent') return unknown();
        await budget.wait(options.beforeCreate());
        const labels = { 'hv-secret-scope': secretContainerScopeDigest(intent), 'hv-secret-attempt': intent.attemptId };
        const created = await destinationJson(request, budget,
          `https://secretmanager.googleapis.com/v1/projects/${destination.projectNumber}/secrets?${new URLSearchParams({ secretId: destination.secretId })}`,
          token, { method: 'POST', body: JSON.stringify({ replication: { automatic: {} }, labels }) });
        const result = await inspect(destination, budget, token);
        if (result.state !== 'present' || result.hasVersions || result.resource !== created.name
          || result.createTime !== created.createTime || result.scopeDigest !== labels['hv-secret-scope'] || result.attemptId !== intent.attemptId) return unknown();
        return result;
      }, unknown);
    },
  };
}

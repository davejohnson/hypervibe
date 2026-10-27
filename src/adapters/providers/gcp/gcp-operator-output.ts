import { isDeepStrictEqual } from 'node:util';
import type { OperatorOutputDeliveryCapability } from '../../../domain/ports/operator-output.port.js';
import { secretContainerBindingSchema, type SecretContainerBinding } from '../../../domain/ports/secret-destination-lifecycle.port.js';
import { runtimeSecretReferenceSchema, type RuntimeSecretReference } from '../../../domain/ports/secret-destination.port.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { createGcpSecretDestinationDriver } from './gcp-secret-destination.js';
import { GcpLocalDefaultAuthentication } from './gcp-local-default-authentication.js';

export function createGcpOperatorOutputClient(input: SecretContainerBinding, authentication: { token(): Promise<string>; request: typeof fetch }) {
  const binding = secretContainerBindingSchema.parse(input), destination = binding.destination;
  if (binding.state !== 'ready' || destination.provider !== 'gcp-secret-manager') throw new DestinationBoundaryError('scope_mismatch');
  const request: typeof fetch = async (input, options) => {
    const response = await authentication.request(input, options);
    if (response.ok && response.status !== 200) { void response.body?.cancel().catch(() => {}); throw new DestinationBoundaryError('invalid_response'); }
    return response;
  };
  const driver = createGcpSecretDestinationDriver({ projectId: destination.projectId, projectNumber: destination.projectNumber,
    getAccessToken: async signal => { if (signal.aborted) throw new DestinationBoundaryError('deadline_exceeded'); return authentication.token(); } }, { fetch: request });
  return { driver, async verifyReference(input: RuntimeSecretReference, signal: AbortSignal) {
    const reference = runtimeSecretReferenceSchema.parse(input);
    if (!isDeepStrictEqual(reference.destination, destination)) throw new DestinationBoundaryError('scope_mismatch');
    const budget = new DestinationBudget({ signal, deadlineMs: 30_000 });
    try {
      // Reuse actual project-ID/number verification and bounded version inventory.
      const observed = await driver.observe(destination, { signal: budget.signal });
      if (observed.status !== 'present') throw new DestinationBoundaryError('destination_absent');
      const name = `${binding.resource}/versions/${reference.version}`;
      const result = await destinationJson(request, budget, `https://secretmanager.googleapis.com/v1/${name}`, await budget.wait(authentication.token()));
      if (result.name !== name || result.state !== 'ENABLED') throw new DestinationBoundaryError('invalid_response');
    } finally { budget.close(); }
  } };
}
export function createGcpOperatorOutputDeliveryCapability(): OperatorOutputDeliveryCapability {
  return { schemaVersion: 1, providers: ['gcp-secret-manager'], review: () => ({
    permissions: ['secretmanager.secrets.get', 'secretmanager.versions.list', 'secretmanager.versions.get', 'secretmanager.versions.add'],
    cost: 'One immutable secret version per selected operator output, plus Secret Manager storage and API operations.', pricingUrl: 'https://cloud.google.com/secret-manager/pricing',
  }), async create(binding) {
    if (binding.destination.provider !== 'gcp-secret-manager') throw new DestinationBoundaryError('scope_mismatch');
    const authentication = new GcpLocalDefaultAuthentication(binding.destination.projectId), budget = new DestinationBudget({ deadlineMs: 15_000 });
    try { await budget.wait(authentication.initialize()); } finally { budget.close(); }
    return createGcpOperatorOutputClient(binding, { token: () => authentication.token(), request: authentication.request.bind(authentication) });
  } };
}

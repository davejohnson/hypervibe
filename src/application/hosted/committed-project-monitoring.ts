import { inspectCommittedProjectSpecV1, type CommittedSpecInspectionInputV1, type CommittedSpecInspectionReceiptV1 } from './committed-spec-inspection.js';
import { HostedInspectionError, inspectCommittedBindingsV1, sameCommittedSource, type CommittedBindingsInspectionInputV1, type CommittedBindingsInspectionReceiptV1 } from './committed-bindings-inspection.js';
import { customDomainOrigin, endpointProjection, publicOrigin, type HostedPublicEndpointV1 } from './public-endpoints.js';

export interface CommittedProjectMonitoringInputV1 {
  schemaVersion: 1;
  source: CommittedSpecInspectionInputV1;
  bindings?: CommittedBindingsInspectionInputV1;
}
export interface CommittedMonitoringEndpointV1 extends HostedPublicEndpointV1 { source: 'spec' | 'binding' }
export interface CommittedProjectMonitoringReceiptV1 extends Omit<CommittedSpecInspectionReceiptV1, 'environments'> {
  bindingSource: CommittedBindingsInspectionReceiptV1['source'] | null;
  environments: Array<Omit<CommittedSpecInspectionReceiptV1['environments'][number], 'publicEndpoints'> & {
    publicEndpoints: CommittedMonitoringEndpointV1[];
    publicEndpointsTruncated?: boolean;
  }>;
}

/** Read-only monitoring targets, kept separate from desired DNS management. */
export function inspectCommittedProjectMonitoringV1(input: CommittedProjectMonitoringInputV1): CommittedProjectMonitoringReceiptV1 {
  if (!input || input.schemaVersion !== 1) throw new HostedInspectionError('INVALID_INPUT', 'Monitoring inspection requires schemaVersion 1.');
  const receipt = inspectCommittedProjectSpecV1(input.source);
  const bound = input.bindings ? inspectCommittedBindingsV1(input.bindings) : undefined;
  if (bound && (!sameCommittedSource(input.source, input.bindings!) || bound.project !== receipt.project.name)) {
    throw new HostedInspectionError('SOURCE_MISMATCH', 'Committed bindings and desired state must identify the same repository, revision and project.');
  }
  return { ...receipt, bindingSource: bound?.source ?? null, environments: receipt.environments.map(environment => {
    const targets = endpointProjection<CommittedMonitoringEndpointV1>(endpoint => `${endpoint.source}:${endpoint.kind}:${endpoint.url}`);
    const bindings = bound?.environments[environment.name];
    let truncated = false;
    for (const service of environment.services) {
      if (!service.public || service.workloadKind !== 'web') continue;
      const declared = environment.publicEndpoints.filter(endpoint => endpoint.services.includes(service.name));
      if (declared.length) {
        for (const endpoint of declared) {
          const url = publicOrigin(endpoint.url);
          if (url) targets.add({ url, services: [service.name], kind: 'custom', source: 'spec' });
        }
        continue;
      }
      if (bindings?.provider !== environment.hosting.provider) continue;
      const binding = bindings.services[service.name];
      if (!binding) continue;
      truncated ||= binding.publicEndpointsTruncated === true;
      const custom = (binding.customDomains ?? []).flatMap(domain => {
        const url = customDomainOrigin(domain);
        return url ? [url] : [];
      });
      for (const url of custom.length ? custom : binding.url ? [binding.url] : []) {
        targets.add({ url, services: [service.name], kind: custom.length ? 'custom' : 'provider', source: 'binding' });
      }
    }
    return { ...environment, ...targets.result(), ...(truncated ? { publicEndpointsTruncated: true } : {}) };
  }) };
}

import { isEngineManaged } from './infrastructure-engine-selection.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import type { TrafficEdgeTarget } from '../ports/maintenance.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { SpecStore } from '../spec/spec.store.js';
import { adapterFactory } from './adapter.factory.js';
import { bindingIdentityFingerprint } from './binding-identity.js';
import { normalizedTrafficOrigin } from './traffic-origin.js';

export interface DomainTargetObservation {
  state: 'ready' | 'unknown';
  target?: TrafficEdgeTarget;
  reason?: string;
}

type RoutedEnvironmentSpec = EnvironmentSpec & { domainTarget?: { environment: string; service: string } };

/** A web service observed in an OpenTofu-managed target, read from its cloud. */
export interface EngineWebServiceObservation {
  provider: string;
  providerProjectId: string;
  providerEnvironmentId: string;
  serviceId: string;
  resourceUid: string;
  url: string;
}

type EngineWebServiceResolver = (params: { project: Project; environment: Environment; environmentName: string; service: string }) =>
  Promise<EngineWebServiceObservation | { unknown: string }>;

let engineWebServiceResolver: EngineWebServiceResolver | undefined;

/** The engine registers its read-only lookup; the domain layer does not depend on it. */
export function registerEngineWebServiceResolver(resolver: EngineWebServiceResolver): void {
  engineWebServiceResolver = resolver;
}

/** Read-only target admission. No custom-domain, DNS, deployment or data writes. */
export async function observeDomainTarget(params: {
  project: Project;
  environment: Environment;
  environmentSpec: RoutedEnvironmentSpec;
}): Promise<DomainTargetObservation> {
  const unknown = (reason: string): DomainTargetObservation => ({ state: 'unknown', reason });
  try {
    const desired = params.environmentSpec.domainTarget;
    const hostname = params.environmentSpec.domain;
    if (!hostname || !desired || desired.environment === params.environment.name) {
      return unknown('Choose an existing web service in a different environment for this domain.');
    }
    const spec = new SpecStore().getForInspection(params.project)?.spec;
    const targetSpec: RoutedEnvironmentSpec | undefined = spec?.environments[desired.environment];
    const target = new EnvironmentRepository().findByProjectAndName(params.project.id, desired.environment);
    if (!targetSpec || !target || target.id === params.environment.id || target.projectId !== params.project.id) {
      return unknown('The selected target environment is not recorded for this project.');
    }
    const serviceSpec = targetSpec.services?.[desired.service];
    if (!serviceSpec || serviceSpec.workloadKind !== 'web' || serviceSpec.public === false
      || targetSpec.domainTarget || targetSpec.maintenance?.enabled) {
      return unknown('The target must be an available public web service without another traffic handoff or active maintenance.');
    }
    if (isEngineManaged(targetSpec)) {
      if (!engineWebServiceResolver) return unknown('The OpenTofu engine is not available to verify the target.');
      const observed = await engineWebServiceResolver({ project: params.project, environment: target, environmentName: desired.environment, service: desired.service });
      if ('unknown' in observed) return unknown(observed.unknown);
      return await admitTarget({ hostname, path: serviceSpec.healthCheckPath ?? '/', url: observed.url, fingerprint: (origin) => bindingIdentityFingerprint({
        projectId: params.project.id, environmentId: target.id, environmentName: target.name,
        provider: observed.provider, providerProjectId: observed.providerProjectId,
        providerEnvironmentId: observed.providerEnvironmentId, serviceName: desired.service, serviceId: observed.serviceId,
        resourceUid: observed.resourceUid, origin,
      }) }, unknown);
    }
    const bindings = parseHostingBindings(target);
    const sourceBindings = parseHostingBindings(params.environment);
    const serviceBinding = bindings.services?.[desired.service];
    if (!bindings.provider || bindings.provider !== targetSpec.hosting.provider
      || !bindings.projectId || !bindings.environmentId || !serviceBinding?.serviceId
      || bindings.maintenance
      || bindings.provider === sourceBindings.provider && bindings.projectId === sourceBindings.projectId
        && bindings.environmentId === sourceBindings.environmentId
        && Object.values(sourceBindings.services ?? {}).some(service => service.serviceId === serviceBinding.serviceId)) {
      return unknown('The selected target has no distinct, complete hosting identity or still has maintenance recovery state.');
    }
    const result = await adapterFactory.getProviderAdapter(bindings.provider, params.project);
    const adapter = result.adapter;
    if (!result.success || !adapter || adapter.name !== bindings.provider
      || !adapter.capabilities.supportsObserve || typeof adapter.observe !== 'function') {
      return unknown('The target hosting connection cannot verify the existing web service.');
    }
    await adapter.configureTarget?.({ region: targetSpec.hosting.region });
    const observed = await adapter.observe(target);
    if (!observed.projectExists || observed.provider !== bindings.provider
      || observed.projectId !== bindings.projectId || observed.environmentId !== bindings.environmentId
      || observed.completeness?.project !== 'complete' || observed.completeness.environment !== 'complete'
      || observed.completeness.services !== 'complete') {
      return unknown('The target provider could not verify its exact project, environment and workload inventory.');
    }
    const matches = observed.services.filter(service => service.externalId === serviceBinding.serviceId);
    const service = matches.length === 1 ? matches[0] : undefined;
    if (!service || service.name !== desired.service || service.workloadKind !== 'web'
      || service.status !== 'running' || service.config.public === false || !service.url) {
      return unknown('The exact target web service is not running with a verified public address.');
    }
    if (serviceBinding.resourceUid && service.resourceUid !== serviceBinding.resourceUid) {
      return unknown('The target service has changed or its saved identity cannot be verified. Refresh the exact target binding first.');
    }
    const origin = normalizedTrafficOrigin(hostname, service.url);
    if (serviceBinding.url && normalizedTrafficOrigin(hostname, serviceBinding.url) !== origin) {
      return unknown('The provider address differs from the saved target service address. Refresh the exact target binding first.');
    }
    const path = serviceSpec.healthCheckPath ?? '/';
    const health = new URL(path, `${origin}/`);
    if (!path.startsWith('/') || health.origin !== origin || health.username || health.password || health.hash) {
      return unknown('The target health check must stay on its verified HTTPS origin.');
    }
    const response = await fetch(health.toString(), {
      redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'Cache-Control': 'no-cache' },
    });
    await response.body?.cancel();
    if (response.status < 200 || response.status >= 400) {
      return unknown('The target HTTPS health check did not succeed; the maintenance page remains in place.');
    }
    return {
      state: 'ready',
      target: {
        origin,
        targetFingerprint: bindingIdentityFingerprint({
          projectId: params.project.id, environmentId: target.id, environmentName: target.name,
          provider: bindings.provider, providerProjectId: bindings.projectId,
          providerEnvironmentId: bindings.environmentId, providerScope: bindings.providerScope,
          serviceName: desired.service, serviceId: serviceBinding.serviceId,
          resourceUid: service.resourceUid, origin,
        }),
      },
    };
  } catch {
    return unknown('The target identity or HTTPS readiness could not be verified; the maintenance page remains in place.');
  }
}

/** Shared HTTPS admission for an engine target: same-origin health path, then a successful response. */
async function admitTarget(params: { hostname: string; path: string; url: string; fingerprint: (origin: string) => string },
  unknown: (reason: string) => DomainTargetObservation): Promise<DomainTargetObservation> {
  const origin = normalizedTrafficOrigin(params.hostname, params.url);
  const health = new URL(params.path, `${origin}/`);
  if (!params.path.startsWith('/') || health.origin !== origin || health.username || health.password || health.hash) {
    return unknown('The target health check must stay on its verified HTTPS origin.');
  }
  const response = await fetch(health.toString(), { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'Cache-Control': 'no-cache' } });
  await response.body?.cancel();
  if (response.status < 200 || response.status >= 400) {
    return unknown('The target HTTPS health check did not succeed; the maintenance page remains in place.');
  }
  return { state: 'ready', target: { origin, targetFingerprint: params.fingerprint(origin) } };
}

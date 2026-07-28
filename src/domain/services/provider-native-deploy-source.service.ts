import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { ObservedService, ObservedState } from '../ports/observe.port.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { adapterFactory } from './adapter.factory.js';

export const PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION = 'providerNativeDeploySourceDisconnect';

function blockedAction(params: {
  provider: string;
  providerDisplayName: string;
  serviceName: string;
  reason: string;
  blockedReason: string;
  verified: boolean;
  metadata?: Record<string, unknown>;
}): PlanAction {
  return {
    id: `service:${params.serviceName}:deploy-source`,
    type: 'update',
    resource: {
      kind: 'service',
      name: params.serviceName,
      provider: params.provider,
    },
    verified: params.verified,
    reason: params.reason,
    metadata: {
      operation: PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION,
      blockedReason: params.blockedReason,
      providerDisplayName: params.providerDisplayName,
      ...(params.metadata ?? {}),
    },
  };
}

function observedServiceGroups(observed: ObservedState): Map<string, ObservedService[]> {
  const groups = new Map<string, ObservedService[]>();
  for (const service of observed.services) {
    groups.set(service.name, [...(groups.get(service.name) ?? []), service]);
  }
  return groups;
}

/**
 * Reconcile the provider-native repository link independently from service
 * configuration. A CI-owned environment is safe only when the source is
 * provider-confirmed disconnected; unknown observation blocks apply.
 */
export function planProviderNativeDeploySources(params: {
  environmentSpec: EnvironmentSpec;
  observed: ObservedState | null;
  providerDisplayName: string;
  ciModeSourcePolicy?: 'disconnect' | 'block';
}): { actions: PlanAction[]; warnings: string[] } {
  const { environmentSpec, observed, providerDisplayName, ciModeSourcePolicy } = params;
  if (
    environmentSpec.deploy?.strategy !== 'branch'
    || environmentSpec.deploy.trigger !== 'ci'
    || !ciModeSourcePolicy
    || observed === null
  ) {
    return { actions: [], warnings: [] };
  }

  const provider = environmentSpec.hosting.provider;
  const servicesKnown = observed.completeness?.services !== 'unknown';
  const groups = observedServiceGroups(observed);
  const actions: PlanAction[] = [];
  const warnings: string[] = [];

  for (const serviceName of Object.keys(environmentSpec.services)) {
    const candidates = groups.get(serviceName) ?? [];
    if (candidates.length > 1) {
      actions.push(blockedAction({
        provider,
        providerDisplayName,
        serviceName,
        verified: true,
        reason: `Cannot verify CI-only deployment for "${serviceName}" because multiple live ${providerDisplayName} services match it`,
        blockedReason: 'ambiguous_provider_native_deploy_source_identity',
        metadata: {
          externalIds: candidates.map((candidate) => candidate.externalId).sort(),
        },
      }));
      continue;
    }

    const live = candidates[0];
    if (!live) {
      if (!servicesKnown) {
        actions.push(blockedAction({
          provider,
          providerDisplayName,
          serviceName,
          verified: false,
          reason: `Cannot verify whether ${providerDisplayName} has a provider-native deploy source for "${serviceName}"; CI-only deployment is not proven`,
          blockedReason: 'provider_native_deploy_source_observation_unknown',
        }));
      }
      continue;
    }

    const connected = live.sourceState === 'connected' || live.source !== undefined;
    if (!connected) {
      const sourceUnknown = live.sourceState !== 'disconnected';
      if (sourceUnknown) {
        actions.push(blockedAction({
          provider,
          providerDisplayName,
          serviceName,
          verified: false,
          reason: `Cannot verify whether ${providerDisplayName} has a provider-native deploy source for "${serviceName}"; CI-only deployment is not proven`,
          blockedReason: 'provider_native_deploy_source_observation_unknown',
          metadata: { serviceId: live.externalId },
        }));
      }
      continue;
    }

    const sourceLabel = live.source?.repo
      ? `${live.source.repo}${live.source.branch ? `@${live.source.branch}` : ''}`
      : 'a repository';
    const reason = `${providerDisplayName} service "${serviceName}" is linked to ${sourceLabel}; provider-native pushes can bypass the CI deployment workflow`;
    if (ciModeSourcePolicy === 'block') {
      actions.push(blockedAction({
        provider,
        providerDisplayName,
        serviceName,
        verified: true,
        reason,
        blockedReason: 'provider_native_deploy_source_requires_manual_disconnect',
        metadata: {
          serviceId: live.externalId,
          ...(live.source?.repo ? { sourceRepo: live.source.repo } : {}),
          ...(live.source?.branch ? { sourceBranch: live.source.branch } : {}),
        },
      }));
    } else {
      actions.push({
        id: `service:${serviceName}:deploy-source`,
        type: 'update',
        resource: { kind: 'service', name: serviceName, provider },
        verified: true,
        reason: `${reason}; disconnect it so deploy.trigger="ci" is the only push-to-deploy path`,
        diff: [{
          field: 'deploySource',
          from: sourceLabel,
          to: 'disconnected',
        }],
        metadata: {
          operation: PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION,
          serviceId: live.externalId,
          ...(live.source?.repo ? { sourceRepo: live.source.repo } : {}),
          ...(live.source?.branch ? { sourceBranch: live.source.branch } : {}),
        },
      });
    }
  }

  if (actions.length > 0) {
    warnings.push(
      `${providerDisplayName} provider-native deploy-source reconciliation is required before this environment can be considered CI-only.`
    );
  }
  return { actions, warnings };
}

export function isProviderNativeDeploySourceAction(action: PlanAction): boolean {
  return action.resource.kind === 'service'
    && action.metadata?.operation === PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION;
}

function stringMetadata(action: PlanAction, key: string): string | undefined {
  const value = action.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function applyProviderNativeDeploySourceAction(params: {
  project: Project;
  environment: Environment;
  action: PlanAction;
}): Promise<ActionResult> {
  const { project, environment, action } = params;
  const serviceId = stringMetadata(action, 'serviceId');
  if (!serviceId) {
    return {
      success: false,
      status: 'blocked',
      message: `Cannot disconnect the provider-native deploy source for ${action.resource.name}`,
      error: 'The reviewed plan action does not contain a durable provider service id.',
    };
  }

  const hosting = await adapterFactory.getHostingAdapter(project);
  if (!hosting.success || !hosting.adapter) {
    return {
      success: false,
      status: 'blocked',
      message: `Cannot disconnect the provider-native deploy source for ${action.resource.name}`,
      error: hosting.error ?? `No ${action.resource.provider} hosting adapter is available.`,
    };
  }
  if (hosting.adapter.name !== action.resource.provider) {
    return {
      success: false,
      status: 'blocked',
      message: `Cannot disconnect the provider-native deploy source for ${action.resource.name}`,
      error: `The reviewed action targets ${action.resource.provider}, but the resolved hosting adapter is ${hosting.adapter.name}.`,
    };
  }
  if (typeof hosting.adapter.disconnectDeploySource !== 'function') {
    return {
      success: false,
      status: 'blocked',
      message: `Cannot disconnect the provider-native deploy source for ${action.resource.name}`,
      error: `${action.resource.provider} does not expose deploy-source disconnection through its adapter.`,
    };
  }

  const receipt = await hosting.adapter.disconnectDeploySource({ serviceId });
  if (!receipt.success) {
    return {
      success: false,
      message: receipt.message,
      error: receipt.error ?? 'The provider did not confirm deploy-source disconnection.',
      ...(receipt.data ? { data: receipt.data } : {}),
    };
  }

  const bindings = parseHostingBindings(environment);
  const currentService = bindings.services?.[action.resource.name];
  if (currentService?.serviceId === serviceId && currentService.source) {
    const { source: _removedSource, ...serviceWithoutSource } = currentService;
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      services: {
        ...(bindings.services ?? {}),
        [action.resource.name]: serviceWithoutSource,
      },
    });
  }

  return {
    success: true,
    message: `Disconnected ${action.resource.provider} provider-native deploy source for ${action.resource.name}`,
    data: {
      ...(receipt.data ?? {}),
      serviceId,
    },
  };
}

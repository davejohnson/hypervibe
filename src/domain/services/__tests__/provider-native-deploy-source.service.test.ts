import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { Project } from '../../entities/project.entity.js';
import type { ObservedService, ObservedState } from '../../ports/observe.port.js';
import type { PlanAction } from '../../plan/plan.types.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import {
  applyProviderNativeDeploySourceAction,
  planProviderNativeDeploySources,
  PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION,
} from '../provider-native-deploy-source.service.js';

const environmentSpec = environmentSpecSchema.parse({
  hosting: { provider: 'railway' },
  services: { web: { startCommand: 'npm start' } },
  deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
});

function observedService(overrides: Partial<ObservedService> = {}): ObservedService {
  return {
    name: 'web',
    externalId: 'svc-web',
    workloadKind: 'web',
    customDomains: [],
    config: { startCommand: 'npm start' },
    envVarKeys: [],
    envVarHashes: {},
    status: 'running',
    ...overrides,
  };
}

function observed(overrides: Partial<ObservedState> = {}): ObservedState {
  return {
    provider: 'railway',
    observedAt: '2026-07-27T00:00:00.000Z',
    projectExists: true,
    projectId: 'rail-project',
    environmentId: 'rail-production',
    services: [observedService()],
    databases: [],
    completeness: {
      project: 'complete',
      services: 'complete',
      databases: 'complete',
      storage: 'complete',
    },
    partial: false,
    warnings: [],
    ...overrides,
  };
}

function plan(state: ObservedState) {
  return planProviderNativeDeploySources({
    environmentSpec,
    observed: state,
    providerDisplayName: 'Railway',
    nonNativeSourcePolicy: 'disconnect',
  });
}

describe('provider-native deploy-source planning', () => {
  it('plans an explicit disconnect when CI mode coexists with a live native source', () => {
    const result = plan(observed({
      services: [observedService({
        source: { repo: 'dave/invoice-perfect', branch: 'main' },
        sourceState: 'connected',
      })],
    }));

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'service:web:deploy-source',
        type: 'update',
        resource: { kind: 'service', name: 'web', provider: 'railway' },
        diff: [{ field: 'deploySource', from: 'dave/invoice-perfect@main', to: 'disconnected' }],
        metadata: expect.objectContaining({
          operation: PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION,
          serviceId: 'svc-web',
        }),
      }),
    ]);
    expect(result.actions[0]?.reason).toContain('bypass the managed CI deployment workflow');
  });

  it('plans no mutation when Railway confirms the native source is disconnected', () => {
    const result = plan(observed({
      services: [observedService({ sourceState: 'disconnected' })],
    }));

    expect(result.actions).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('blocks when native source observation is unknown', () => {
    const result = plan(observed({
      services: [observedService({ sourceState: 'unknown' })],
      partial: true,
    }));

    expect(result.actions[0]).toMatchObject({
      id: 'service:web:deploy-source',
      type: 'update',
      verified: false,
      metadata: {
        operation: PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION,
        blockedReason: 'provider_native_deploy_source_observation_unknown',
        serviceId: 'svc-web',
      },
    });
  });

  it('treats an omitted source observation as unknown, never as disconnected', () => {
    const result = plan(observed({
      services: [observedService()],
    }));

    expect(result.actions[0]?.metadata?.blockedReason)
      .toBe('provider_native_deploy_source_observation_unknown');
  });

  it('blocks when service observation cannot prove whether a source exists', () => {
    const result = plan(observed({
      services: [],
      completeness: {
        project: 'complete',
        services: 'unknown',
        databases: 'complete',
        storage: 'complete',
      },
      partial: true,
    }));

    expect(result.actions[0]?.metadata?.blockedReason)
      .toBe('provider_native_deploy_source_observation_unknown');
  });

  it('does not apply the CI-only source policy to an explicit native trigger', () => {
    const nativeSpec = environmentSpecSchema.parse({
      ...environmentSpec,
      deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
    });
    const result = planProviderNativeDeploySources({
      environmentSpec: nativeSpec,
      observed: observed({
        services: [observedService({
          source: { repo: 'dave/invoice-perfect', branch: 'main' },
          sourceState: 'connected',
        })],
      }),
      providerDisplayName: 'Railway',
      nonNativeSourcePolicy: 'disconnect',
    });

    expect(result.actions).toEqual([]);
  });

  it('plans an explicit disconnect for manual deployment ownership', () => {
    const manualSpec = environmentSpecSchema.parse({
      ...environmentSpec,
      deploy: { strategy: 'manual' },
    });
    const result = planProviderNativeDeploySources({
      environmentSpec: manualSpec,
      observed: observed({
        services: [observedService({
          source: { repo: 'dave/invoice-perfect', branch: 'main' },
          sourceState: 'connected',
        })],
      }),
      providerDisplayName: 'Railway',
      nonNativeSourcePolicy: 'disconnect',
    });

    expect(result.actions[0]).toMatchObject({
      id: 'service:web:deploy-source',
      type: 'update',
      metadata: {
        operation: PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION,
        serviceId: 'svc-web',
        desiredDeployMode: 'manual',
      },
    });
    expect(result.actions[0]?.reason).toContain('without explicit promotion');
  });

  it('treats omitted deploy configuration as manual ownership', () => {
    const implicitManualSpec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { web: { startCommand: 'npm start' } },
    });
    const result = planProviderNativeDeploySources({
      environmentSpec: implicitManualSpec,
      observed: observed({
        services: [observedService({
          source: { repo: 'dave/invoice-perfect', branch: 'main' },
          sourceState: 'connected',
        })],
      }),
      providerDisplayName: 'Railway',
      nonNativeSourcePolicy: 'disconnect',
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.metadata?.desiredDeployMode).toBe('manual');
  });

  it('blocks instead of mutating when provider metadata declares manual source cleanup', () => {
    const result = planProviderNativeDeploySources({
      environmentSpec,
      observed: observed({
        services: [observedService({
          source: { repo: 'dave/invoice-perfect', branch: 'main' },
          sourceState: 'connected',
        })],
      }),
      providerDisplayName: 'Example Hosting',
      nonNativeSourcePolicy: 'block',
    });

    expect(result.actions[0]).toMatchObject({
      type: 'update',
      metadata: {
        operation: PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION,
        blockedReason: 'provider_native_deploy_source_requires_manual_disconnect',
      },
    });
  });
});

describe('provider-native deploy-source apply', () => {
  const project: Project = {
    id: 'project-1',
    name: 'invoice-perfect',
    defaultPlatform: 'railway',
    policies: {},
    createdAt: new Date('2026-07-27T00:00:00.000Z'),
    updatedAt: new Date('2026-07-27T00:00:00.000Z'),
  };
  const environment: Environment = {
    id: 'environment-1',
    projectId: project.id,
    name: 'production',
    platformBindings: {
      provider: 'railway',
      projectId: 'rail-project',
      environmentId: 'rail-production',
      services: {
        web: {
          serviceId: 'svc-web',
          url: 'https://invoice-perfect.example',
          source: { repo: 'dave/invoice-perfect', branch: 'main' },
        },
      },
    },
    createdAt: new Date('2026-07-27T00:00:00.000Z'),
    updatedAt: new Date('2026-07-27T00:00:00.000Z'),
  };
  const action: PlanAction = {
    id: 'service:web:deploy-source',
    type: 'update',
    resource: { kind: 'service', name: 'web', provider: 'railway' },
    verified: true,
    reason: 'disconnect native source',
    metadata: {
      operation: PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION,
      serviceId: 'svc-web',
    },
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mutates only the reviewed service id and clears its cached source after provider success', async () => {
    const disconnectDeploySource = vi.fn(async () => ({
      success: true,
      message: 'disconnected',
      data: { serviceId: 'svc-web' },
    }));
    vi.spyOn(adapterFactory, 'getHostingAdapterByName').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        disconnectDeploySource,
      } as never,
    });
    const updateBindings = vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings')
      .mockReturnValue(null);

    const result = await applyProviderNativeDeploySourceAction({
      project,
      environment,
      action,
    });

    expect(result.success).toBe(true);
    expect(adapterFactory.getHostingAdapterByName).toHaveBeenCalledWith('railway', project);
    expect(disconnectDeploySource).toHaveBeenCalledTimes(1);
    expect(disconnectDeploySource).toHaveBeenCalledWith({ serviceId: 'svc-web' });
    expect(updateBindings).toHaveBeenCalledTimes(1);
    expect(updateBindings).toHaveBeenCalledWith(environment.id, {
      services: {
        web: {
          serviceId: 'svc-web',
          url: 'https://invoice-perfect.example',
        },
      },
    });
  });

  it('does not alter bindings when the provider fails to disconnect the source', async () => {
    vi.spyOn(adapterFactory, 'getHostingAdapterByName').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        disconnectDeploySource: vi.fn(async () => ({
          success: false,
          message: 'disconnect failed',
          error: 'Railway denied the mutation',
        })),
      } as never,
    });
    const updateBindings = vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings')
      .mockReturnValue(null);

    const result = await applyProviderNativeDeploySourceAction({
      project,
      environment,
      action,
    });

    expect(result).toMatchObject({
      success: false,
      message: 'disconnect failed',
      error: 'Railway denied the mutation',
    });
    expect(updateBindings).not.toHaveBeenCalled();
  });

  it('blocks without mutation when the hosting adapter lacks source disconnection', async () => {
    vi.spyOn(adapterFactory, 'getHostingAdapterByName').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
      } as never,
    });
    const updateBindings = vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings')
      .mockReturnValue(null);

    const result = await applyProviderNativeDeploySourceAction({
      project,
      environment,
      action,
    });

    expect(result).toMatchObject({
      success: false,
      status: 'blocked',
      error: expect.stringContaining('does not expose deploy-source disconnection'),
    });
    expect(updateBindings).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { prepareHostingBindingTransition } from '../hosting-binding-transition.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';

const oldScope = { projectId: 'old-gcp-project', region: 'us-east1' };

function current(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'cloudrun',
    projectId: 'logical-production',
    environmentId: 'us-east1',
    providerScope: oldScope,
    services: { web: { serviceId: 'old-web' } },
    runtimeRollouts: [{ service: 'web', provider: 'cloudrun' }],
    ...extra,
  };
}

describe('hosting binding scope transitions', () => {
  it.each([
    ['new region', { projectId: 'old-gcp-project', region: 'us-west1' }],
    ['new project', { projectId: 'new-gcp-project', region: 'us-east1' }],
    ['omitted returned scope', undefined],
  ])('retains exact old identities before rebinding to a %s', (_label, providerScope) => {
    const result = prepareHostingBindingTransition({
      current: current(),
      target: {
        provider: 'cloudrun',
        projectId: 'logical-production',
        ...(providerScope ? { providerBindings: { providerScope } } : {}),
      },
    });

    expect(result).toEqual({
      ok: true,
      changed: true,
      patch: expect.objectContaining({
        provider: 'cloudrun',
        projectId: 'logical-production',
        services: {},
        serviceCreateRecovery: undefined,
        runtimeRollouts: undefined,
        previousHosting: {
          provider: 'cloudrun',
          projectId: 'logical-production',
          environmentId: 'us-east1',
          providerScope: oldScope,
          services: { web: { serviceId: 'old-web' } },
        },
        ...(providerScope ? { providerScope } : { providerScope: undefined }),
      }),
    });
  });

  it('rehomes an exact service-create recovery into retained cleanup', () => {
    const recovery = {
      provider: 'cloudrun',
      operation: 'create' as const,
      resourceName: 'worker',
      providerScope: oldScope,
      state: 'identified' as const,
      serviceId: 'old-worker',
      returnedName: 'worker',
    };
    const result = prepareHostingBindingTransition({
      current: current({ serviceCreateRecovery: { worker: recovery } }),
      target: {
        provider: 'cloudrun',
        projectId: 'logical-production',
        providerBindings: { providerScope: { ...oldScope, region: 'us-west1' } },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      patch: {
        serviceCreateRecovery: undefined,
        previousHosting: {
          serviceCreateRecovery: { worker: recovery },
          services: {
            web: { serviceId: 'old-web' },
            worker: { serviceId: 'old-worker', createRecovery: recovery },
          },
        },
      },
    });
  });

  it.each([
    ['unresolved create recovery', { serviceCreateRecovery: {
      worker: {
        provider: 'cloudrun', operation: 'create', resourceName: 'worker', providerScope: oldScope,
        state: 'unresolved',
      },
    } }],
    ['active maintenance recovery', { maintenance: { state: 'active' } }],
  ])('blocks scope replacement with %s', (_label, extra) => {
    const result = prepareHostingBindingTransition({
      current: current(extra),
      target: {
        provider: 'cloudrun',
        projectId: 'logical-production',
        providerBindings: { providerScope: { ...oldScope, region: 'us-west1' } },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unresolved|maintenance/i);
  });
});

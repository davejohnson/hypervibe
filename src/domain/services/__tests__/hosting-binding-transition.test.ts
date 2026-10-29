import { describe, expect, it } from 'vitest';
import { prepareHostingBindingTransition } from '../hosting-binding-transition.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';

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
  // The application stages a provider switch before ensureProject returns:
  // old Cloud Run resources are retained, active Railway has no resource IDs.
  // The 2026-10-29 MCP regression observed this valid intermediate state reject
  // Railway's first exact IDs as though it were replacing an old Railway scope.
  const previousHosting = {
    provider: 'cloudrun', projectId: 'logical-production', environmentId: 'us-east1',
    providerScope: oldScope, services: { web: { serviceId: 'old-web' } },
  };
  const newTarget = { provider: 'railway', projectId: 'new-rail-project', environmentId: 'new-rail-environment' };

  it.each([true, false])('binds the first target namespace while retaining prior cleanup (created: %s)', created => {
    const staged = { provider: 'railway', services: {}, previousHosting };
    const before = structuredClone(staged);
    const result = prepareHostingBindingTransition({ current: staged, target: { ...newTarget, created } });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect({ ...staged, ...result.patch }).toMatchObject({ ...newTarget, services: {}, previousHosting });
    expect(result.patch.previousHosting).toBeUndefined();
    expect(staged).toEqual(before);
  });

  it('can retry a pending namespace binding and later reobserve its exact identity without replacing the stash', () => {
    const staged = { provider: 'railway', services: {}, previousHosting };
    const pending = prepareHostingBindingTransition({ current: staged, target: { provider: 'railway' } });
    expect(pending).toMatchObject({ ok: true, changed: false });
    if (!pending.ok) throw new Error(pending.error);
    expect({ ...staged, ...pending.patch }).toMatchObject({ provider: 'railway', services: {}, previousHosting });

    // Synthetic provider readback after the initial binding: repeating these
    // exact IDs must preserve both the old cleanup boundary and new services.
    const bound = { ...newTarget, previousHosting, services: { web: { serviceId: 'new-web' } } };
    const retry = prepareHostingBindingTransition({ current: bound, target: { ...newTarget, created: false } });
    expect(retry).toMatchObject({ ok: true, changed: false });
    if (!retry.ok) throw new Error(retry.error);
    expect({ ...bound, ...retry.patch }).toEqual(bound);
  });

  it.each([
    ['established namespace with a retained prior boundary', { projectId: 'prior-rail-project', environmentId: 'prior-rail-environment' }],
    ['partial prior project', { projectId: 'prior-rail-project' }],
    ['partial prior environment', { environmentId: 'prior-rail-environment' }],
    ['partial prior provider scope', { providerScope: { projectId: 'prior-rail-project' } }],
    ['unscoped service', { services: { web: { serviceId: 'uncertain-web' } } }],
    ['unresolved service creation', { serviceCreateRecovery: { web: {
      provider: 'railway', operation: 'create', resourceName: 'web', state: 'unresolved',
      providerScope: { projectId: 'prior-rail-project', environmentId: 'prior-rail-environment' },
    } } }],
    ['maintenance recovery', { maintenance: { state: 'active' } }],
    ['runtime rollout recovery', { runtimeRollouts: [{ service: 'web', provider: 'railway' }] }],
    ['malformed volume recovery', { serviceVolumes: null }],
    ['retained service volume', { serviceVolumes: { web: {
      provider: 'railway', state: 'bound', externalId: 'old-volume',
      target: { projectId: 'prior-rail-project', environmentId: 'prior-rail-environment', serviceId: 'old-web', mountPath: '/data' },
    } } }],
  ])('does not reinterpret %s as an empty initial target', (_name, retained) => {
    const staged = { provider: 'railway', services: {}, previousHosting, ...retained };
    const before = structuredClone(staged);
    const result = prepareHostingBindingTransition({ current: staged, target: { ...newTarget, created: true } });

    expect(result.ok).toBe(false);
    expect(staged).toEqual(before);
  });

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

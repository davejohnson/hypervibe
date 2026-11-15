import { describe, expect, it } from 'vitest';
import { prepareHostingBindingTransition } from '../hosting-binding-transition.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import { mergeRepoPlatformBindings } from '../../spec/repo-bindings-file.js';

describe('retain-only service volumes', () => {
  it.each([null, { state: 'invalid' }])('does not repair corrupt local recovery by overlaying a repository binding: %j', (bad) => {
    const incoming = { serviceVolumes: { web: { provider: 'railway', state: 'bound', externalId: 'disk', target: {
      projectId: 'p', environmentId: 'e', serviceId: 's', mountPath: '/data',
    } } } };
    expect(() => mergeRepoPlatformBindings({ serviceVolumes: { web: bad } }, incoming)).toThrow('Malformed');
  });
  it('preserves an unchanged environment when a project-only receipt omits its ID', () => {
    expect(prepareHostingBindingTransition({
      current: { provider: 'railway', projectId: 'p', environmentId: 'e', serviceVolumes: { web: { state: 'creating' } } },
      target: { provider: 'railway', projectId: 'p' },
    })).toMatchObject({ ok: true, changed: false });
  });
  it('rejects repository scope replacement and preserves stronger recovery evidence', () => {
    const target = { projectId: 'p', environmentId: 'e', serviceId: 's', mountPath: '/data' };
    const bound = { provider: 'railway', target, state: 'bound', externalId: 'disk' };
    const local = { serviceVolumes: { web: bound } };
    expect(mergeRepoPlatformBindings(local, { serviceVolumes: { web: { provider: 'railway', target, state: 'creating' } } })).toEqual(local);
    expect(() => mergeRepoPlatformBindings(local, { serviceVolumes: { web: { ...bound, externalId: 'other-disk' } } })).toThrow('conflicts');
    expect(() => mergeRepoPlatformBindings(local, { serviceVolumes: { web: { ...bound, target: { ...target, environmentId: 'production' } } } })).toThrow('conflicts');
  });
  it('retains unresolved create intent when a stale repository export omits it', () => {
    const marker = { web: { state: 'creating', provider: 'railway', target: {
      projectId: 'p', environmentId: 'e', serviceId: 's', mountPath: '/data',
    } } };
    expect(mergeRepoPlatformBindings({ serviceVolumes: marker }, { serviceVolumes: {} }).serviceVolumes).toEqual(marker);
  });
  it('does not abandon a data-bearing mount when rebinding the hosting scope', () => {
    const result = prepareHostingBindingTransition({
      current: {
        provider: 'railway', projectId: 'original', environmentId: 'staging', services: {},
        serviceVolumes: { web: { provider: 'railway', state: 'bound', externalId: 'disk',
          target: { projectId: 'original', environmentId: 'staging', serviceId: 'web', mountPath: '/data' } } },
      },
      target: { provider: 'railway', projectId: 'replacement', environmentId: 'new-staging' },
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('volume') });
  });
});

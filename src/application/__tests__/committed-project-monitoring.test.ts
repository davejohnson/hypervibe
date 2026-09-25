import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectCommittedProjectMonitoringV1, type CommittedSpecInspectionInputV1 } from '../../hosted.js';

function source(document: unknown): CommittedSpecInspectionInputV1 {
  const content = new TextEncoder().encode(JSON.stringify(document));
  return { schemaVersion: 1, provider: 'github', repository: {
    id: '123', path: 'acme/invoices', remoteIdentity: 'github.com/acme/invoices',
  }, revision: 'a'.repeat(40), content, contentSha256: createHash('sha256').update(content).digest('hex') };
}
function input(domain?: string) {
  return { schemaVersion: 1 as const,
    source: source({ version: 1, project: 'invoiceperfect.com', environments: {
      production: { hosting: { provider: 'railway' }, ...(domain ? { domain } : {}), email: { enabled: false },
        services: { web: { public: true, workloadKind: 'web' }, worker: { public: false, workloadKind: 'worker' } } },
      staging: { hosting: { provider: 'railway' }, services: { web: { public: true, workloadKind: 'web' } } },
    } }),
    bindings: source({ version: 1, project: 'invoiceperfect.com', environments: {
      production: { platformBindings: { provider: 'railway', projectId: 'project', environmentId: 'production', services: {
        web: { serviceId: 'prod-web', url: 'https://production.up.railway.app', customDomains: ['invoiceperfect.com'] },
        worker: { serviceId: 'worker', url: 'https://private.example.com' },
        removed: { serviceId: 'removed', url: 'https://removed.example.com' },
      }, databaseUrl: 'postgres://user:private-password@database/internal' } },
      staging: { platformBindings: { provider: 'railway', projectId: 'project', environmentId: 'staging', services: {
        web: { serviceId: 'stage-web', url: 'https://staging.up.railway.app' },
      } } },
    } }),
  };
}

describe('committed project monitoring v1', () => {
  it('projects exact per-environment public bindings without changing desired DNS or email management', () => {
    const receipt = inspectCommittedProjectMonitoringV1(input());
    expect(receipt.environments[0].publicEndpoints).toEqual([
      { url: 'https://invoiceperfect.com/', services: ['web'], kind: 'custom', source: 'binding' },
    ]);
    expect(receipt.environments[1].publicEndpoints).toEqual([
      { url: 'https://staging.up.railway.app/', services: ['web'], kind: 'provider', source: 'binding' },
    ]);
    expect(receipt.bindingSource).toMatchObject({ revision: 'a'.repeat(40), path: '.hypervibe/bindings.json' });
    expect(receipt.environments[0].features).not.toContain('custom-domain');
    expect(receipt.environments[0].features).not.toContain('email');
    expect(receipt.environments[0].declaredProviders).not.toContainEqual(expect.objectContaining({ provider: 'cloudflare' }));
    for (const value of ['private-password', 'private.example.com', 'removed.example.com']) expect(JSON.stringify(receipt)).not.toContain(value);
  });

  it('preserves explicit declared endpoints and works without binding bytes', () => {
    const request = input('www.invoiceperfect.com');
    for (const bindings of [request.bindings, undefined]) {
      const receipt = inspectCommittedProjectMonitoringV1({ ...request, bindings });
      expect(receipt.environments[0].publicEndpoints).toEqual([
        { url: 'https://www.invoiceperfect.com/', services: ['web'], kind: 'custom', source: 'spec' },
      ]);
      if (!bindings) expect(receipt.bindingSource).toBeNull();
    }
    expect(inspectCommittedProjectMonitoringV1({ ...input(), bindings: undefined }).environments[0].publicEndpoints).toEqual([]);
  });

  it.each(['revision', 'repository', 'project'])('rejects mismatched %s bindings', (field) => {
    const request = input();
    if (field === 'revision') request.bindings.revision = 'b'.repeat(40);
    if (field === 'repository') request.bindings.repository.id = 'another-repo';
    if (field === 'project') request.bindings = source({ version: 1, project: 'other', environments: {} });
    expect(() => inspectCommittedProjectMonitoringV1(request)).toThrow(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
  });

  it.each(['https://user:secret@example.com', 'https://example.com/?token=secret', 'https://example.com/#secret',
    'http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://service.internal', 'https://example.com:8443',
    'https://example.com/private-path', 'https://sk-proj-abcdefghijklmnopqrstuv.example.com'])('does not expose unsafe binding endpoint %s', (url) => {
    const request = input();
    request.bindings = source({ version: 1, project: 'invoiceperfect.com', environments: { production: {
      platformBindings: { provider: 'railway', services: { web: { serviceId: 'web', url } } },
    } } });
    const receipt = inspectCommittedProjectMonitoringV1(request);
    expect(receipt.environments[0].publicEndpoints).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain('secret');
  });

  it('bounds endpoint projection and marks truncation', () => {
    const request = input();
    request.bindings = source({ version: 1, project: 'invoiceperfect.com', environments: { production: {
      platformBindings: { provider: 'railway', services: { web: { serviceId: 'web',
        customDomains: Array.from({ length: 105 }, (_, index) => `site${index}.example.com`) } } },
    } } });
    const environment = inspectCommittedProjectMonitoringV1(request).environments[0];
    expect(environment.publicEndpoints).toHaveLength(100);
    expect(environment.publicEndpointsTruncated).toBe(true);
  });
});

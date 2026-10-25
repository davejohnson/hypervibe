import { describe, expect, it, vi } from 'vitest';
import { parseCloudDeploymentConnectionV1, parseCloudDeploymentTopologyV1 } from '../cloud-deployment-authentication.js';
import type { CloudDeploymentPreparedResourcesV1 } from '../../ports/cloud-deployment.port.js';
import { gcpBrokerTarget } from './cloud-deployment-ci.fixture.js';

// Synthetic shared contract only. Native resource lifetime / holding-image proof
// belongs to the provider boundary; a receipt is never adoption or convergence.
const image = `us-docker.pkg.dev/operator/holding/web@sha256:${'a'.repeat(64)}`;
function fixture() {
  const connection = structuredClone(gcpBrokerTarget().deploymentAccess!.connection) as any;
  connection.deployment.preparation = { kind: 'holding-workloads', image };
  connection.deployment.workloads[0].public = true;
  connection.preparedResources = { schemaVersion: 1,
    project: { id: 'projects/987654321', lifetimeId: '2026-10-24T00:00:00Z', parentId: 'organizations/123456' },
    registry: { id: 'projects/customer-project/locations/us-west2/repositories/production', lifetimeId: '2026-10-24T00:01:00Z', owner: 'b'.repeat(64) },
    workloads: [{ workload: 'web', kind: 'service', id: 'projects/customer-project/locations/us-west2/services/web', lifetimeId: 'native-uid', owner: 'b'.repeat(64),
      holding: { image, principal: { ...connection.runtimeIdentities[0].principal, serviceAccountEmail: 'holding@customer-project.iam.gserviceaccount.com', serviceAccountUniqueId: '444444444444444444444' }, configurationDigest: 'c'.repeat(64) } }],
  };
  const contract = { provider: 'gcp' as const, hostingProvider: 'cloudrun', parseScope: (value: unknown) => value as Record<string, string>,
    parsePreparedResources: vi.fn((value: unknown) => value as CloudDeploymentPreparedResourcesV1) };
  return { connection, contract };
}
describe('prepared deployment resources boundary', () => {
  it('retains reviewed public access and immutable holding topology without defaulting legacy input', () => {
    const f = fixture(); expect(parseCloudDeploymentTopologyV1(f.connection.deployment)).toEqual(f.connection.deployment);
    const legacy = gcpBrokerTarget().deploymentAccess!.connection;
    expect(parseCloudDeploymentTopologyV1(legacy.deployment)).toEqual(legacy.deployment);
  });
  it('requires native parsing and retains exact nonsecret resource lifetimes', () => {
    const f = fixture(); expect(parseCloudDeploymentConnectionV1(f.connection, f.contract)).toEqual(f.connection);
    expect(f.contract.parsePreparedResources).toHaveBeenCalledOnce();
    const { parsePreparedResources: _, ...unsupported } = f.contract;
    expect(() => parseCloudDeploymentConnectionV1(f.connection, unsupported)).toThrow();
  });
  it('retains referenced secret container lifetimes for provider-owned exact coverage checks', () => {
    const f = fixture(); f.connection.preparedResources.secretTargets = [{ id: 'projects/987654321/secrets/API_TOKEN', lifetimeId: '2026-10-24T00:01:00Z' }];
    expect(parseCloudDeploymentConnectionV1(f.connection, f.contract)).toEqual(f.connection);
    expect(f.contract.parsePreparedResources).toHaveBeenCalledWith(f.connection.preparedResources, expect.objectContaining({ deployment: f.connection.deployment }));
  });
  it('retains observed original holding revision and generation without inferring defaults', () => {
    const f = fixture(), holding = f.connection.preparedResources.workloads[0].holding;
    holding.revision = 'projects/customer-project/locations/us-west2/services/web/revisions/web-00001-hld'; holding.generation = '1';
    expect(parseCloudDeploymentConnectionV1(f.connection, f.contract)).toEqual(f.connection);
  });
  it.each(['duplicate', 'credential', 'empty-lifetime'])('rejects %s secret target metadata', mode => {
    const f = fixture(), target = { id: 'projects/987654321/secrets/API_TOKEN', lifetimeId: '2026-10-24T00:01:00Z' };
    f.connection.preparedResources.secretTargets = mode === 'duplicate' ? [target, target]
      : [{ ...target, ...(mode === 'credential' ? { value: 'must-not-store' } : { lifetimeId: '' }) }];
    expect(() => parseCloudDeploymentConnectionV1(f.connection, f.contract)).toThrow('invalid_contract');
  });
  it.each(['missing', 'extra', 'duplicate', 'credential', 'mutable-image', 'different-image', 'kind', 'runtime-principal', 'deployer-principal', 'cross-project'] as const)('rejects %s preparation evidence', mode => {
    const f = fixture(), prepared = f.connection.preparedResources, workload = prepared.workloads[0];
    if (mode === 'missing') delete f.connection.preparedResources;
    if (mode === 'extra') prepared.workloads.push({ ...workload, workload: 'undeclared' });
    if (mode === 'duplicate') prepared.workloads.push(structuredClone(workload));
    if (mode === 'credential') workload.holding.accessToken = 'must-not-persist';
    if (mode === 'mutable-image') f.connection.deployment.preparation.image = 'operator/holding:latest';
    if (mode === 'different-image') workload.holding.image = image.replace('a'.repeat(64), 'd'.repeat(64));
    if (mode === 'kind') workload.kind = 'job';
    if (mode === 'runtime-principal') workload.holding.principal = f.connection.runtimeIdentities[0].principal;
    if (mode === 'deployer-principal') workload.holding.principal = f.connection.principals.provision;
    if (mode === 'cross-project') workload.holding.principal.projectId = 'other-project';
    expect(() => parseCloudDeploymentConnectionV1(f.connection, f.contract)).toThrow();
  });
  it('rejects provider grammar failure and value-bearing parser output', () => {
    const f = fixture(); f.contract.parsePreparedResources.mockImplementation(() => { throw new Error('private native response'); });
    expect(() => parseCloudDeploymentConnectionV1(f.connection, f.contract)).toThrow('invalid_contract');
    f.contract.parsePreparedResources.mockReturnValue({ ...f.connection.preparedResources, token: 'never-output' } as any);
    expect(() => parseCloudDeploymentConnectionV1(f.connection, f.contract)).toThrow('invalid_contract');
  });
});

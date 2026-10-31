import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
export function brokerTarget(): BranchDeployTarget {
  const principal = (purpose: string, id: string) => ({ kind: 'aws-role', accountId: '123456789012', roleArn: `arn:aws:iam::123456789012:role/${purpose}`, roleId: 'AROA' + id.repeat(17), audience: `https://hypervibe.dev/deploy/${purpose}` });
  const installationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const connection = { schemaVersion: 1, purpose: 'deployment', installationId, planDigest: 'a'.repeat(64), customerId: 'customer', appId: 'app', environment: 'production',
    source: { repository: 'github.com/example/app', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) }, provider: 'aws', hostingProvider: 'ecs',
    deployment: { hostingProvider: 'ecs', region: 'us-west-2', workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [] }] }, nativeScope: { accountId: '123456789012', region: 'us-west-2' },
    hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789', serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
    principals: { provision: principal('provision', '1'), release: principal('release', '2') },
    runtimeIdentities: ['task', 'execution', 'infrastructure'].map((purpose, index) => { const { audience: _, ...native } = principal(purpose, String(index + 3)); return { workload: 'web', installationId, owner: 'b'.repeat(64), principal: { ...native, purpose } }; }),
  };
  return { environmentName: 'production', branch: 'main', kind: 'production', autoDeployOnPush: true, serviceNames: ['web'], providerServiceIds: ['arn:aws:ecs:us-west-2:123456789012:service/cluster/web'],
    providerProjectId: 'arn:aws:ecs:us-west-2:123456789012:cluster/cluster', providerRegion: 'us-west-2', deploymentAccess: { origin: 'https://hypervibe.dev', projectId: 'app', connectionId: installationId, environment: 'production', sourceBranch: 'main', connection } } as BranchDeployTarget;
}

export function gcpBrokerTarget(): BranchDeployTarget {
  const target = brokerTarget(), connection = target.deploymentAccess!.connection;
  const principal = (name: string, id: string) => ({ kind: 'gcp-service-account' as const, projectId: 'customer-project', projectNumber: '987654321',
    serviceAccountEmail: `${name}@customer-project.iam.gserviceaccount.com`, serviceAccountUniqueId: id.repeat(21) });
  connection.provider = 'gcp'; connection.hostingProvider = 'cloudrun'; connection.nativeScope = { projectId: 'customer-project', projectNumber: '987654321' };
  connection.deployment.hostingProvider = 'cloudrun'; connection.deployment.region = 'us-west2';
  connection.principals = { provision: principal('provision', '1'), release: principal('release', '2') };
  connection.runtimeIdentities = [{ workload: 'web', installationId: connection.installationId, owner: 'b'.repeat(64), principal: principal('runtime', '3') }];
  target.providerRegion = 'us-west2'; target.providerProjectId = 'customer-project'; target.providerServiceIds = ['web'];
  target.providerScope = { projectId: 'customer-project', projectNumber: '987654321', region: 'us-west2', artifactRepository: 'hypervibe-production', artifactRepositoryCreateTime: '2026-10-24T00:00:00Z' };
  target.runtimeResources = [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: 'web', providerResourceUid: 'uid-web', startCommand: 'node server.js', healthCheckPath: '/health' }];
  return target;
}

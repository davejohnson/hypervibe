import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { LocalCloudScopePreparationIntent, OperatorArtifactIntent } from '../../../../domain/ports/cloud-installation.port.js';
import { createGcpLocalHoldingDriver } from '../gcp-local-holding-preparation.js';
import { createGcpOperatorArtifactDriver } from '../gcp-operator-artifacts.js';
import { artifactImageLabels, type OperatorCommand } from '../operator-image-build.js';

// Reconstructed Google REST responses with actual client serialization. These
// synthetic native resources do not establish live provider compatibility.
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function localHoldingBoundary(appId: string, environment = 'staging', options: { lost?: 'account' | 'service' | 'public'; denied?: boolean; corrupt?: boolean;
  reject?: boolean; afterRead?: () => void; projectMembers?: string[]; billingAccountName?: string } = {}) {
  const scope = { projectId: 'operator-project', projectNumber: '123456789012', projectCreateTime: '2026-10-25T00:00:00Z', projectParent: 'none',
    billingAccountName: 'billingAccounts/000000-111111-222222',
    projectInstallationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', projectAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', region: 'us-central1',
    artifactRepository: 'hypervibe', artifactRepositoryName: 'projects/operator-project/locations/us-central1/repositories/hypervibe',
    artifactRepositoryCreateTime: '2026-10-25T01:00:00Z', artifactInstallationId: '11111111-1111-4111-8111-111111111111', artifactAttemptId: '22222222-2222-4222-8222-222222222222',
    publicArtifactRepository: 'operator-public', publicArtifactRepositoryName: 'projects/operator-project/locations/us-central1/repositories/operator-public',
    publicArtifactRepositoryCreateTime: '2026-10-25T01:00:00Z', publicArtifactInstallationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', publicArtifactAttemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
  const digest = `sha256:${'d'.repeat(64)}`, imageId = `sha256:${'a'.repeat(64)}`;
  const image = `us-central1-docker.pkg.dev/operator-project/operator-public/holding-v1@${digest}`;
  const accounts = new Map<string, any>(), services = new Map<string, any>(), policies = new Map<string, any>(), operations = new Map<string, any>();
  const requests: Array<{ method: string; url: string; body?: any }> = [], writes: Array<{ kind: string; body: any }> = [];
  let pushedTag: string | undefined, lost = false;
  const request: typeof fetch = async (input, init = {}) => {
    const raw = String(input), url = new URL(raw), pathname = decodeURIComponent(url.pathname), method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url: raw, ...(body ? { body } : {}) });
    if (options.denied) return Response.json({}, { status: 403 });
    const lostResponse = (kind: typeof options.lost) => { if (!lost && options.lost === kind) { lost = true; throw new Error('Synthetic lost native acknowledgment'); } };
    if (url.hostname === 'cloudresourcemanager.googleapis.com') {
      if (pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: body.permissions });
      if (pathname.endsWith(':getIamPolicy')) return Response.json({ etag: 'project-policy-1', version: 3, bindings: [{ role: 'roles/owner', members: ['user:operator@example.test', ...(options.projectMembers ?? [])] }] });
      if (pathname === `/v3/projects/${scope.projectId}` || pathname === `/v3/projects/${scope.projectNumber}`) return Response.json({ name: `projects/${scope.projectNumber}`,
        projectId: scope.projectId, createTime: scope.projectCreateTime, state: 'ACTIVE', labels: {
          'hv-installation': hash([appId, appId, environment, scope.projectInstallationId]).slice(0, 63), 'hv-attempt': scope.projectAttemptId } });
    }
    if (url.hostname === 'cloudbilling.googleapis.com') return Response.json({ name: `projects/${scope.projectId}/billingInfo`, projectId: scope.projectId, billingEnabled: true, billingAccountName: options.billingAccountName ?? 'billingAccounts/000000-111111-222222' });
    if (url.hostname === 'artifactregistry.googleapis.com') {
      if (pathname.endsWith(':getIamPolicy')) return Response.json({ etag: 'registry-policy-1', version: 3, bindings: [{ role: 'roles/artifactregistry.reader', members: ['allUsers'] }] });
      if (pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: ['artifactregistry.repositories.uploadArtifacts', 'artifactregistry.repositories.downloadArtifacts'] });
      if (pathname.includes('/dockerImages/')) return Response.json({ name: `${scope.publicArtifactRepositoryName}/dockerImages/holding-v1@${digest}`, uri: image,
        uploadTime: '2026-10-25T03:00:00Z', imageSizeBytes: '1234' });
      if (pathname.includes('/tags/')) return pushedTag && pathname.endsWith(`/tags/${pushedTag}`)
        ? Response.json({ name: `${scope.publicArtifactRepositoryName}/packages/holding-v1/tags/${pushedTag}`, version: `${scope.publicArtifactRepositoryName}/packages/holding-v1/versions/${digest}` }) : Response.json({}, { status: 404 });
      const isPublic = pathname === `/v1/${scope.publicArtifactRepositoryName}`;
      if (isPublic || pathname === `/v1/${scope.artifactRepositoryName}`) return Response.json({
        name: isPublic ? scope.publicArtifactRepositoryName : scope.artifactRepositoryName, createTime: scope.artifactRepositoryCreateTime,
        format: 'DOCKER', mode: 'STANDARD_REPOSITORY', description: `hypervibe:operator-registry:${hash([appId, appId, environment, isPublic ? scope.publicArtifactInstallationId : scope.artifactInstallationId])}:${isPublic ? scope.publicArtifactAttemptId : scope.artifactAttemptId}` });
    }
    if (url.hostname === 'iam.googleapis.com') {
      if (method === 'POST' && pathname === `/v1/projects/${scope.projectId}/serviceAccounts`) {
        if (options.reject) return Response.json({}, { status: 403 });
        const email = `${body.accountId}@${scope.projectId}.iam.gserviceaccount.com`, name = `projects/${scope.projectId}/serviceAccounts/${email}`;
        if (accounts.has(name)) return Response.json({}, { status: 409 });
        const account = { name, email, projectId: scope.projectId, uniqueId: String(100000000000000000000n + BigInt(accounts.size + 1)), ...body.serviceAccount };
        accounts.set(name, account); writes.push({ kind: 'account', body }); lostResponse('account'); return Response.json(account);
      }
      if (method === 'GET') { options.afterRead?.(); return accounts.has(pathname.slice(4)) ? Response.json(accounts.get(pathname.slice(4))) : Response.json({}, { status: 404 }); }
    }
    if (url.hostname === 'run.googleapis.com') {
      const name = pathname.slice(4);
      if (method === 'POST' && pathname.endsWith('/services')) {
        const full = `${name}/${url.searchParams.get('serviceId')}`;
        if (services.has(full)) return Response.json({}, { status: 409 });
        const service = { ...body, name: full, uid: randomUUID(), generation: '1', observedGeneration: '1', etag: 'service-etag-1',
          reconciling: false, terminalCondition: { state: 'CONDITION_SUCCEEDED' }, latestCreatedRevision: `${full}/revisions/first`, latestReadyRevision: `${full}/revisions/first`,
          uri: `https://${url.searchParams.get('serviceId')}-synthetic.run.app` };
        services.set(full, service); const operationName = `projects/${scope.projectId}/locations/${scope.region}/operations/${randomUUID()}`;
        operations.set(operationName, { name: operationName, done: true, response: { '@type': 'type.googleapis.com/google.cloud.run.v2.Service', ...service } });
        writes.push({ kind: 'service', body }); lostResponse('service'); return Response.json({ name: operationName, done: false });
      }
      if (name.includes('/operations/')) return operations.has(name) ? Response.json(operations.get(name)) : Response.json({}, { status: 404 });
      if (name.endsWith(':getIamPolicy')) return Response.json(policies.get(name.replace(':getIamPolicy', '')) ?? { etag: 'service-policy-1', version: 3, bindings: [] });
      if (name.endsWith(':setIamPolicy')) {
        const target = name.replace(':setIamPolicy', ''); policies.set(target, body.policy); writes.push({ kind: 'public', body }); lostResponse('public'); return Response.json(body.policy);
      }
      if (method === 'GET' && services.has(name)) return Response.json({ ...services.get(name), ...(options.corrupt ? { uid: randomUUID() } : {}) });
      if (method === 'GET') return Response.json({}, { status: 404 });
    }
    throw new Error(`Unexpected synthetic holding endpoint ${method} ${url.origin}${pathname}`);
  };
  const artifactScope = { scopeKind: 'gar-image-publication-v1', ...Object.fromEntries(Object.entries(scope).filter(([key]) => !key.startsWith('artifact'))),
    packageVersion: '0.1.44', packageLockSha256: 'e'.repeat(64), packageArchiveSha256: 'f'.repeat(64), holdingImageId: imageId };
  const publicationIntent: OperatorArtifactIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: appId, appId, environment,
    source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'c'.repeat(64) }, provider: 'gcp', artifactProvider: 'cloudrun',
    execution: { kind: 'operator-artifact-publisher', authentication: 'google-user-adc' }, mode: 'connect', stage: 'scope-preparation', keys: [], artifacts: ['holding-v1'], nativeScope: artifactScope };
  const command: OperatorCommand = async (_program, args, commandOptions = {}) => {
    if (args[0] === 'login' || args[0] === 'tag' || args[0] === 'pull') return '';
    if (args[0] === 'push') { pushedTag = args[1].split(':').at(-1); return ''; }
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (commandOptions.env?.DOCKER_CONFIG) JSON.parse(readFileSync(commandOptions.env.DOCKER_CONFIG + '/config.json', 'utf8'));
      return JSON.stringify([{ Id: imageId, Os: 'linux', Architecture: 'amd64', Config: { User: 'node', Labels: artifactImageLabels(artifactScope, 'holding-v1') } }]);
    }
    throw new Error('Unexpected synthetic publication command');
  };
  const authentication = { kind: 'local-administrator' as const, administrator: { getAccessToken: async () => 'synthetic-local-holding-token' } };
  const driver = createGcpLocalHoldingDriver({ fetch: request });
  const nativeScope = { scopeKind: 'holding-v1', ...Object.fromEntries(Object.entries(scope).filter(([key]) => !key.startsWith('public'))),
    holdingImage: image, holdingPackageArchiveSha256: artifactScope.packageArchiveSha256, holdingPackageLockSha256: artifactScope.packageLockSha256,
    holdingRepository: scope.publicArtifactRepositoryName, holdingRepositoryCreateTime: scope.publicArtifactRepositoryCreateTime,
    holdingRepositoryInstallationId: scope.publicArtifactInstallationId, holdingRepositoryAttemptId: scope.publicArtifactAttemptId,
    topology: JSON.stringify([{ name: 'web', kind: 'web', public: true }, { name: 'worker', kind: 'worker', public: false }]) };
  const intent: LocalCloudScopePreparationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: appId, appId, environment,
    source: publicationIntent.source, provider: 'gcp', hostingProvider: 'cloudrun', execution: { kind: 'local-administrator', authentication: 'google-user-adc' },
    mode: 'connect', stage: 'scope-preparation', keys: [], nativeScope };
  return { scope, image, requests, writes, accounts, services, policies, operations, options, request, driver, authentication, intent, publicationIntent,
    publicationDriver: createGcpOperatorArtifactDriver({ fetch: request, command }) };
}

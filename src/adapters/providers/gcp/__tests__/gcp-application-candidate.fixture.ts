import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { createGcpOperatorArtifactDriver } from '../gcp-operator-artifacts.js';
import { type OperatorCommand } from '../operator-image-build.js';
import type { CloudInstallationRecord, OperatorArtifactIntent } from '../../../../domain/ports/cloud-installation.port.js';

// Reconstructed official GAR tags.get/dockerImages.get JSON and Docker CLI
// boundaries. Synthetic credentials and content IDs; not a live compatibility claim.
const digest = 'sha256:' + 'd'.repeat(64), imageId = 'sha256:' + 'a'.repeat(64);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function candidateBoundary(options: { lostAck?: boolean; replaced?: boolean; denied?: boolean; wrongImage?: boolean; wrongPulledImage?: boolean; publicRemoved?: boolean; absentAfterPush?: boolean; billingChanged?: boolean; billingDisabled?: boolean } = {}) {
  const intent: OperatorArtifactIntent = { schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'customer', appId: 'app', environment: 'staging',
    source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'c'.repeat(64) },
    provider: 'gcp', artifactProvider: 'cloudrun', execution: { kind: 'operator-artifact-publisher', authentication: 'google-user-adc' },
    mode: 'connect', stage: 'scope-preparation', keys: [], artifacts: ['application-candidate-v1'], nativeScope: {
      scopeKind: 'gar-private-candidate-publication-v1', projectId: 'operator-project', projectNumber: '123456789012', projectCreateTime: '2026-10-25T00:00:00Z', projectParent: 'none',
      projectInstallationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', projectAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', billingAccountName:'billingAccounts/000000-000000-000000',
      region: 'us-central1', artifactRepository: 'hypervibe', artifactRepositoryName: 'projects/operator-project/locations/us-central1/repositories/hypervibe',
      artifactRepositoryCreateTime: '2026-10-25T01:00:00Z', artifactInstallationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', artifactAttemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      candidateBuildId:'ffffffff-ffff-4fff-8fff-ffffffffffff',builderCleanup:'verified',sourceDirectory: '/synthetic/committed-app', sourceCommit: '1'.repeat(40), sourceRepository: 'github.com/acme/operator', imageName: 'candidate', packageReadAuthentication: 'github-package-read', sourceManifestSha256: 'e'.repeat(64), dockerfileSha256: 'f'.repeat(64), dependencyLockSha256: 'c'.repeat(64), candidateImageId: imageId, credentialScan: 'verified',
    } };
  const scope = intent.nativeScope, repository = scope.artifactRepositoryName;
  let pulled=false;
  let saved: CloudInstallationRecord<OperatorArtifactIntent> | null = null, pushedTag: string | undefined;
  const commands: Array<{ args: string[]; authenticated: boolean }> = [], requests: string[] = [], writes: string[] = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = String(input); requests.push(url);
    expect(init.method??'GET').toBe(url.includes(':testIamPermissions')||url.includes('cloudresourcemanager.googleapis.com')&&url.includes(':getIamPolicy')?'POST':'GET'); expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-short-lived-token');
    if (options.denied) return Response.json({}, { status: 403 });
    if (url === `https://cloudbilling.googleapis.com/v1/projects/${scope.projectId}/billingInfo`) return Response.json({name:`projects/${scope.projectId}/billingInfo`,projectId:scope.projectId,
      billingEnabled:!options.billingDisabled,billingAccountName:options.billingChanged?'billingAccounts/999999-999999-999999':'billingAccounts/000000-000000-000000'});
    if (url.includes('cloudresourcemanager.googleapis.com') && !url.includes(':getIamPolicy')) return Response.json({ name: `projects/${scope.projectNumber}`, projectId: scope.projectId,
      createTime: scope.projectCreateTime, state: 'ACTIVE', labels: { 'hv-installation': hash([intent.customerId,intent.appId,intent.environment,scope.projectInstallationId]).slice(0,63), 'hv-attempt': scope.projectAttemptId } });
    if (url === `https://artifactregistry.googleapis.com/v1/${repository}`) return Response.json({ name: repository, format: 'DOCKER', mode: 'STANDARD_REPOSITORY',
      createTime: options.replaced ? '2026-10-25T02:00:00Z' : scope.artifactRepositoryCreateTime,
      description: `hypervibe:operator-registry:${hash([intent.customerId,intent.appId,intent.environment,scope.artifactInstallationId])}:${scope.artifactAttemptId}` });
    if (url.includes(':getIamPolicy')) return Response.json({ etag: 'policy-v1', version: 3, bindings: options.publicRemoved ? [{ role: 'roles/artifactregistry.reader', members: ['allUsers'] }] : [{ role: 'roles/artifactregistry.reader', members: ['serviceAccount:retained@example.test'] }] });
    if (url.includes(':testIamPermissions')) return Response.json({ permissions: ['artifactregistry.repositories.uploadArtifacts', 'artifactregistry.repositories.downloadArtifacts'] });
    if (url.includes('/tags/')) return pushedTag && !options.absentAfterPush && url.endsWith('/tags/' + pushedTag)
      ? Response.json({ name: `${repository}/packages/candidate/tags/${pushedTag}`, version: `${repository}/packages/candidate/versions/${digest}` }) : Response.json({}, { status: 404 });
    if (url.includes('/dockerImages/')) return Response.json({ name: `${repository}/dockerImages/candidate@${digest}`,
      uri: `us-central1-docker.pkg.dev/operator-project/hypervibe/candidate@${digest}`, uploadTime: '2026-10-25T03:00:00Z', imageSizeBytes: '1234' });
    throw new Error('Unexpected GAR native request');
  };
  const command: OperatorCommand = async (program, args, commandOptions = {}) => {
    expect(program).toBe('docker');
    const config = commandOptions.env?.DOCKER_CONFIG;
    const authenticated = config ? Object.keys(JSON.parse(readFileSync(config + '/config.json','utf8')).auths).length > 0 : false;
    commands.push({ args, authenticated });
    if (args[0] === 'login') {
      expect(commandOptions.input).toBe('synthetic-short-lived-token');
      expect(args).not.toContain('synthetic-short-lived-token');
      const { writeFileSync } = await import('node:fs'); writeFileSync(config + '/config.json', JSON.stringify({auths:{registry:{auth:'synthetic'}}}));
      return 'Login Succeeded';
    }
    if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{ Id: options.wrongImage || options.wrongPulledImage&&pulled ? 'sha256:' + 'b'.repeat(64) : imageId,
      Os: 'linux', Architecture: 'amd64', Size: 1024, Config: { User: 'node', Labels: { 'dev.hypervibe.candidate-build':scope.candidateBuildId,'org.opencontainers.image.source': scope.sourceRepository, 'org.opencontainers.image.revision': scope.sourceCommit, 'dev.hypervibe.source-manifest': scope.sourceManifestSha256, 'dev.hypervibe.dockerfile': scope.dockerfileSha256, 'dev.hypervibe.dependency-lock': scope.dependencyLockSha256 } } }]);
    if (args[0] === 'tag') { expect(args[1]).toBe(imageId); return ''; }
    if (args[0] === 'push') {
      writes.push(args[1]); pushedTag = args[1].split(':').at(-1);
      if (options.lostAck) throw new Error('lost push acknowledgment synthetic-short-lived-token');
      return 'pushed';
    }
    if (args[0] === 'pull') { pulled=true;expect(authenticated).toBe(true); expect(commandOptions.env?.DOCKER_AUTH_CONFIG).toBeUndefined(); expect(args.at(-1)).toContain('@' + digest); return 'pulled'; }
    throw new Error('Unexpected Docker operation');
  };
  const driver = createGcpOperatorArtifactDriver({ fetch: request, command });
  const context = { driver, authentication: { kind: 'operator-artifact-publisher' as const, administrator: { getAccessToken: async () => 'synthetic-short-lived-token' } }, authorize: async () => true,
    store: { read: async () => structuredClone(saved), compareAndSwap: async (_id: string, revision: number | null, next: CloudInstallationRecord<OperatorArtifactIntent>) => {
      if (revision !== (saved?.revision ?? null)) return false;
      for (const prior of saved?.attempts ?? []) if (prior.evidence) {
        const nextEvidence = next.attempts.find(value => value.id === prior.id)?.evidence; expect(nextEvidence).toBeDefined();
        for (const [key,value] of Object.entries(prior.evidence.native)) expect(nextEvidence!.native[key]).toEqual(value);
        prior.evidence.resources.forEach((value,index) => expect(nextEvidence!.resources[index]).toEqual(value));
      }
      saved = structuredClone(next); return true;
    } } };
  return { intent, context, writes, commands, requests, options };
}

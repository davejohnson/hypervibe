import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGcpOperatorArtifactCapability, createGcpOperatorArtifactDriver } from '../gcp-operator-artifacts.js';
import { artifactImageLabels, type OperatorCommand } from '../operator-image-build.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1 } from '../../../../domain/services/cloud-installation-runtime.js';
import type { CloudInstallationRecord, OperatorArtifactIntent } from '../../../../domain/ports/cloud-installation.port.js';

// Reconstructed official GAR tags.get/dockerImages.get JSON and Docker CLI
// boundaries. Synthetic credentials and content IDs; not a live compatibility claim.
const digest = 'sha256:' + 'd'.repeat(64), imageId = 'sha256:' + 'a'.repeat(64);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(options: { lostAck?: boolean; replaced?: boolean; denied?: boolean; wrongImage?: boolean; publicRemoved?: boolean; absentAfterPush?: boolean; billingChanged?: boolean; billingDisabled?: boolean } = {}) {
  const intent: OperatorArtifactIntent = { schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'customer', appId: 'app', environment: 'staging',
    source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'c'.repeat(64) },
    provider: 'gcp', artifactProvider: 'cloudrun', execution: { kind: 'operator-artifact-publisher', authentication: 'google-user-adc' },
    mode: 'connect', stage: 'scope-preparation', keys: [], artifacts: ['holding-v1'], nativeScope: {
      scopeKind: 'gar-image-publication-v1', projectId: 'operator-project', projectNumber: '123456789012', projectCreateTime: '2026-10-25T00:00:00Z', projectParent: 'none',
      projectInstallationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', projectAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', billingAccountName:'billingAccounts/000000-000000-000000',
      region: 'us-central1', publicArtifactRepository: 'operator-public', publicArtifactRepositoryName: 'projects/operator-project/locations/us-central1/repositories/operator-public',
      publicArtifactRepositoryCreateTime: '2026-10-25T01:00:00Z', publicArtifactInstallationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', publicArtifactAttemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      packageVersion: '0.1.44', packageLockSha256: 'e'.repeat(64), packageArchiveSha256: 'f'.repeat(64), holdingImageId: imageId,
    } };
  const scope = intent.nativeScope, repository = scope.publicArtifactRepositoryName;
  let saved: CloudInstallationRecord<OperatorArtifactIntent> | null = null, pushedTag: string | undefined;
  const commands: Array<{ args: string[]; authenticated: boolean }> = [], requests: string[] = [], writes: string[] = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = String(input); requests.push(url); expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-short-lived-token');
    if (options.denied) return Response.json({}, { status: 403 });
    if (url === `https://cloudbilling.googleapis.com/v1/projects/${scope.projectId}/billingInfo`) return Response.json({name:`projects/${scope.projectId}/billingInfo`,projectId:scope.projectId,
      billingEnabled:!options.billingDisabled,billingAccountName:options.billingChanged?'billingAccounts/999999-999999-999999':'billingAccounts/000000-000000-000000'});
    if (url.includes('cloudresourcemanager.googleapis.com')) return Response.json({ name: `projects/${scope.projectNumber}`, projectId: scope.projectId,
      createTime: scope.projectCreateTime, state: 'ACTIVE', labels: { 'hv-installation': hash([intent.customerId,intent.appId,intent.environment,scope.projectInstallationId]).slice(0,63), 'hv-attempt': scope.projectAttemptId } });
    if (url === `https://artifactregistry.googleapis.com/v1/${repository}`) return Response.json({ name: repository, format: 'DOCKER', mode: 'STANDARD_REPOSITORY',
      createTime: options.replaced ? '2026-10-25T02:00:00Z' : scope.publicArtifactRepositoryCreateTime,
      description: `hypervibe:operator-registry:${hash([intent.customerId,intent.appId,intent.environment,scope.publicArtifactInstallationId])}:${scope.publicArtifactAttemptId}` });
    if (url.includes(':getIamPolicy')) return Response.json({ etag: 'policy-v1', version: 3, bindings: options.publicRemoved ? [] : [{ role: 'roles/artifactregistry.reader', members: ['allUsers'] }] });
    if (url.includes(':testIamPermissions')) return Response.json({ permissions: ['artifactregistry.repositories.uploadArtifacts', 'artifactregistry.repositories.downloadArtifacts'] });
    if (url.includes('/tags/')) return pushedTag && !options.absentAfterPush && url.endsWith('/tags/' + pushedTag)
      ? Response.json({ name: `${repository}/packages/holding-v1/tags/${pushedTag}`, version: `${repository}/packages/holding-v1/versions/${digest}` }) : Response.json({}, { status: 404 });
    if (url.includes('/dockerImages/')) return Response.json({ name: `${repository}/dockerImages/holding-v1@${digest}`,
      uri: `us-central1-docker.pkg.dev/operator-project/operator-public/holding-v1@${digest}`, uploadTime: '2026-10-25T03:00:00Z', imageSizeBytes: '1234' });
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
      return 'Login Succeeded';
    }
    if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{ Id: options.wrongImage ? 'sha256:' + 'b'.repeat(64) : imageId,
      Os: 'linux', Architecture: 'amd64', Config: { User: 'node', Labels: artifactImageLabels(scope,'holding-v1') } }]);
    if (args[0] === 'tag') { expect(args[1]).toBe(imageId); return ''; }
    if (args[0] === 'push') {
      writes.push(args[1]); pushedTag = args[1].split(':').at(-1);
      if (options.lostAck) throw new Error('lost push acknowledgment synthetic-short-lived-token');
      return 'pushed';
    }
    if (args[0] === 'pull') { expect(authenticated).toBe(false); expect(commandOptions.env?.DOCKER_AUTH_CONFIG).toBeUndefined(); expect(args.at(-1)).toContain('@' + digest); return 'pulled'; }
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
describe('GAR operator immutable image publication', () => {
  it.each([false,true])('recovers a lost push acknowledgment=%s by immutable readback, without another push', async lostAck => {
    const f = fixture({ lostAck }); let record = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    expect(record.plan.actions).toHaveLength(1); expect(f.writes).toEqual([]);
    record = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [record.plan.actions[0].id] });
    record = await reconcileCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest });
    expect(record.status, JSON.stringify(record)).toBe('scope-ready'); expect(f.writes).toHaveLength(1);
    expect(JSON.stringify(record)).toContain(digest); expect(JSON.stringify(record)).not.toContain('synthetic-short-lived-token');
    expect(f.commands.filter(value => value.args[0] === 'pull').length).toBeGreaterThan(0);
  });
  it.each(['replaced','denied','publicRemoved','wrongImage','billingChanged','billingDisabled'] as const)('rejects %s before publication', async variant => {
    const f = fixture(); let record = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    f.options[variant] = true;
    record = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: record.plan.actions.map(action => action.id) });
    expect(record.status).not.toBe('scope-ready'); expect(f.writes).toEqual([]);
  });
  it('retains an uncertain absent publication without blind replay', async () => {
    const f = fixture({ lostAck: true, absentAfterPush: true }); let record = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    record = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: record.plan.actions.map(action => action.id) });
    for (let i = 0; i < 2; i++) record = await reconcileCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest });
    expect(record.status).not.toBe('scope-ready'); expect(f.writes).toHaveLength(1);
  });

  it('preserves immutable legacy publication receipts without granting another push',async()=>{
    const f=fixture();let record=await planCloudInstallationV1({...f.context,intent:f.intent});
    record=await applyCloudInstallationV1({...f.context,installationId:record.installationId,planDigest:record.plan.digest,confirmActions:record.plan.actions.map(a=>a.id)});
    expect(record.status).toBe('scope-ready');
    const capability=createGcpOperatorArtifactCapability(),receipts=capability.receipts(record);
    // Historical publication schema omitted approved billing. Receipt identity
    // remains immutable; it cannot authorize a new plan or direct mutation.
    delete record.intent.nativeScope.billingAccountName;
    expect(f.context.driver.parseScope(record.intent.nativeScope)).toEqual(record.intent.nativeScope);
    expect(capability.receipts(record)).toEqual(receipts);
    const requests=f.requests.length;
    const result=await f.context.driver.mutate({intent:record.intent,action:record.plan.actions[0],completed:{},
      authentication:f.context.authentication,signal:AbortSignal.timeout(1000),beforeMutation:async()=>{},
      attempt:{id:'ffffffff-ffff-4fff-8fff-ffffffffffff',actionId:record.plan.actions[0].id,status:'attempted',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}});
    expect(result).toMatchObject({state:'rejected',reason:'authorization_revoked'});
    expect(f.requests).toHaveLength(requests);expect(f.writes).toHaveLength(1);
  });
});

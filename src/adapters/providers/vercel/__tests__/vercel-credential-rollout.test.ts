import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { buildVercelGitHubActionsSteps } from '../vercel-ci.workflow.js';
import { buildVercelPortableRuntime } from '../vercel-ci.recipe.js';
import { extractGitHubScript } from '../../../../domain/services/__tests__/managed-ci-workflow.test-utils.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const projectId = 'prj_1234567890', scope = 'team:team_1234567890', serviceId = `${scope}:${projectId}`;
const sha = 'a'.repeat(40), repository = 'acme/app';
// Reconstructed wire observations use the official deployment list pagination,
// metadata and forceNew creation contracts. These are executed native programs,
// not live Vercel observations or a second implementation of the lifecycle.
// Terminal ERROR/CANCELED semantics: official @vercel/sdk cancelDeployment contract,
// https://github.com/vercel/sdk/blob/main/docs/sdks/deployments/README.md#canceldeployment
function fixture(kind: 'github' | 'portable', fault?: 'lost-http' | 'lost-network') {
  const deployments: any[] = [{ id: 'old-deployment', uid: 'old-deployment', projectId, target: 'production', meta: { hypervibeGitSha: sha, hypervibeRepository: repository }, readyState: 'READY', createdAt: 1, url: 'old.example.test' }];
  const mutations: any[] = [], reads: string[] = [];
  let lost = false, paginate = false, corruptReadback = false;
  const listedStates = new Map<string, string>();
  const env = { VERCEL_ACCESS_TOKEN: 'private-token', VERCEL_SCOPE_BINDING: scope, VERCEL_PROJECT_IDS_JSON: JSON.stringify([projectId]), DEPLOY_SHA: sha,
    GITHUB_REPOSITORY: repository, GITHUB_WORKSPACE: '/workspace', HYPERVIBE_REPOSITORY: repository, HYPERVIBE_ENVIRONMENT: 'production', HYPERVIBE_PROGRAM_FINGERPRINT: 'b'.repeat(64), HYPERVIBE_CREDENTIAL_OPERATIONS: '' };
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)); reads.push(url.pathname + url.search);
    expect(url.searchParams.get('teamId')).toBe('team_1234567890');
    if (url.pathname === '/v2/files') return new Response(null, { status: 200 });
    if (url.pathname === `/v9/projects/${projectId}`) return Response.json({ id: projectId, accountId: 'team_1234567890', name: 'bound-app' });
    if (url.pathname === '/v7/deployments') {
      const list = [...deployments].reverse().map(value => listedStates.has(value.id) ? { ...value, readyState: listedStates.get(value.id) } : value);
      return Response.json({ deployments: paginate && !url.searchParams.has('until') ? [deployments[0]] : list, pagination: { count: list.length, next: paginate && !url.searchParams.has('until') ? 10 : null, prev: null } });
    }
    if (url.pathname === '/v13/deployments' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)); mutations.push({ body, query: Object.fromEntries(url.searchParams) });
      expect(body.project).toBe(projectId); expect(body.target).toBe('production');
      // Vercel may deduplicate identical source unless forceNew is explicitly set.
      if (url.searchParams.get('forceNew') !== '1') return Response.json(deployments[0]);
      const created = { id: `replacement-${mutations.length}`, uid: `replacement-${mutations.length}`, projectId, target: 'production', meta: body.meta, readyState: 'READY', createdAt: mutations.length + 10, url: 'replacement.example.test' };
      deployments.push(created);
      if (fault && !lost) { lost = true; if (fault === 'lost-network') throw new Error('Synthetic lost deployment acknowledgement'); return Response.json({}, { status: 503 }); }
      return Response.json(created);
    }
    if (url.pathname.startsWith('/v13/deployments/')) {
      const deployment = deployments.find(value => value.id === decodeURIComponent(url.pathname.split('/').at(-1)!));
      if (!deployment) throw new Error('Unexpected native identity read');
      return Response.json(corruptReadback ? { ...deployment, meta: { ...deployment.meta, hypervibeCredentialOperation: 'another-operation' } } : deployment);
    }
    throw new Error('Unexpected Vercel operation');
  };
  const target = { environmentName: 'production', kind: 'production' as const, branch: 'main', autoDeployOnPush: false, serviceNames: ['web'], providerProjectId: scope, providerServiceIds: [serviceId] };
  const source = kind === 'github' ? extractGitHubScript('jobs:\n  deploy:\n    steps:\n' + buildVercelGitHubActionsSteps(target).steps, 'Upload and deploy exact-SHA source to existing Vercel Projects') : buildVercelPortableRuntime().replace(/^import .*;\n/gm, '');
  const fs = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }), readFileSync: (name: string) => name === '.hypervibe-deploy-sha' ? sha : Buffer.from('export default {}') };
  const execFileSync = (_cmd: string, args: string[]) => args[0] === 'rev-parse' ? sha : Buffer.from('index.js\0');
  async function run(operationId = 'accepted-one') {
    env.HYPERVIBE_CREDENTIAL_OPERATIONS = JSON.stringify({ web: { operationId, serviceId } });
    let output: any;
    await new AsyncFunction('require', 'process', 'fetch', 'exec', 'core', 'setTimeout', 'Buffer', 'createHash', 'execFileSync', 'lstatSync', 'readFileSync', 'resolve', 'sep', 'writeFile', source)(
      (name: string) => name === 'fs' ? fs : name === 'path' ? path : crypto, { env }, fetch,
      { getExecOutput: async () => ({ stdout: 'index.js\0' }) }, { info() {}, setOutput: (_name: string, value: string) => { output = JSON.parse(value); } },
      (callback: () => void) => callback(), Buffer, crypto.createHash, execFileSync, fs.lstatSync, fs.readFileSync, path.resolve, path.sep,
      async (_name: string, value: string) => { output = JSON.parse(value).deployments; },
    );
    return output;
  }
  return {
    run, mutations, reads, paginate: () => { paginate = true; }, corrupt: () => { corruptReadback = true; },
    duplicate: () => { deployments.push({ ...deployments.at(-1), id: 'duplicate-deployment', uid: 'duplicate-deployment' }); },
    state: (readyState: string | undefined, listedState: string) => {
      const latest = deployments.at(-1)!; latest.readyState = readyState; listedStates.set(latest.id, listedState);
    },
  };
}

describe.each(['github', 'portable'] as const)('%s Vercel credential rollout', kind => {
  it('creates one fresh deployment for each accepted operation at the same SHA, then reuses only its exact retry', async () => {
    const f = fixture(kind);
    const first = await f.run(); expect(f.mutations).toHaveLength(1);
    expect(f.mutations[0].query.forceNew).toBe('1'); expect(f.mutations[0].body.meta.hypervibeCredentialOperation).toEqual(expect.any(String));
    expect(first).toContainEqual(expect.objectContaining({ serviceId, ...(kind === 'github' ? { deploymentIds: ['replacement-1'] } : { deploymentId: 'replacement-1' }) }));
    await f.run(); expect(f.mutations).toHaveLength(1);
    await f.run('accepted-two'); expect(f.mutations).toHaveLength(2);
    expect(f.mutations[1].body.meta.hypervibeCredentialOperation).not.toBe(f.mutations[0].body.meta.hypervibeCredentialOperation);
  });
  it.each(['lost-http', 'lost-network'] as const)('inspects an uncertain deployment creation without repeating it (%s)', async fault => {
    const f = fixture(kind, fault); await f.run(); expect(f.mutations).toHaveLength(1);
    await f.run(); expect(f.mutations).toHaveLength(1);
  });
  it('follows the complete deployment inventory before retry and rejects mismatched readback provenance', async () => {
    const f = fixture(kind); await f.run(); f.paginate();
    await f.run(); expect(f.mutations).toHaveLength(1); expect(f.reads.some(url => url.includes('until=10'))).toBe(true);
    f.corrupt(); await expect(f.run()).rejects.toThrow(/provenance|credential|operation/i); expect(f.mutations).toHaveLength(1);
  });
  it('blocks multiple native deployments claiming one accepted operation', async () => {
    const f = fixture(kind); await f.run(); f.duplicate(); await expect(f.run()).rejects.toThrow(/ambiguous|multiple/i); expect(f.mutations).toHaveLength(1);
  });
  it.each(['ERROR', 'CANCELED'])('retries a confirmed %s deployment once for the same accepted credential, excluding failed history', async state => {
    const f = fixture(kind); await f.run(); f.state(state, 'READY');
    const beforeRetry = f.reads.length;
    const result = await f.run(); expect(f.mutations).toHaveLength(2);
    expect(result).toContainEqual(expect.objectContaining(kind === 'github' ? { deploymentIds: ['replacement-2'] } : { deploymentId: 'replacement-2' }));
    expect(f.mutations[1].body.meta.hypervibeCredentialOperation).toBe(f.mutations[0].body.meta.hypervibeCredentialOperation);
    const retryReads = f.reads.slice(beforeRetry);
    expect(retryReads.findIndex(url => url.startsWith('/v13/deployments/replacement-1?'))).toBeLessThan(retryReads.findIndex(url => url.startsWith('/v13/deployments?')));
    await f.run(); expect(f.mutations).toHaveLength(2);
    f.duplicate(); await expect(f.run()).rejects.toThrow(/ambiguous|multiple/i); expect(f.mutations).toHaveLength(2);
  });
  it.each(['BLOCKED', undefined, 'UNKNOWN'])('does not treat %s or an unverified list failure as permission to replace a deployment', async state => {
    const f = fixture(kind); await f.run(); f.state(state, 'ERROR');
    await expect(f.run()).rejects.toThrow(); expect(f.mutations).toHaveLength(1);
  });
  it('keeps a viable deployment when only the list claims failure and rejects failed readbacks with changed provenance', async () => {
    const f = fixture(kind); await f.run(); f.state('READY', 'ERROR');
    await f.run(); expect(f.mutations).toHaveLength(1);
    f.state('ERROR', 'ERROR'); f.corrupt();
    await expect(f.run()).rejects.toThrow(/provenance|credential|operation/i); expect(f.mutations).toHaveLength(1);
  });
  it('never adopts another accepted operation while retrying a failed credential rollout', async () => {
    const f = fixture(kind); await f.run(); f.state('ERROR', 'ERROR');
    await f.run('accepted-two'); expect(f.mutations).toHaveLength(2);
    await f.run('accepted-one'); expect(f.mutations).toHaveLength(3);
    expect(f.mutations[2].body.meta.hypervibeCredentialOperation).toBe(f.mutations[0].body.meta.hypervibeCredentialOperation);
    expect(f.mutations[2].body.meta.hypervibeCredentialOperation).not.toBe(f.mutations[1].body.meta.hypervibeCredentialOperation);
    await f.run('accepted-two'); await f.run('accepted-one'); expect(f.mutations).toHaveLength(3);
  });
});

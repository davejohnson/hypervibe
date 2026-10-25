import { z } from 'zod';
import type { BranchDeployTarget, CloudDeploymentCiAccessV1 } from '../ports/ci-deploy.port.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { parseCloudDeploymentConnectionV1 } from './cloud-deployment-authentication.js';

/** Caller supplies provider-verified registry/username/password variables; only the temporary path is exported. */
export const GITHUB_EPHEMERAL_DOCKER_LOGIN_RUNTIME = `const fs = require('node:fs'), path = require('node:path');
const dockerConfig = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'hypervibe-docker-'));
fs.chmodSync(dockerConfig, 0o700);
try {
  core.setSecret(password);
  require('node:child_process').execFileSync('docker', ['--config', dockerConfig, 'login', registry, '--username', username, '--password-stdin'],
    { input: password, stdio: ['pipe', 'ignore', 'ignore'], timeout: 30000 });
  core.exportVariable('DOCKER_CONFIG', dockerConfig);
} catch { fs.rmSync(dockerConfig, { recursive: true, force: true }); throw new Error('Temporary registry sign-in failed.'); }
`;
export const GITHUB_EPHEMERAL_DOCKER_CLEANUP_STEP = `      - name: Remove temporary registry access
        if: always()
        uses: actions/github-script@v9
        with:
          script: |
            const path = require('node:path');
            const config = process.env.DOCKER_CONFIG;
            if (config && path.dirname(config) === process.env.RUNNER_TEMP && path.basename(config).startsWith('hypervibe-docker-')) {
              require('node:fs').rmSync(config, { recursive: true, force: true });
            }
`;

/** A workflow contains only the approved broker location and immutable native identities. */
export function reviewedCloudDeploymentCiAccess(target: BranchDeployTarget): CloudDeploymentCiAccessV1 {
  const access = z.object({ origin: z.string().url(), projectId: z.string().min(1).max(128), connectionId: z.string().guid(),
    environment: z.string(), sourceBranch: z.string().min(1).max(240).regex(/^[^\s~^:?*\[\\]+$/), connection: z.unknown() }).strict().parse(target.deploymentAccess);
  const value = access.connection as CloudDeploymentCiAccessV1['connection'];
  const provider = providerRegistry.get(value?.hostingProvider), contract = provider?.transientAuthentication;
  if (!contract || provider.metadata.orchestration?.ci?.transientDeployment !== 'github-oidc-broker-v1') throw new Error('This provider has no reviewed transient CI deployment capability.');
  const connection = parseCloudDeploymentConnectionV1(value, contract), origin = new URL(access.origin);
  if (origin.protocol !== 'https:' || origin.origin !== access.origin || origin.username || origin.password
    || access.environment !== target.environmentName || access.sourceBranch !== target.branch || connection.environment !== access.environment
    || connection.source.branch !== access.sourceBranch || connection.appId !== access.projectId
    || !/^github\.com\/[^/]+\/[^/]+$/.test(connection.source.repository)
    || target.providerRegion && target.providerRegion !== connection.deployment.region) throw new Error('CI deployment access does not match the reviewed environment.');
  return { ...access, connection };
}

/** Executed inside actions/github-script; no credentials enter outputs, files or workflow declarations. */
export function buildGitHubDeploymentSessionRuntime(target: BranchDeployTarget): string {
  const access = reviewedCloudDeploymentCiAccess(target);
  const proof = { origin: access.origin, projectId: access.projectId, connectionId: access.connectionId, environment: access.environment,
    branch: access.sourceBranch, repository: access.connection.source.repository.slice('github.com/'.length), principal: access.connection.principals.release };
  return `const hvDeploymentAccess = ${JSON.stringify(proof)};
async function hvDeploymentSession(target) {
  const unavailable = () => new Error('Cloud deployment release access could not be verified.');
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, 15000); });
  const bounded = promise => Promise.race([promise, deadline]);
  const exact = (a, b) => {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return a === b;
    return Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(key => Object.hasOwn(a, key) && exact(a[key], b[key]));
  };
  try {
    if ((context.repo.owner + '/' + context.repo.repo).toLowerCase() !== hvDeploymentAccess.repository || context.ref !== 'refs/heads/' + hvDeploymentAccess.branch
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(context.sha)) throw unavailable();
    const azure = hvDeploymentAccess.principal.kind === 'azure-managed-identity';
    if (azure ? !['resource-manager', 'container-registry'].includes(target) : target !== undefined) throw unavailable();
    // github.sha identifies the reviewed workflow source. A dispatch candidate
    // may differ and is validated separately by the immutable-release program.
    const file = (await bounded(github.rest.repos.getContent({ ...context.repo, path: '.hypervibe/spec.json', ref: context.sha }))).data;
    if (!file || file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || file.content.length > 1400000
      || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 1048576) throw unavailable();
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.length !== file.size) throw unavailable();
    const expectedSourceDigest = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const oidc = await bounded(core.getIDToken(hvDeploymentAccess.origin + '/api/v1/deployment-sessions'));
    if (typeof oidc !== 'string' || !oidc || oidc.length > 65536 || /[\\r\\n]/.test(oidc)) throw unavailable();
    core.setSecret(oidc);
    const url = hvDeploymentAccess.origin + '/api/v1/projects/' + encodeURIComponent(hvDeploymentAccess.projectId) + '/cloud-deployments/' + hvDeploymentAccess.connectionId + '/release-sessions';
    const response = await bounded(fetch(url, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: 'Bearer ' + oidc, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedSourceRevision: context.sha, expectedSourceDigest, ...(target ? { target } : {}) }) }));
    if (!response.ok || response.redirected || response.url && response.url !== url || !response.body) { void response.body?.cancel().catch(() => {}); throw unavailable(); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { for (;;) { const chunk = await bounded(reader.read()); if (chunk.done) break; size += chunk.value.byteLength; if (size > 65536) throw unavailable(); chunks.push(chunk.value); } }
    catch { void reader.cancel().catch(() => {}); throw unavailable(); } finally { reader.releaseLock(); }
    const session = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const kind = hvDeploymentAccess.principal.kind === 'aws-role' ? 'aws-sts' : azure ? 'azure-federation' : 'gcp-impersonation';
    const sensitive = kind === 'aws-sts' ? ['accessKeyId', 'secretAccessKey', 'sessionToken'] : ['token'];
    const keys = ['kind', 'principal', 'expiresAt', ...sensitive, ...(azure ? ['target'] : [])];
    if (!session || session.kind !== kind || !exact(session.principal, hvDeploymentAccess.principal)
      || Object.keys(session).length !== keys.length || keys.some(key => !Object.hasOwn(session, key))
      || azure && session.target !== target || typeof session.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now() + 30000 || Date.parse(session.expiresAt) > Date.now() + 7200000
      || sensitive.some(key => typeof session[key] !== 'string' || !session[key] || session[key].length > 16384 || /[\\r\\n]/.test(session[key]))) throw unavailable();
    for (const key of sensitive) core.setSecret(session[key]);
    return session;
  } catch { throw unavailable(); } finally { clearTimeout(timer); controller.abort(); }
}
`;
}

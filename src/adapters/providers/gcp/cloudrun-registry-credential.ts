import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { RegistryCredentialLifecycle, RegistryCredentialTarget } from '../../../domain/ports/registry-credential.port.js';
import { gcpRuntimeRequest } from './gcp-runtime-client.js';

const containerSchema = z.object({ image: z.string().min(1) }).passthrough();
const repositorySchema = z.object({ name: z.string(), format: z.literal('DOCKER'), mode: z.literal('REMOTE_REPOSITORY'),
  remoteRepositoryConfig: z.object({ dockerRepository: z.object({ publicRepository: z.string().optional(), customRepository: z.object({ uri: z.string().url() }).optional() }).optional(),
    upstreamCredentials: z.object({ usernamePasswordCredentials: z.object({ username: z.string().min(1), passwordSecretVersion: z.string().regex(/^projects\/[a-zA-Z0-9_-]+\/secrets\/[a-zA-Z0-9_-]+\/versions\/(?:[0-9]+|latest)$/) }) }),
  }).passthrough(),
}).passthrough();

export function createCloudRunRegistryCredentialLifecycle(
  resolve: (environment: Environment, service: string) => Promise<{ name: string; projectId: string; environmentId: string; resourceUid?: string }>,
  token: () => Promise<string>,
): RegistryCredentialLifecycle {
  const request = async (host: string, path: string, init: RequestInit = {}) => gcpRuntimeRequest(`https://${host}/v1/${path}`, await token(), init);
  const observe = async (environment: Environment, service: string) => {
    const scope = await resolve(environment, service);
    const workload = z.object({ name: z.string(), uid: z.string().min(1), template: z.object({ containers: z.array(containerSchema).optional(), template: z.object({ containers: z.array(containerSchema) }).optional() }) }).parse(
      await gcpRuntimeRequest(`https://run.googleapis.com/v2/${scope.name}`, await token()));
    if (workload.name !== scope.name || (scope.resourceUid && workload.uid !== scope.resourceUid)) throw new Error();
    const containers = workload.template.containers ?? workload.template.template?.containers;
    if (!containers?.length) throw new Error();
    const image = containers[0]!.image;
    const match = /^([a-z0-9-]+)-docker\.pkg\.dev\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/.+/.exec(image);
    if (!match) throw new Error();
    const repository = `projects/${match[2]}/locations/${match[1]}/repositories/${match[3]}`;
    const current = repositorySchema.parse(await request('artifactregistry.googleapis.com', repository));
    if (current.name !== repository) throw new Error();
    const credentials = current.remoteRepositoryConfig.upstreamCredentials.usernamePasswordCredentials;
    const remote = current.remoteRepositoryConfig.dockerRepository;
    const upstream = remote?.customRepository?.uri ?? remote?.publicRepository;
    if (!upstream) throw new Error();
    if (remote?.customRepository) {
      const url = new URL(upstream);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    }
    const target: RegistryCredentialTarget = { provider: 'cloudrun', projectId: scope.projectId, environmentId: scope.environmentId, serviceId: scope.name, instanceId: workload.uid,
      image, registry: repository, upstream, credentialReference: credentials.passwordSecretVersion.replace(/\/versions\/[^/]+$/, ''), activation: 'deferred' };
    return { target, credentials };
  };
  const read = async (secret: string, version: string) => {
    const value = z.object({ name: z.string(), payload: z.object({ data: z.string() }) }).parse(await request('secretmanager.googleapis.com', `${version}:access`));
    if (!value.name.startsWith(`${secret}/versions/`) || !/\/versions\/[0-9]+$/.test(value.name)
      || (!version.endsWith('/latest') && value.name !== version)) throw new Error();
    return { name: value.name, value: Buffer.from(value.payload.data, 'base64').toString('utf8') };
  };
  const port: RegistryCredentialLifecycle = {
    async inspect(environment, service) {
      try { return (await observe(environment, service)).target; }
      catch { throw new Error('The exact Cloud Run remote-registry credential target cannot be verified. Standard Artifact Registry images use workload identity; external credentials belong to an existing remote repository and Secret Manager reference.'); }
    },
    async update(environment, service, expected, credential, context) {
      let attempted = false;
      try {
        const { target, credentials } = await observe(environment, service);
        if (!isDeepStrictEqual(expected, target) || !target.credentialReference || !credential.username || !credential.token) throw new Error();
        const secret = target.credentialReference;
        const current = await read(secret, credentials.passwordSecretVersion);
        let replacementVersion = current.name;
        if (current.value !== credential.token) {
          // A preceding attempt may have committed addVersion but lost its response.
          const latest = await read(secret, `${secret}/versions/latest`);
          if (latest.value === credential.token) replacementVersion = latest.name;
          else {
            // The latest alias can lag a committed version. Unknown is not permission to add another version.
            if (context?.retryUncertain) throw new Error();
            attempted = true;
            const created = z.object({ name: z.string(), state: z.literal('ENABLED') }).parse(await request('secretmanager.googleapis.com', `${secret}:addVersion`, { method: 'POST', body: JSON.stringify({ payload: { data: Buffer.from(credential.token).toString('base64') } }) }));
            if (!created.name.startsWith(`${secret}/versions/`) || !/\/versions\/[0-9]+$/.test(created.name)) throw new Error();
            replacementVersion = created.name;
          }
        }
        if (credentials.passwordSecretVersion !== replacementVersion || credentials.username !== credential.username) {
          // Recheck exact workload/repository identity immediately before changing its reference.
          if (!isDeepStrictEqual((await observe(environment, service)).target, target)) throw new Error();
          attempted = true;
          const result = await request('artifactregistry.googleapis.com', `${target.registry}?updateMask=remoteRepositoryConfig.upstreamCredentials`, { method: 'PATCH', body: JSON.stringify({ name: target.registry,
            remoteRepositoryConfig: { upstreamCredentials: { usernamePasswordCredentials: { username: credential.username, passwordSecretVersion: replacementVersion } } } }) });
          if (result && typeof result === 'object' && 'name' in result && typeof result.name === 'string' && result.name.includes('/operations/')) {
            if (!/^projects\/[a-zA-Z0-9_-]+\/locations\/[a-z0-9-]+\/operations\/[a-zA-Z0-9_-]+$/.test(result.name)) throw new Error();
            let operation: any = result;
            for (let attempt = 0; !operation.done && attempt < 30; attempt++) { await new Promise(resolve => setTimeout(resolve, 1000)); operation = await request('artifactregistry.googleapis.com', result.name); }
            if (!operation.done || operation.error) throw new Error();
          }
        }
        const after = await observe(environment, service); const accepted = await read(secret, after.credentials.passwordSecretVersion);
        if (!isDeepStrictEqual(after.target, target) || after.credentials.username !== credential.username || accepted.value !== credential.token) throw new Error();
        return { success: true, message: 'Artifact Registry upstream credential and Secret Manager readback verified. Managed rollout and upstream image-pull verification remain required.', data: { mutationAttempted: attempted, configurationUpdated: true, credentialValueEvidence: 'readback', credentialUpdateActivation: 'deferred', runtimeRolloutRequired: true } };
      } catch { return { success: false, message: attempted ? 'Remote-registry credential update is uncertain. Resume by inspecting the current repository reference and existing secret versions.' : 'The existing remote-registry target or secret version is unverified; no write attempted.', data: { mutationAttempted: attempted } }; }
    },
  };
  port.reconcile = (environment, service, expected, credential, context) => port.update(environment, service, expected, credential, { ...context, retryUncertain: true });
  return port;
}

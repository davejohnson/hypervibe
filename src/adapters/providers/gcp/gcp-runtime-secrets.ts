import { z } from 'zod';
import type { RuntimeIdentityRequest } from '../../../domain/ports/runtime-identity.port.js';
import { runtimeSecretReferenceSchema } from '../../../domain/ports/secret-destination.port.js';
import { GcpRuntimeError, gcpRuntimeRequest, parseGcpRuntimePolicy } from './gcp-runtime-client.js';

const targetSchema = z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  projectNumber: z.string().regex(/^[1-9]\d{5,29}$/), resource: z.string().regex(/^projects\/[1-9]\d*\/secrets\/[A-Za-z0-9_-]{1,255}$/),
  version: z.string().regex(/^[1-9]\d*$/), createTime: z.string().datetime().optional(),
}).strict();
export type GcpRuntimeSecret = z.infer<typeof targetSchema>;
export function serializeRuntimeSecrets(values: GcpRuntimeSecret[]): string {
  const result = JSON.stringify([...values].sort((a, b) => a.key.localeCompare(b.key)));
  if (result.length > 16384) throw new GcpRuntimeError('Runtime secret permission scope exceeds its reviewed bound.');
  return result;
}
export function parseRuntimeSecrets(value?: string): GcpRuntimeSecret[] {
  if (value === undefined) return [];
  try {
    if (value.length > 16384) throw new Error();
    const targets = z.array(targetSchema).max(100).parse(JSON.parse(value));
    if (new Set(targets.map(target => target.key)).size !== targets.length || new Set(targets.map(target => target.resource)).size !== targets.length
      || targets.some(target => !target.resource.startsWith(`projects/${target.projectNumber}/secrets/`))) throw new Error();
    return targets;
  } catch { throw new GcpRuntimeError('Retained runtime secret permission identities are malformed or ambiguous.'); }
}
export function desiredRuntimeSecrets(request: RuntimeIdentityRequest, projectId: string): GcpRuntimeSecret[] {
  if (!request.environmentSpec) return parseRuntimeSecrets(request.binding?.evidence.readerGrants);
  const result: GcpRuntimeSecret[] = [];
  for (const [key, input] of Object.entries(request.environmentSpec.secretDestinations ?? {})) {
    if (!input.version) continue; // Collection/generation owns the still-missing value.
    const reference = runtimeSecretReferenceSchema.parse(input); const destination = reference.destination;
    if (destination.provider !== 'gcp-secret-manager' || destination.projectId !== projectId)
      throw new GcpRuntimeError('The runtime secret reference is outside this exact Google Cloud project.');
    result.push({ key, projectNumber: destination.projectNumber, resource: `projects/${destination.projectNumber}/secrets/${destination.secretId}`, version: reference.version });
  }
  return parseRuntimeSecrets(serializeRuntimeSecrets(result));
}
export function unionRuntimeSecrets(previous: GcpRuntimeSecret[], desired: GcpRuntimeSecret[]): GcpRuntimeSecret[] {
  const result = new Map(previous.map(target => [target.key, target]));
  for (const target of desired) {
    const before = result.get(target.key);
    if (before && before.resource !== target.resource) throw new GcpRuntimeError('The secret target changed; review removal of the original reader grant before adopting another container.');
    result.set(target.key, { ...target, ...(before?.createTime ? { createTime: before.createTime } : {}) });
  }
  return [...result.values()];
}
/** Only metadata and policies; never access a secret payload or alter versions. */
export async function readRuntimeSecretPolicies(projectId: string, targets: GcpRuntimeSecret[], token: string, required: GcpRuntimeSecret[], transport: typeof fetch = fetch) {
  const numbers = new Set<string>();
  const result: Array<{ target: GcpRuntimeSecret; desired: boolean; url: string; policy: ReturnType<typeof parseGcpRuntimePolicy> | null }> = [];
  for (const target of targets) {
    if (!numbers.has(target.projectNumber)) {
      const project = await gcpRuntimeRequest(`https://cloudresourcemanager.googleapis.com/v3/projects/${target.projectNumber}`, token, {}, transport) as Record<string, unknown> | null;
      if (project?.name !== `projects/${target.projectNumber}` || project.projectId !== projectId || project.state !== 'ACTIVE')
        throw new GcpRuntimeError('The runtime secret project number does not match its reviewed active project.');
      numbers.add(target.projectNumber);
    }
    const desired = required.some(value => value.resource === target.resource);
    const url = `https://secretmanager.googleapis.com/v1/${target.resource}`;
    const secret = await gcpRuntimeRequest(url, token, {}, transport) as Record<string, unknown> | null;
    if (!secret) {
      if (desired) throw new GcpRuntimeError('The exact declared secret container is absent; no replacement is authorized.');
      result.push({ target, desired, url, policy: null }); continue;
    }
    if (secret.name !== target.resource || !z.string().datetime().safeParse(secret.createTime).success
      || target.createTime && secret.createTime !== target.createTime) throw new GcpRuntimeError('The runtime secret container identity is incomplete or was replaced.');
    if (desired) {
      const name = `${target.resource}/versions/${target.version}`;
      const version = await gcpRuntimeRequest(`https://secretmanager.googleapis.com/v1/${name}`, token, {}, transport) as Record<string, unknown> | null;
      if (version?.name !== name || version.state !== 'ENABLED') throw new GcpRuntimeError('The immutable runtime secret version is missing, disabled, or unverified.');
    }
    const policy = parseGcpRuntimePolicy(await gcpRuntimeRequest(`${url}:getIamPolicy?options.requestedPolicyVersion=3`, token, {}, transport));
    result.push({ target: { ...target, createTime: String(secret.createTime) }, desired, url, policy });
  }
  return result;
}

/** Consumer-first removal includes retained immutable revisions/executions, not
 * just the desired template. Published Run v2 list/resource contracts are the
 * metadata boundary; values are neither returned nor persisted. */
export async function hasRuntimeSecretConsumers(projectId: string, target: GcpRuntimeSecret,
  resources: Array<{ name: string; job: boolean }>, token: string, transport: typeof fetch = fetch): Promise<boolean> {
  const id = target.resource.split('/').at(-1)!;
  const matches = new Set([id, target.resource, `projects/${projectId}/secrets/${id}`]);
  const object = (value: unknown): Record<string, any> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GcpRuntimeError('Runtime consumer metadata is incomplete.');
    return value as Record<string, any>;
  };
  const consumes = (value: unknown) => {
    const template = object(value);
    if (!Array.isArray(template.containers) || !template.containers.length) throw new GcpRuntimeError('Runtime consumer containers are unverified.');
    for (const raw of template.containers) {
      const container = object(raw);
      if (container.env !== undefined && !Array.isArray(container.env)) throw new GcpRuntimeError('Runtime consumer variables are unverified.');
      for (const rawEnv of container.env ?? []) {
        const env = object(rawEnv);
        if (env.valueSource === undefined) continue;
        const ref = object(object(env.valueSource).secretKeyRef);
        if (typeof ref.secret !== 'string' || !ref.secret) throw new GcpRuntimeError('Runtime consumer reference is incomplete.');
        if (matches.has(ref.secret)) return true;
      }
    }
    if (template.volumes !== undefined && !Array.isArray(template.volumes)) throw new GcpRuntimeError('Runtime consumer volumes are unverified.');
    for (const raw of template.volumes ?? []) {
      const volume = object(raw);
      if (volume.secret === undefined) continue;
      const ref = object(volume.secret);
      if (typeof ref.secret !== 'string' || !ref.secret) throw new GcpRuntimeError('Runtime volume reference is incomplete.');
      if (matches.has(ref.secret)) return true;
    }
    return false;
  };
  for (const resource of resources) {
    const url = `https://run.googleapis.com/v2/${resource.name}`;
    const current = await gcpRuntimeRequest(url, token, {}, transport);
    if (current === null) continue;
    const workload = object(current);
    if (workload.name !== resource.name || typeof workload.uid !== 'string' || !workload.uid)
      throw new GcpRuntimeError('The bound runtime consumer identity is unverified.');
    if (consumes(resource.job ? object(workload.template).template : workload.template)) return true;
    const collection = resource.job ? 'executions' : 'revisions';
    let cursor: string | undefined; const seen = new Set<string>(); const identities = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const result = object(await gcpRuntimeRequest(`${url}/${collection}?${new URLSearchParams({ pageSize: '100', ...(cursor ? { pageToken: cursor } : {}) })}`, token, {}, transport));
      const children = result[collection] ?? [];
      if (!Array.isArray(children) || children.length > 100) throw new GcpRuntimeError('Retained runtime consumer inventory is incomplete.');
      for (const raw of children) {
        const child = object(raw);
        if (typeof child.name !== 'string' || !child.name.startsWith(`${resource.name}/${collection}/`)
          || typeof child.uid !== 'string' || !child.uid || identities.has(child.name))
          throw new GcpRuntimeError('Retained runtime consumer identity is ambiguous.');
        identities.add(child.name);
        // All retained revisions may be reactivated; a completed execution's
        // template is also retained until explicitly removed by its lifecycle.
        if (consumes(resource.job ? child.template : child)) return true;
      }
      if (result.nextPageToken === undefined || result.nextPageToken === '') break;
      if (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 4096 || seen.has(result.nextPageToken) || page === 4)
        throw new GcpRuntimeError('Retained runtime consumer inventory exceeds its verified bound.');
      cursor = result.nextPageToken; seen.add(cursor);
    }
  }
  return false;
}

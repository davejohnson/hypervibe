import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CommandContext } from './context.js';
import { HvError } from './results.js';
import { CloudHttpError, cloudAccessRejected, createCloudJsonClient } from './cloud-http.js';
import { createHypervibeCloudPairingClient, normalizeHypervibeCloudBaseUrl } from './cloud-pairing.js';
import { parseCredentialRef } from './credential-reference.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { detectGitRemoteUrl, normalizeGitRemoteIdentity } from '../lib/git-remote.js';
import { currentWorkspaceDirectories, primaryWorkspaceDirectory } from '../lib/workspace-context.js';

const PROVIDER = 'hypervibe-provider-connections';
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/);
const environment = z.object({ id: identifier, key: identifier, name: z.string().max(200), status: z.string().max(80) }).strict();
const provider = z.object({
  providerId: identifier, name: z.string().max(200),
  status: z.enum(['connected', 'partial', 'disabled', 'disconnected']),
  authorization: z.object({
    scope: z.enum(['project', 'environment']), method: z.enum(['token', 'webhook-key', 'workload-identity']),
    credentialKind: z.string().max(100).nullable(), label: z.string().max(300), help: z.string().max(2000),
  }).strict(),
  canReuseAuthorization: z.boolean(), environments: z.array(environment).max(100),
}).strict();
const listing = z.object({
  project: z.object({ id: identifier, name: z.string().max(200) }).strict(),
  coverage: z.enum(['complete', 'partial']), providers: z.array(provider).max(30),
}).strict();
const receipt = z.object({
  projectId: identifier, providerId: identifier, applied: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  results: z.array(z.object({ environmentId: identifier, environmentName: z.string().max(200),
    status: z.enum(['connected', 'already_connected', 'skipped', 'failed']), message: z.string().max(2000),
  }).strict()).max(100),
}).strict();
const revokeReceipt = z.object({ applied: z.literal(1), skipped: z.literal(0) }).strict();
const state = z.object({
  version: z.literal(1), baseUrl: z.string(), repository: z.string(),
  status: z.enum(['pending', 'verified']), expiresAt: z.string().datetime(),
  deviceCode: z.string().optional(), userCode: z.string().optional(), verificationUrl: z.string().optional(),
  token: z.string().optional(), project: z.object({ id: identifier, name: z.string().max(200) }).optional(),
  preview: z.object({ id: z.string().uuid(), digest: z.string(), expiresAt: z.string().datetime() }).optional(),
}).strict();
type State = z.infer<typeof state>;
type Provider = z.infer<typeof provider>;
export interface CloudConnectionsInput {
  action?: 'start' | 'status' | 'preview' | 'connect' | 'revoke'; baseUrl?: string;
  provider?: string; env?: string; credentialsRef?: string; credentialKind?: string; connectionId?: string;
  previewId?: string; confirm?: boolean;
}

export function createCloudConnections({ context, fetchImpl = fetch, directory = primaryWorkspaceDirectory, now = () => new Date() }: {
  context: CommandContext; fetchImpl?: typeof fetch; directory?: () => string; now?: () => Date;
}) {
  function save(scope: string, value: State) {
    const stored = context.repos.connections.upsert({ provider: PROVIDER, scope,
      credentialsEncrypted: context.secretStore.encryptObject(value) });
    if (value.status === 'verified') context.repos.connections.updateStatus(stored.id, 'verified');
  }
  function summary(value: State) {
    return { status: value.status, baseUrl: value.baseUrl, repository: value.repository, expiresAt: value.expiresAt,
      ...(value.status === 'pending' ? { userCode: value.userCode, verificationUrl: value.verificationUrl } : { project: value.project }) };
  }
  async function source(item: Provider, input: CloudConnectionsInput, repository: string) {
    const auth = item.authorization;
    if (!auth.credentialKind) return null;
    if (input.credentialsRef) {
      if (input.credentialKind !== auth.credentialKind || (auth.scope === 'environment' && !input.env)) return null;
      try {
        const resolved = await parseCredentialRef(item.providerId, input.credentialsRef, 'value');
        const value = Object.keys(resolved).length === 1 && typeof resolved.value === 'string'
          ? resolved.value : auth.method === 'workload-identity' ? JSON.stringify(resolved) : null;
        if (!value?.trim()) return null;
        return { value, source: 'credential_reference', scope: input.env ?? 'project' };
      } catch { return null; }
    }
    const declaration = providerRegistry.getMetadata(item.providerId)?.credentials?.hostedMonitoring;
    if (!declaration || declaration.credentialKind !== auth.credentialKind || declaration.scope !== auth.scope) return null;
    // A global credential is usable only when the owner explicitly selects its
    // connection id. Automatic selection is an exact repository match.
    const local = input.connectionId ? context.repos.connections.findById(input.connectionId)
      : context.repos.connections.findByProviderAndScope(item.providerId, repository);
    if (!local || local.provider !== item.providerId || local.status !== 'verified'
      || (local.scope !== repository && !(input.connectionId && local.scope === null))) return null;
    try {
      const values = context.secretStore.decryptObject<Record<string, unknown>>(local.credentialsEncrypted);
      const value = values[declaration.credentialKey];
      if (typeof value !== 'string' || !value.trim()) return null;
      return { value, source: 'saved_connection', scope: local.scope ?? 'global', connectionId: local.id };
    } catch { return null; }
  }
  return {
    async run(input: CloudConnectionsInput) {
      const action = input.action ?? 'preview';
      if ((input.credentialsRef || input.connectionId || input.credentialKind || input.env) && !input.provider)
        throw new HvError('VALIDATION', 'Select one provider when choosing a credential or environment.');
      if (input.credentialsRef && input.connectionId)
        throw new HvError('VALIDATION', 'Choose one credential reference or saved connection.');
      if (input.credentialsRef && !input.credentialKind)
        throw new HvError('VALIDATION', 'Preview first, then supply the exact credentialKind with the private reference.');
      const directories = currentWorkspaceDirectories() ?? [directory()];
      const identities = directories.map(dir => normalizeGitRemoteIdentity(detectGitRemoteUrl(dir) ?? undefined));
      if (!identities.length || identities.some(identity => !identity || !/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity))
        || new Set(identities.map(identity => identity?.toLowerCase())).size !== 1)
        throw new HvError('VALIDATION', 'Use one unambiguous GitHub repository workspace for this command.');
      const repository = identities[0]!.slice('github.com/'.length);
      const baseUrl = normalizeHypervibeCloudBaseUrl(input.baseUrl);
      const scope = `${baseUrl}|${repository}`;
      const stored = context.repos.connections.findByProviderAndScope(PROVIDER, scope);
      let saved: State | undefined;
      if (stored) {
        try { saved = state.parse(context.secretStore.decryptObject(stored.credentialsEncrypted)); }
        catch { throw new HvError('VALIDATION', 'Stored Hypervibe access could not be read safely.'); }
        if (saved.baseUrl !== baseUrl || saved.repository !== repository)
          throw new HvError('VALIDATION', 'Stored Hypervibe access belongs to another repository or site.');
      }
      const active = saved && Date.parse(saved.expiresAt) > now().getTime();
      const pairing = createHypervibeCloudPairingClient({ baseUrl, fetchImpl, purpose: 'provider-connections' });
      function forgetMatchingAccess(field: 'token' | 'deviceCode', value: string) {
        const current = context.repos.connections.findByProviderAndScope(PROVIDER, scope);
        if (!current) return;
        let currentState;
        try { currentState = state.safeParse(context.secretStore.decryptObject(current.credentialsEncrypted)); }
        catch { return; }
        // Never remove a newer grant saved while this request was in flight.
        if (currentState.success && currentState.data[field] === value)
          context.repos.connections.delete(current.id);
      }
      const rawRequest = createCloudJsonClient(baseUrl, fetchImpl);
      const request: ReturnType<typeof createCloudJsonClient> = async (pathname, options = {}) => {
        try { return await rawRequest(pathname, options); }
        catch (error) {
          if (options.token && cloudAccessRejected(error)) forgetMatchingAccess('token', options.token);
          throw error;
        }
      };
      async function projectConnections(connection: State) {
        if (!connection.token || !connection.project) throw new HvError('VALIDATION', 'Start a new browser approval.');
        const parsed = listing.safeParse(await request(
          `/api/v1/projects/${encodeURIComponent(connection.project.id)}/provider-connections`,
          { method: 'GET', token: connection.token }
        ));
        if (!parsed.success || parsed.data.project.id !== connection.project.id)
          throw new HvError('PROVIDER_ERROR', 'Hypervibe returned an invalid project connection list.');
        if (new Set(parsed.data.providers.map(p => p.providerId)).size !== parsed.data.providers.length)
          throw new HvError('PROVIDER_ERROR', 'Hypervibe returned duplicate providers.');
        return parsed.data;
      }
      if (action === 'start') {
        if (active && saved?.status === 'pending') return summary(saved);
        if (active && saved?.status === 'verified') {
          try { await projectConnections(saved); return summary(saved); }
          catch (error) { if (!cloudAccessRejected(error)) throw error; }
        }
        const result = await pairing.start(repository);
        saved = { version: 1, status: 'pending', baseUrl, repository, deviceCode: result.deviceCode,
          userCode: result.userCode, verificationUrl: result.verificationUrl, expiresAt: result.expiresAt };
        save(scope, saved);
        return summary(saved);
      }
      if (!active || !saved) throw new HvError('VALIDATION', 'Start a browser approval for this repository and Hypervibe site first.');
      if (saved.status === 'pending') {
        if (action !== 'status' || !saved.deviceCode)
          throw new HvError('VALIDATION', 'Approve access in the browser, then check status before sharing connections.');
        let result;
        try { result = await pairing.exchange(saved.deviceCode); }
        catch (error) {
          if (error instanceof CloudHttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
            forgetMatchingAccess('deviceCode', saved.deviceCode);
            throw new HvError('VALIDATION', 'This browser approval can no longer be exchanged. Start a new browser approval.');
          }
          throw error;
        }
        if (result.status === 'pending') return { ...summary(saved), retryAfterSeconds: result.retryAfterSeconds };
        const credential = result.credentials[0]!;
        if (!credential.expiresAt || Date.parse(credential.expiresAt) <= now().getTime()
          || Date.parse(credential.expiresAt) > now().getTime() + 31 * 24 * 60 * 60 * 1000)
          throw new HvError('PROVIDER_ERROR', 'Hypervibe returned invalid access expiry.');
        saved = { version: 1, status: 'verified', baseUrl, repository, project: result.project,
          token: credential.token, expiresAt: credential.expiresAt };
        save(scope, saved);
        return summary(saved);
      }
      if (!saved.token || !saved.project) throw new HvError('VALIDATION', 'Start a new browser approval.');
      if (action === 'revoke') {
        if (!input.confirm) throw new HvError('CONFIRM_REQUIRED', 'Confirm revoking this device’s provider-connection access. Existing hosted monitoring remains connected.');
        const revoked = revokeReceipt.safeParse(await request('/api/v1/provider-connection-access', { method: 'DELETE', token: saved.token }));
        if (!revoked.success) throw new HvError('PROVIDER_ERROR', 'Hypervibe returned an invalid revocation receipt. Check access status before retrying.');
        forgetMatchingAccess('token', saved.token);
        return { status: 'revoked', baseUrl, repository, project: saved.project, ...revoked.data };
      }
      const pathname = `/api/v1/projects/${encodeURIComponent(saved.project.id)}/provider-connections`;
      const remote = await projectConnections(saved);
      if (action === 'status') return { ...summary(saved), coverage: remote.coverage,
        providers: remote.providers.map(({ providerId, status }) => ({ providerId, status })) };
      if (remote.coverage !== 'complete') throw new HvError('VALIDATION', 'Hypervibe could not list every connection destination. Refresh app connections before previewing or uploading.');
      const selected = remote.providers.filter(item => !input.provider || item.providerId === input.provider);
      if (!selected.length) throw new HvError('VALIDATION', 'The selected provider is not declared for this app.');
      const plans = [];
      for (const item of selected) {
        if (new Set(item.environments.map(env => env.id)).size !== item.environments.length)
          throw new HvError('PROVIDER_ERROR', 'Hypervibe returned duplicate environments.');
        const environments = item.environments.filter(env => !input.env || env.key === input.env);
        if (input.env && !environments.length) throw new HvError('VALIDATION', 'The selected environment is not declared for this provider.');
        if (input.env && item.authorization.scope === 'project')
          throw new HvError('VALIDATION', 'This connection covers the whole project; omit env to review every destination.');
        const targets = environments.filter(env => env.status !== 'connected');
        const publicPlan = { providerId: item.providerId, credentialKind: item.authorization.credentialKind,
          authorizationScope: item.authorization.scope,
          destinations: environments.map(({ id, key, name, status }) => ({ id, key, name, status })),
          skippedEnvironments: environments.length - targets.length };
        let body: { providerId: string; expectedEnvironmentIds: string[]; secret?: string; secrets?: Record<string, string> } | undefined;
        const expectedEnvironmentIds = item.environments.map(env => env.id).sort();
        let chosen: Awaited<ReturnType<typeof source>> = null;
        let status = 'already_connected';
        if (targets.length) {
          if (item.authorization.credentialKind && item.canReuseAuthorization && item.authorization.scope === 'project') {
            body = { providerId: item.providerId, expectedEnvironmentIds }; status = 'ready';
          } else {
            chosen = await source(item, input, repository);
            if (chosen) {
              body = item.authorization.scope === 'project'
                ? { providerId: item.providerId, expectedEnvironmentIds, secret: chosen.value }
                : { providerId: item.providerId, expectedEnvironmentIds, secrets: Object.fromEntries(targets.map(env => [env.id, chosen!.value])) };
              status = 'ready';
            } else status = 'needs_access';
          }
        }
        plans.push({ body, knownEnvironmentIds: item.environments.map(env => env.id), public: { ...publicPlan, status,
          ...(chosen ? { source: chosen.source, sourceScope: chosen.scope, ...('connectionId' in chosen ? { connectionId: chosen.connectionId } : {}) }
            : body ? { source: 'hosted_connection' } : {}),
          ...(status === 'needs_access' ? { nextStep: item.authorization.credentialKind
            ? 'Inspect hv_connections for compatible saved access and select its connectionId, or use a private credentialsRef with the declared credentialKind. Environment-scoped access requires env. A connection scoped to another resource or a deployment-only role cannot be reused without verified compatibility.'
            : 'This provider does not declare a reusable monitoring credential yet. Review its connection in app settings.' } : {}),
        } });
      }
      const digest = createHash('sha256').update(JSON.stringify({ baseUrl, repository, projectId: saved.project.id, plans })).digest('hex');
      if (action === 'preview') {
        const previewId = randomUUID();
        save(scope, { ...saved, preview: { id: previewId, digest, expiresAt: new Date(now().getTime() + 10 * 60_000).toISOString() } });
        return { status: 'preview', baseUrl, repository, project: saved.project, coverage: remote.coverage, previewId,
          providers: plans.map(plan => plan.public),
          nextStep: 'Review these destinations, then connect with the same selectors, previewId, and confirm=true. Values never enter chat or tool output.' };
      }
      if (!input.confirm || !input.previewId) throw new HvError('CONFIRM_REQUIRED', 'Preview the exact connections, then connect with previewId and confirm=true.');
      if (!saved.preview || saved.preview.id !== input.previewId || saved.preview.digest !== digest || Date.parse(saved.preview.expiresAt) <= now().getTime())
        throw new HvError('VALIDATION', 'The connection preview changed or expired. Preview again before connecting.');
      const results = [];
      let applied = 0; let skipped = 0;
      // Invalidate first. An ambiguous network outcome requires a fresh status/preview;
      // already-connected destinations will then be skipped on retry.
      save(scope, { ...saved, preview: undefined });
      for (const plan of plans) {
        if (!plan.body) {
          results.push(plan.public);
          continue;
        }
        try {
          const parsedReceipt = receipt.safeParse(await request(pathname, { token: saved.token, body: plan.body }));
          const value = parsedReceipt.success ? parsedReceipt.data : null;
          if (!value || value.projectId !== saved.project.id || value.providerId !== plan.public.providerId
            || plan.public.destinations.some(env => !value.results.some(result => result.environmentId === env.id))
            || value.results.some(result => !plan.knownEnvironmentIds.includes(result.environmentId)
              || (!plan.public.destinations.some(env => env.id === result.environmentId) && !['skipped', 'already_connected'].includes(result.status)))
            || new Set(value.results.map(result => result.environmentId)).size !== value.results.length)
            throw new Error('Invalid receipt');
          applied += value.applied; skipped += value.skipped;
          const incomplete = value.results.some(result => ['failed', 'skipped'].includes(result.status)
            && plan.public.destinations.some(env => env.id === result.environmentId));
          results.push({ providerId: value.providerId, status: incomplete ? 'partial' : 'connected',
            applied: value.applied, skipped: value.skipped,
            results: value.results.map(({ environmentId, status }) => ({ environmentId, status })),
            ...(incomplete ? { nextStep: 'Check app connection settings, then preview again for the destinations still needing access.' } : {}) });
          if (incomplete) {
            for (const next of plans.slice(plans.indexOf(plan) + 1))
              results.push({ providerId: next.public.providerId, status: 'skipped', nextStep: 'A preceding connection needs checking first.' });
            break;
          }
        } catch (error) {
          results.push({ providerId: plan.public.providerId, status: cloudAccessRejected(error) ? 'access_required' : 'unknown',
            nextStep: cloudAccessRejected(error) ? 'Start a new browser approval, then preview the remaining connections before retrying.'
              : 'Check status and preview again before retrying. No credential values are returned.' });
          // Respect stage gating; no following uploads after an unknown outcome.
          const remaining = plans.slice(plans.indexOf(plan) + 1);
          for (const next of remaining) results.push({ providerId: next.public.providerId, status: 'skipped', nextStep: 'A preceding connection needs checking first.' });
          break;
        }
      }
      return { status: results.some(result => ['unknown', 'partial', 'needs_access', 'access_required', 'skipped'].includes(result.status)) ? 'partial' : 'completed',
        baseUrl, repository, project: saved.project, countUnit: 'records', applied, skipped, results };
    },
  };
}

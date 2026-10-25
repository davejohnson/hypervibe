import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CommandContext } from './context.js';
import { HvError } from './results.js';
import { CloudHttpError, cloudAccessRejected, createCloudJsonClient } from './cloud-http.js';
import { createHypervibeCloudPairingClient, normalizeHypervibeCloudBaseUrl } from './cloud-pairing.js';
import { cloudSecretSetupSchema, cloudSecretSetupReceiptSchema, secretSetupServiceAccountSchema, type CloudSecretSetup } from './cloud-secret-setup-contract.js';
import { findRepoRoot, readRepoSpecFile } from '../domain/spec/repo-spec-file.js';
import { detectGitRemoteUrl, normalizeGitRemoteIdentity, resolveGitHeadCommitSha } from '../lib/git-remote.js';
import { currentWorkspaceDirectories, primaryWorkspaceDirectory } from '../lib/workspace-context.js';
import { assertPendingSourceBranch, resolveCloudSourceBranch, sourceBranchSchema } from './cloud-source-branch.js';
import { canonicalizeJson } from '../lib/canonical-json.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { projectSpecSchema } from '../domain/spec/spec.schema.js';
import { CLOUD_INSTALLATION_REASONS } from '../domain/ports/cloud-installation.port.js';
import { secretDestinationSchema } from '../domain/ports/secret-destination.port.js';

const PROVIDER = 'hypervibe-secret-destinations';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown) => JSON.stringify(canonicalizeJson(value));
const writerSchema = z.object({ serviceAccountEmail: secretSetupServiceAccountSchema, uniqueId: z.string().regex(/^\d{1,30}$/) }).strict();
const browserSource = z.object({ branch: sourceBranchSchema, revision: z.string().regex(/^[a-f0-9]{40}$/), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const browserMode = z.enum(['connect', 'migrate']);
const browserKeys = z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).min(1).max(16).refine(keys => new Set(keys).size === keys.length);
// Deliberately project only value-free device fields. Browser review also has
// installation details and administrator invitations; those are not agent data.
const browserConnection = z.object({ id: z.string().guid(), mode: browserMode.default('connect'),
  status: z.enum(['choose-provider', 'authorization-required', 'review-required', 'pending', 'blocked', 'scope-ready', 'source-required', 'ready', 'cancelled', 'disconnecting', 'disconnected']),
  provider: z.enum(['aws', 'azure', 'gcp']).nullable(), keys: browserKeys, environment: z.string(), source: browserSource,
  expiresAt: z.string().datetime(), connectUrl: z.string().url(), deployment: z.literal('not-authorized'),
  destinations: z.array(z.object({ key: z.string(), destination: secretDestinationSchema }).strict()).max(16).optional(),
  acceptedSource: browserSource.omit({ branch: true }).optional(),
  reason: z.enum(CLOUD_INSTALLATION_REASONS).optional(),
  scopePreparation: z.object({ installationId: z.string().guid(),
    status: z.enum(['review-required', 'pending', 'blocked', 'scope-ready']),
    reason: z.enum(CLOUD_INSTALLATION_REASONS).optional() }).optional(),
});
const browserInstallation = z.object({ id: z.string().guid(), mode: browserMode.default('connect'), keys: browserKeys, source: browserSource, pending: z.boolean(),
  acceptance: z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();
const archivedInstallation = browserInstallation.extend({ terminalStatus: z.enum(['cancelled', 'disconnected']), archivedAt: z.string().datetime() }).strict();
const stateSchema = z.object({
  version: z.literal(1), baseUrl: z.string(), repository: z.string(), env: z.string(), sourceBranch: sourceBranchSchema,
  status: z.enum(['pending', 'verified', 'revoked']), expiresAt: z.string().datetime(),
  deviceCode: z.string().optional(), userCode: z.string().optional(), verificationUrl: z.string().url().optional(), token: z.string().optional(),
  project: z.object({ id: z.string(), name: z.string() }).strict().optional(),
  environment: z.object({ id: z.string(), key: z.string(), name: z.string() }).strict().optional(),
  preview: z.object({ id: z.string().guid(), fingerprint: z.string(), expiresAt: z.string().datetime(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), writerIdentity: writerSchema.optional(),
  }).strict().optional(),
  installation: browserInstallation.optional(),
  installationHistory: z.array(archivedInstallation).max(100).optional(),
}).strict();
type State = z.infer<typeof stateSchema>;
export interface CloudSecretSetupInput {
  action?: 'discover' | 'start' | 'status' | 'preview' | 'prepare' | 'connect' | 'revoke' | 'accept-source';
  browser?: boolean; keys?: string[]; mode?: 'connect' | 'migrate';
  env?: string; sourceBranch?: string; baseUrl?: string; previewId?: string; confirm?: boolean; adminAuth?: 'default';
  provider?: string; credentialsRef?: string; credentialKind?: string; connectionId?: string;
}

export function createCloudSecretSetups({ context, fetchImpl = fetch, directory = primaryWorkspaceDirectory, now = () => new Date() }: {
  context: CommandContext; fetchImpl?: typeof fetch; directory?: () => string; now?: () => Date;
}) {
  function checkoutIdentity(input: CloudSecretSetupInput) {
    const roots = currentWorkspaceDirectories() ?? [directory()];
    const root = findRepoRoot(directory());
    const repository = root && normalizeGitRemoteIdentity(detectGitRemoteUrl(root) ?? undefined);
    if (!root || !repository?.startsWith('github.com/') || roots.some(dir => findRepoRoot(dir) !== root))
      throw new HvError('VALIDATION', 'Use one matching GitHub checkout for this device’s setup access.');
    if (!input.env || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.env))
      throw new HvError('VALIDATION', 'Select the exact environment for this device’s setup access.');
    return { root, repository: repository.slice('github.com/'.length), env: input.env };
  }
  function checkout(input: CloudSecretSetupInput) {
    const { root, repository, env } = checkoutIdentity(input);
    const document = readRepoSpecFile(root);
    if (!document || (document.spec.gitRemoteUrl && normalizeGitRemoteIdentity(document.spec.gitRemoteUrl) !== `github.com/${repository}`))
      throw new HvError('VALIDATION', 'Use one matching GitHub checkout and its reviewed Hypervibe spec.');
    if (!document.spec.environments[env])
      throw new HvError('VALIDATION', 'Select one declared environment for secret-manager setup.');
    const file = path.join(root, '.hypervibe/spec.json');
    const revision = resolveGitHeadCommitSha(root, file);
    const branch = resolveCloudSourceBranch(root, input.sourceBranch);
    if (!revision || !sourceBranchSchema.safeParse(branch).success)
      throw new HvError('VALIDATION', 'Commit the destination declarations and use their reviewed source branch before connecting a secret manager.');
    const targets = Object.entries(document.spec.environments[env].secretDestinations ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, slot]) => ({ key, destination: slot.destination, ...(slot.version ? { version: slot.version } : {}) }));
    if (!targets.length && input.action !== 'discover' && !input.browser) throw new HvError('VALIDATION', 'Discover and declare separate secretDestinations for this environment with hv_spec before connecting its manager.');
    return { root, spec: document.spec, repository, env,
      source: { branch: branch!, revision, digest: hash(readFileSync(file)) }, targets };
  }
  function save(scope: string, value: State) {
    const record = context.repos.connections.upsert({ provider: PROVIDER, scope, credentialsEncrypted: context.secretStore.encryptObject(value) });
    if (value.status === 'verified') context.repos.connections.updateStatus(record.id, 'verified');
    return record.credentialsEncrypted;
  }
  const summary = (state: State) => ({ status: state.status, baseUrl: state.baseUrl, repository: state.repository, env: state.env,
    sourceBranch: state.sourceBranch, expiresAt: state.expiresAt,
    ...(state.status === 'pending' ? { userCode: state.userCode, verificationUrl: state.verificationUrl } : {}) });

  async function revoke(input: CloudSecretSetupInput) {
    // Removing access does not authorize new infrastructure work. Keep the
    // exact repository/origin/environment boundary without requiring its old
    // deployment source to remain present, committed, or on the same branch.
    const identity = checkoutIdentity(input);
    const baseUrl = normalizeHypervibeCloudBaseUrl(input.baseUrl);
    const scope = `${baseUrl}|${identity.repository}|${identity.env}`;
    const stored = context.repos.connections.findByProviderAndScope(PROVIDER, scope);
    if (!stored) throw new HvError('VALIDATION', 'No setup access is stored for this exact repository, origin and environment.');
    let access: State;
    try { access = stateSchema.parse(context.secretStore.decryptObject(stored.credentialsEncrypted)); }
    catch { throw new HvError('VALIDATION', 'Stored secret-manager setup access cannot be read safely.'); }
    if (access.baseUrl !== baseUrl || access.repository !== identity.repository || access.env !== identity.env
      || access.status !== 'verified' || !access.token)
      throw new HvError('VALIDATION', 'Stored setup access does not match this exact repository, origin and environment.');
    if (!input.confirm) throw new HvError('CONFIRM_REQUIRED', 'Confirm removing this device’s setup access. Existing cloud resources and grants are retained.');
    const forget = () => {
      const latest = context.repos.connections.findByProviderAndScope(PROVIDER, scope);
      if (!latest) return;
      try {
        if (stateSchema.parse(context.secretStore.decryptObject(latest.credentialsEncrypted)).token === access.token) {
          if (access.installation) save(scope, { ...access, status: 'revoked', expiresAt: now().toISOString(),
            token: undefined, deviceCode: undefined, userCode: undefined, verificationUrl: undefined, preview: undefined });
          else context.repos.connections.delete(latest.id);
        }
      } catch { /* Replaced or unreadable access must not be removed. */ }
    };
    if (canonical(checkoutIdentity(input)) !== canonical(identity)
      || context.repos.connections.findByProviderAndScope(PROVIDER, scope)?.credentialsEncrypted !== stored.credentialsEncrypted)
      throw new HvError('VALIDATION', 'The selected checkout or setup access changed before revocation.');
    let receipt: unknown;
    try { receipt = await createCloudJsonClient(baseUrl, fetchImpl, 30_000)('/api/v1/secret-destination-access', { method: 'DELETE', token: access.token }); }
    catch (error) { if (cloudAccessRejected(error)) forget(); throw error; }
    const result = z.object({ applied: z.literal(1), skipped: z.literal(0) }).strict().safeParse(receipt);
    if (!result.success) throw new HvError('PROVIDER_ERROR', 'Hypervibe returned an invalid revocation receipt.');
    forget();
    return { status: 'revoked', baseUrl, repository: identity.repository, env: identity.env, ...result.data };
  }

  return { async run(input: CloudSecretSetupInput) {
    if (input.credentialsRef || input.credentialKind || input.connectionId || input.provider)
      throw new HvError('VALIDATION', 'Secret-manager setup uses reviewed destinations and identity delegation, never deployment credential uploads.');
    const action = input.action ?? 'preview';
    if (input.browser && !['start', 'status', 'preview', 'connect', 'accept-source', 'revoke'].includes(action))
      throw new HvError('VALIDATION', 'Connect Cloud uses browser installation. Start device access, then connect, inspect status, or accept the committed destination patch.');
    if (!input.browser && (input.mode || input.keys || action === 'accept-source')) throw new HvError('VALIDATION', 'Use purpose="connect-cloud" for browser installation.');
    if (input.adminAuth && action !== 'prepare') throw new HvError('VALIDATION', 'Use adminAuth only for the reviewed writer preparation step.');
    if (action === 'revoke') return revoke(input);
    const local = checkout(input);
    if (action === 'discover') {
      const desired = local.spec.environments[local.env];
      const supported = providerRegistry.getMetadata(desired.hosting.provider)?.secretDestinationSetupProviders ?? [];
      if (!supported.length) throw new HvError('VALIDATION', 'This hosting provider does not support automatic secret-manager setup yet.');
      const keys = Object.entries(local.spec.secrets).filter(([key, secret]) => secret.environments.includes(local.env)
        && !Object.hasOwn(desired.secretDestinations ?? {}, key)).map(([key]) => key).sort();
      if (!keys.length) return { status: 'declared', env: local.env, destinationTargets: local.targets, nextSteps: [] };
      if (keys.length + local.targets.length > 100) throw new HvError('VALIDATION', 'Prepare at most 100 secret destinations per environment.');
      const project = context.resolveProjectOrThrow({ project: local.spec.project });
      const result = await context.adapterFactory.getProviderAdapter(desired.hosting.provider, project, undefined, local.env);
      const driver = result.success ? result.adapter?.secretDestinationSetup : undefined;
      if (!driver) throw new HvError('VALIDATION', 'Connect this project’s hosting provider before discovering secret destinations.');
      const environment = context.repos.environments.findByProjectAndName(project.id, local.env)
        ?? { platformBindings: { provider: desired.hosting.provider } };
      const discovered = await driver.discover(environment, { repository: `github.com/${local.repository.toLowerCase()}`, environment: local.env, keys });
      if (discovered.state !== 'known') throw new HvError('PROVIDER_ERROR', 'The connected cloud project could not be verified for destination discovery.');
      const destinations = z.record(z.string(), secretDestinationSchema).safeParse(discovered.destinations);
      if (!destinations.success || canonical(Object.keys(destinations.data).sort()) !== canonical(keys)
        || Object.values(destinations.data).some(destination => !supported.includes(destination.provider)))
        throw new HvError('PROVIDER_ERROR', 'The provider returned an invalid destination proposal.');
      const proposal = { ...desired.secretDestinations, ...Object.fromEntries(Object.entries(destinations.data).map(([key, destination]) => [key, { destination }])) };
      if (!projectSpecSchema.safeParse({ ...local.spec, environments: { ...local.spec.environments, [local.env]: { ...desired, secretDestinations: proposal } } }).success)
        throw new HvError('VALIDATION', 'The proposed destinations conflict with the reviewed project scope. Existing declarations are preserved.');
      // Arrays keep value-free destination metadata visible without relaxing the
      // command envelope's protection of fields named API_KEY, PASSWORD, etc.
      return { status: 'review_required', env: local.env, repository: local.repository,
        destinationTargets: Object.entries(proposal).map(([key, slot]) => ({ key, ...slot, status: keys.includes(key) ? 'proposed' : 'preserved' })),
        nextStep: { command: 'hv_spec', instruction: 'Set this environment’s secretDestinations from the reviewed destinationTargets, preserving existing versions. Commit the spec, then start secret-manager setup approval.' } };
    }
    const baseUrl = normalizeHypervibeCloudBaseUrl(input.baseUrl);
    const scope = `${baseUrl}|${local.repository}|${local.env}`;
    const stored = context.repos.connections.findByProviderAndScope(PROVIDER, scope);
    let expectedCipher = stored?.credentialsEncrypted;
    const assertCurrentState = () => {
      const latest = context.repos.connections.findByProviderAndScope(PROVIDER, scope);
      if (latest?.credentialsEncrypted !== expectedCipher)
        throw new HvError('VALIDATION', 'This device’s setup access or preview changed during the request. Inspect the current setup before continuing.');
    };
    const saveCurrent = (value: State) => { assertCurrentState(); expectedCipher = save(scope, value); };
    let saved: State | undefined;
    if (stored) {
      try { saved = stateSchema.parse(context.secretStore.decryptObject(stored.credentialsEncrypted)); }
      catch { throw new HvError('VALIDATION', 'Stored secret-manager setup access cannot be read safely.'); }
      if (saved.baseUrl !== baseUrl || saved.repository !== local.repository || saved.env !== local.env)
        throw new HvError('VALIDATION', 'Stored setup access belongs to another repository or environment.');
    }
    const active = saved && saved.status !== 'revoked' && Date.parse(saved.expiresAt) > now().getTime();
    if (active) assertPendingSourceBranch(local.source.branch, saved!.sourceBranch);
    function forget(field: 'token' | 'deviceCode', value: string) {
      const latest = context.repos.connections.findByProviderAndScope(PROVIDER, scope);
      if (!latest) return;
      try {
        const current = stateSchema.parse(context.secretStore.decryptObject(latest.credentialsEncrypted));
        if (current[field] === value) {
          if (current.installation) expectedCipher = save(scope, { ...current, status: 'revoked', expiresAt: now().toISOString(),
            token: undefined, deviceCode: undefined, userCode: undefined, verificationUrl: undefined, preview: undefined });
          else { context.repos.connections.delete(latest.id); expectedCipher = undefined; }
        }
      }
      catch { /* Unreadable or replaced state must not be erased. */ }
    }
    const rawRequest = createCloudJsonClient(baseUrl, fetchImpl, 30_000);
    const request: typeof rawRequest = async (pathname, options = {}) => {
      try { assertCurrentState(); const result = await rawRequest(pathname, options); assertCurrentState(); return result; }
      catch (error) { if (options.token && cloudAccessRejected(error)) forget('token', options.token); throw error; }
    };
    async function inspect(access: State): Promise<CloudSecretSetup> {
      if (!access.token || !access.project || !access.environment || Date.parse(access.expiresAt) <= now().getTime())
        throw new HvError('VALIDATION', 'Start a new secret-manager setup approval.');
      const parsed = cloudSecretSetupSchema.safeParse(await request(`/api/v1/projects/${encodeURIComponent(access.project.id)}/secret-destination-setups`, { method: 'GET', token: access.token }));
      if (!parsed.success) throw new HvError('PROVIDER_ERROR', 'Hypervibe returned an invalid secret-manager setup response.');
      const current = checkout(input);
      const remote = parsed.data;
      const observed = remote.destinations.map(({ key, destination, version }) => ({ key, destination, ...(version ? { version } : {}) })).sort((a, b) => a.key.localeCompare(b.key));
      if (remote.project.id !== access.project.id || remote.project.repository.toLowerCase() !== current.repository.toLowerCase()
        || remote.environment.id !== access.environment.id || remote.environment.key !== current.env
        || canonical(remote.source) !== canonical(current.source)
        || canonical(observed) !== canonical(current.targets) || new Set(observed.map(item => item.key)).size !== observed.length)
        throw new HvError('VALIDATION', 'Hosted setup differs from this exact repository, environment, source or destination. Review the current committed setup before continuing.');
      return remote;
    }
    async function browserView(access: State, supplied?: unknown) {
      if (!access.token || !access.project || !access.installation) throw new HvError('VALIDATION', 'Start this environment’s cloud connection first.');
      const endpoint = `/api/v1/projects/${encodeURIComponent(access.project.id)}/cloud-connections/${access.installation.id}`;
      const raw = supplied ?? await request(endpoint, { method: 'GET', token: access.token });
      const result = z.object({ connection: browserConnection }).safeParse(raw);
      if (!result.success) throw new HvError('PROVIDER_ERROR', 'The hosted cloud connection returned an invalid value-free receipt.');
      const remote = result.data.connection;
      const expectedUrl = new URL(`/apps/${encodeURIComponent(access.project.id)}/cloud-connections/${access.installation.id}`, baseUrl).toString();
      if (remote.mode !== access.installation.mode || remote.id !== access.installation.id || remote.environment !== local.env || canonical(remote.keys.slice().sort()) !== canonical(access.installation.keys)
        || canonical(remote.source) !== canonical(access.installation.source) || remote.connectUrl !== expectedUrl
        || remote.destinations && (remote.destinations.length !== remote.keys.length || new Set(remote.destinations.map(slot => slot.key)).size !== remote.keys.length
          || remote.destinations.some(slot => !remote.keys.includes(slot.key))))
        throw new HvError('PROVIDER_ERROR', 'The hosted cloud connection receipt differs from the exact reviewed app, environment, source or targets.');
      const nextStep = remote.status === 'scope-ready' ? { command: 'hv_cloud_connections',
        instruction: 'Open this connection’s browser link to review the next setup step in the verified cloud project. Scope preparation does not authorize collection or deployment.' }
        : remote.status === 'source-required' && remote.mode === 'migrate' ? { command: 'hv_cloud_connections',
        instruction: 'Use purpose="connect-cloud" action="accept-source" to approve the reviewed writer switch. Preserve the committed destinations and immutable versions.' }
        : remote.status === 'source-required' ? { command: 'hv_spec',
        instruction: 'Apply only these value-free destinations to this environment, preserving all other settings and secret ownership. Commit the spec, then use hv_cloud_connections purpose="connect-cloud" action="accept-source".' }
        : remote.status === 'ready' ? { command: 'hv_cloud_requests', instruction: 'Authorize collection separately, then request only eligible missing inputs from the current plan.' } : undefined;
      return { status: remote.status, connection: remote, ...(nextStep ? { nextStep } : {}) };
    }
    const pairing = createHypervibeCloudPairingClient({ baseUrl, fetchImpl, grant: { purpose: 'secret-destinations', environment: local.env } });
    if (action === 'start') {
      if (saved?.installation && saved.installation.source.branch !== local.source.branch)
        throw new HvError('VALIDATION', 'Reconnect from the installation’s original source branch to preserve its exact recovery history.');
      if (active && saved?.status === 'pending') return summary(saved);
      if (active && saved?.status === 'verified') {
        if (input.browser) return saved.installation ? browserView(saved) : summary(saved);
        try { await inspect(saved); return summary(saved); } catch (error) { if (!cloudAccessRejected(error)) throw error; }
      }
      const started = await pairing.start(local.repository, local.source.branch);
      saved = { version: 1, status: 'pending', baseUrl, repository: local.repository, env: local.env, sourceBranch: local.source.branch, installation: saved?.installation, installationHistory: saved?.installationHistory,
        deviceCode: started.deviceCode, userCode: started.userCode, verificationUrl: started.verificationUrl, expiresAt: started.expiresAt };
      saveCurrent(saved); return summary(saved);
    }
    if (!active || !saved) throw new HvError('VALIDATION', 'Start a separate browser approval for secret-manager setup in this environment.');
    if (saved.status === 'pending') {
      if (action !== 'status' || !saved.deviceCode) throw new HvError('VALIDATION', 'Approve secret-manager setup in the browser, then check status.');
      let exchange;
      try { exchange = await pairing.exchange(saved.deviceCode); }
      catch (error) { if (error instanceof CloudHttpError && error.status >= 400 && error.status < 500 && error.status !== 429) forget('deviceCode', saved.deviceCode); throw error; }
      if (exchange.status === 'pending') return { ...summary(saved), retryAfterSeconds: exchange.retryAfterSeconds };
      const credential = exchange.credentials[0]!;
      if (!credential.expiresAt || Date.parse(credential.expiresAt) <= now().getTime() || Date.parse(credential.expiresAt) > now().getTime() + 31 * 86400_000)
        throw new HvError('PROVIDER_ERROR', 'Hypervibe returned invalid setup access expiry.');
      saved = { version: 1, status: 'verified', baseUrl, repository: local.repository, env: local.env, sourceBranch: saved.sourceBranch,
        project: exchange.project, environment: credential.environment, token: credential.token, expiresAt: credential.expiresAt, installation: saved.installation, installationHistory: saved.installationHistory };
      saveCurrent(saved); return summary(saved);
    }
    if (!saved.token || !saved.project) throw new HvError('VALIDATION', 'Start a new secret-manager setup approval.');
    if (input.browser) {
      if (action === 'status' || action === 'preview') return saved.installation ? browserView(saved) : summary(saved);
      if (action === 'accept-source') {
        const current = await browserView(saved);
        if (current.status === 'ready') {
          if (canonical(current.connection.acceptedSource) !== canonical({ revision: local.source.revision, digest: local.source.digest }))
            throw new HvError('VALIDATION', 'This local commit is not the accepted destination source.');
          return current;
        }
        if (current.status !== 'source-required' || !current.connection.destinations || !saved.installation)
          throw new HvError('VALIDATION', 'The exact installation must finish before accepting its committed destination patch.');
        for (const slot of current.connection.destinations) {
          const declared = local.spec.environments[local.env].secretDestinations?.[slot.key];
          if (!declared || current.connection.mode !== 'migrate' && declared.version || canonical(declared.destination) !== canonical(slot.destination))
            throw new HvError('VALIDATION', 'Commit the exact proposed native destinations without introducing values or versions.');
        }
        if (saved.installation.acceptance) return { ...current, status: 'pending',
          message: 'The source-acceptance result is uncertain. Its exact historical status was checked; no acceptance was sent again.' };
        saved.installation.acceptance = { revision: local.source.revision, digest: local.source.digest };
        saveCurrent(saved);
        let response: unknown;
        try {
          response = await request(`/api/v1/projects/${encodeURIComponent(saved.project.id)}/cloud-connections/${saved.installation.id}/source-acceptances`, {
            method: 'POST', token: saved.token, body: { expectedSourceRevision: local.source.revision, expectedSourceDigest: local.source.digest },
          });
        } catch (error) {
          // Only the server's definite transaction rejection releases this
          // attempt. Preserve ambiguous writes and any concurrently revoked grant.
          if (error instanceof CloudHttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
            const latest = context.repos.connections.findByProviderAndScope(PROVIDER, scope);
            if (latest && latest.credentialsEncrypted === expectedCipher) {
              const currentState = stateSchema.parse(context.secretStore.decryptObject(latest.credentialsEncrypted));
              if (currentState.installation?.id === saved.installation.id
                && canonical(currentState.installation.acceptance) === canonical(saved.installation.acceptance)) {
                delete currentState.installation.acceptance; expectedCipher = save(scope, currentState);
              }
            }
          }
          throw error;
        }
        const accepted = await browserView(saved, response);
        if (accepted.status !== 'ready' || canonical(accepted.connection.acceptedSource) !== canonical(saved.installation.acceptance))
          throw new HvError('PROVIDER_ERROR', 'The exact source acceptance could not be confirmed. Inspect status before continuing.');
        return accepted;
      }
      let archive: z.infer<typeof archivedInstallation> | undefined;
      if (saved.installation) {
        const previous = await browserView(saved);
        if (action !== 'connect' || !['cancelled', 'disconnected'].includes(previous.status)) {
          if (input.mode && input.mode !== saved.installation.mode) throw new HvError('VALIDATION', 'Resume the existing cloud connection in its original mode.');
          return previous;
        }
        // Only an exact terminal server receipt permits a new intent. Cancellation
        // preserves any partial cloud installation in the server's original journal;
        // it is not a claim that hosted trust or stored secrets were removed.
        if ((saved.installationHistory?.length ?? 0) >= 100)
          throw new HvError('VALIDATION', 'This device has reached its retained cloud-connection history limit. Preserve its recovery records before preparing another connection.');
        archive = archivedInstallation.parse({ ...saved.installation, terminalStatus: previous.status, archivedAt: now().toISOString() });
      }
      const desired = local.spec.environments[local.env];
      const reconnectsTargets = archive && archive.keys.every(key => desired.secretDestinations?.[key]);
      const mode = input.mode ?? (reconnectsTargets ? 'migrate' : 'connect');
      const keys = browserKeys.parse(input.keys ?? (reconnectsTargets && mode === 'migrate' ? archive?.keys : undefined) ?? Object.entries(local.spec.secrets)
        .filter(([key, slot]) => slot.ownership === 'delegated' && slot.environments.includes(local.env) && (mode === 'migrate' ? !!desired.secretDestinations?.[key] : !desired.secretDestinations?.[key]))
        .map(([key]) => key)).sort();
      if (keys.some(key => !local.spec.secrets[key]?.environments.includes(local.env) || (mode === 'migrate' ? !desired.secretDestinations?.[key] : !!desired.secretDestinations?.[key])))
        throw new HvError('VALIDATION', 'Select declared environment secrets matching this mode: connect prepares missing destinations; migrate preserves existing destinations and reviews a writer replacement.');
      if (archive) saved.installationHistory = [...(saved.installationHistory ?? []), archive];
      saved.installation = { id: randomUUID(), mode, keys, source: local.source, pending: true };
      // Save before POST. A timeout can only read this ID; it cannot send another installation.
      saveCurrent(saved);
      const response = await request(`/api/v1/projects/${encodeURIComponent(saved.project.id)}/cloud-connections`, {
        method: 'POST', token: saved.token, body: { connectionId: saved.installation.id, mode, keys,
          expectedSourceRevision: local.source.revision, expectedSourceDigest: local.source.digest },
      });
      const view = await browserView(saved, response);
      if (canonical(checkout(input).source) !== canonical(local.source)) throw new HvError('VALIDATION', 'The local source changed during connection setup. The historical request is retained.');
      saved.installation.pending = false; saveCurrent(saved);
      return view;
    }
    const remote = await inspect(saved);
    const selected = remote.destinations.filter(item => !item.version);
    const fingerprint = hash(canonical({ source: remote.source, host: remote.host, targets: local.targets }));
    const setupCall = (action: string) => ({ command: 'hv_cloud_connections', input: { purpose: 'secret-destinations', env: local.env, baseUrl, action } });
    const connected = selected.every(item => item.status === 'connected');
    const blocked = selected.length > 0 && (remote.host.status !== 'ready' || !remote.host.serviceAccountEmail || selected.some(item => item.destination.provider !== 'gcp-secret-manager' || ['unsupported', 'blocked'].includes(item.status)));
    const publicView = { baseUrl, repository: local.repository, env: local.env, source: remote.source, host: remote.host,
      destinationTargets: remote.destinations.map(({ key, destination, version, status }) => ({ key, destination, ...(version ? { version } : {}), status })) };
    if (action === 'status') return { ...publicView, status: blocked ? 'blocked' : selected.every(item => item.status === 'connected') ? 'connected' : 'setup_required' };
    if (action === 'preview') {
      saved.preview = { id: randomUUID(), fingerprint, expiresAt: new Date(now().getTime() + 600_000).toISOString() };
      saveCurrent(saved);
      return { ...publicView, previewId: saved.preview.id, status: blocked ? 'blocked' : selected.every(item => item.status === 'connected') ? 'connected' : 'setup_required',
        nextSteps: blocked || connected ? [] : [
          { command: 'hv_plan', input: { project: local.spec.project, env: local.env, scope: 'secret-destinations' } },
          { ...setupCall('prepare'), input: { ...setupCall('prepare').input, previewId: saved.preview.id, adminAuth: 'default' } },
        ] };
    }
    if (!saved.preview || input.previewId !== saved.preview.id || saved.preview.fingerprint !== fingerprint || Date.parse(saved.preview.expiresAt) <= now().getTime())
      throw new HvError('CONFIRM_REQUIRED', 'Preview the current exact secret-manager setup first, then use that previewId.');
    if (blocked) throw new HvError('VALIDATION', 'Secret-manager setup is blocked by hosted identity, unsupported provider or destination readiness.');
    if (connected) return { ...publicView, status: 'connected', applied: 0, skipped: selected.length,
      nextStep: { command: 'hv_cloud_requests', input: { action: 'authorize', env: local.env, baseUrl } } };
    const gcp = selected.map(item => item.destination).filter(item => item.provider === 'gcp-secret-manager');
    if (!gcp.length) return { ...publicView, status: 'connected', applied: 0, skipped: remote.destinations.length };
    if (new Set(gcp.map(item => `${item.projectId}|${item.projectNumber}`)).size !== 1)
      throw new HvError('VALIDATION', 'Review one Google Cloud project per environment for writer setup.');
    const expected = fingerprint;
    const authority = saved;
    const project = context.resolveProjectOrThrow({ project: local.spec.project });
    const assertContainers = async (keys = selected.map(item => item.key)) => {
      const current = checkout(input);
      const environment = context.repos.environments.findByProjectAndName(project.id, local.env);
      if (!environment) throw new HvError('VALIDATION', 'Plan and apply the empty secret containers before preparing writer permissions.');
      const { assertReadySecretContainers } = await import('../domain/services/secret-container-setup.js');
      try { await assertReadySecretContainers({ project, spec: current.spec, environment, keys }); }
      catch { throw new HvError('VALIDATION', 'The exact owned secret containers are not ready. Review hv_plan with scope="secret-destinations" before writer setup.'); }
      assertCurrentState();
    };
    const beforeWrite = async (target?: { secretId?: string }) => {
      const keys = target?.secretId ? selected.filter(item => item.destination.provider === 'gcp-secret-manager'
        && item.destination.secretId === target.secretId).map(item => item.key) : selected.map(item => item.key);
      await assertContainers(keys);
      const current = await inspect(authority);
      if (hash(canonical({ source: current.source, host: current.host, targets: checkout(input).targets })) !== expected)
        throw new HvError('VALIDATION', 'Setup authority changed before the cloud write. Review a new preview.');
      return current;
    };
    if (action === 'prepare') {
      if (input.confirm && (!saved.preview.planDigest || input.adminAuth !== 'default'))
        throw new HvError('CONFIRM_REQUIRED', 'Review the writer permission plan first, then confirm it with adminAuth="default".');
      await assertContainers();
      const { runGcpSecretWriterPrepare } = await import('../domain/services/gcp-secret-writer.prepare.js');
      const result = await runGcpSecretWriterPrepare({ project,
        environmentName: local.env, repository: local.repository, sourceRevision: remote.source.revision, sourceDigest: remote.source.digest,
        projectId: gcp[0].projectId, projectNumber: gcp[0].projectNumber, hostServiceAccountEmail: remote.host.serviceAccountEmail!,
        secretIds: gcp.map(item => item.secretId).sort(), confirm: input.confirm, expectedPlanDigest: saved.preview.planDigest,
        retainedSecretIds: remote.destinations.filter(item => item.version).map(item => item.destination)
          .flatMap(item => item.provider === 'gcp-secret-manager' && item.projectId === gcp[0].projectId && item.projectNumber === gcp[0].projectNumber ? [item.secretId] : []).sort(),
        adminAuth: input.adminAuth, beforeWrite: async target => { await beforeWrite(target); } });
      if (result.success) {
        saved.preview.planDigest = result.planDigest;
        if (result.writerIdentity) saved.preview.writerIdentity = writerSchema.parse(result.writerIdentity);
        saveCurrent(saved);
      }
      return { ...publicView, status: !result.success ? 'blocked' : input.confirm ? 'prepared' : 'confirmation_required',
        previewId: saved.preview.id, preparation: result,
        ...(result.success ? { nextStep: { ...setupCall(input.confirm ? 'connect' : 'prepare'), input: { ...setupCall(input.confirm ? 'connect' : 'prepare').input,
          previewId: saved.preview.id, confirm: true, ...(!input.confirm ? { adminAuth: 'default' } : {}) } } } : {}) };
    }
    if (!input.confirm || !saved.preview.writerIdentity) throw new HvError('CONFIRM_REQUIRED', 'Prepare the reviewed writer identity first, then confirm connecting it.');
    const results: z.infer<typeof cloudSecretSetupReceiptSchema>['results'] = [];
    let applied = 0, skipped = 0, outcome: 'confirmed' | 'unknown' = 'confirmed';
    let reason: 'admission_blocked' | undefined;
    for (const item of selected) {
      let current: CloudSecretSetup;
      try { current = await beforeWrite(item.destination.provider === 'gcp-secret-manager' ? { secretId: item.destination.secretId } : undefined); }
      catch (error) {
        if (!results.length) throw error;
        reason = 'admission_blocked'; break;
      }
      if (current.destinations.find(row => row.key === item.key)?.status === 'connected') {
        results.push({ key: item.key, status: 'already_connected' }); skipped++; continue;
      }
      let receipt: unknown;
      try {
        receipt = await request(`/api/v1/projects/${encodeURIComponent(saved.project.id)}/secret-destination-setups`, {
          method: 'POST', token: saved.token, body: { expectedSourceRevision: remote.source.revision, expectedSourceDigest: remote.source.digest,
            expectedHostServiceAccountEmail: remote.host.serviceAccountEmail,
            connections: [{ key: item.key, serviceAccountEmail: saved.preview.writerIdentity.serviceAccountEmail }] },
        });
      } catch { outcome = 'unknown'; break; }
      const result = cloudSecretSetupReceiptSchema.safeParse(receipt);
      if (!result.success || result.data.projectId !== saved.project.id || result.data.environmentId !== saved.environment!.id
        || result.data.sourceRevision !== remote.source.revision || result.data.sourceDigest !== remote.source.digest
        || result.data.results.length !== 1 || result.data.results[0].key !== item.key
        || result.data.applied !== result.data.results.filter(row => row.status === 'connected').length
        || result.data.skipped !== result.data.results.filter(row => row.status === 'already_connected').length) { outcome = 'unknown'; break; }
      applied += result.data.applied; skipped += result.data.skipped; results.push(...result.data.results);
      if (result.data.results[0].status === 'failed') break;
    }
    const complete = outcome === 'confirmed' && results.length === selected.length && results.every(row => row.status !== 'failed');
    return { ...publicView, applied, skipped, results, outcome, ...(reason ? { reason } : {}), status: complete ? 'connected' : 'partial',
      pendingKeys: selected.filter(item => !results.some(row => row.key === item.key && row.status !== 'failed')).map(item => item.key),
      nextStep: complete ? { command: 'hv_cloud_requests', input: { action: 'authorize', env: local.env, baseUrl } } : setupCall('status') };
  } };
}

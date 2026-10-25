import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CommandContext } from './context.js';
import { HvError } from './results.js';
import { CloudHttpError, cloudAccessRejected, createCloudJsonClient } from './cloud-http.js';
import { createHypervibeCloudPairingClient, normalizeHypervibeCloudBaseUrl } from './cloud-pairing.js';
import { DEPLOYMENT_ACCESS_PROVIDER, DEPLOYMENT_BINDING_PROVIDER, deploymentBindingSchema, deploymentBindingScope,
  deploymentGrantSchema, deploymentGrantScope, deploymentIdentity, deploymentSource, parseDeploymentReceipt, revokeMatchingDeploymentGrant, saveDeploymentState,
  type DeploymentBinding, type DeploymentGrant } from '../adapters/cloud/deployment-access.client.js';
import { CLOUD_INSTALLATION_REASONS } from '../domain/ports/cloud-installation.port.js';

const browser = z.object({ id: z.string().guid(), purpose: z.literal('deployment'), mode: z.literal('connect'),
  status: z.enum(['choose-provider', 'authorization-required', 'review-required', 'pending', 'blocked', 'ready', 'cancelled', 'disconnecting', 'disconnected']),
  provider: z.enum(['aws', 'azure', 'gcp']).nullable(), keys: z.array(z.never()).max(0), environment: z.string(),
  source: deploymentBindingSchema.shape.source, expiresAt: z.string().datetime(), connectUrl: z.string().url(),
  deployment: z.enum(['not-authorized', 'provision-approved']), reason: z.enum(CLOUD_INSTALLATION_REASONS).optional(),
});
const policySummary = z.object({ id: z.string().guid(), status: z.enum(['review-required', 'approved', 'superseded', 'revoked']), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export interface CloudDeploymentsInput { action?: string; env?: string; sourceBranch?: string; baseUrl?: string; confirm?: boolean;
  provider?: string; credentialsRef?: string; credentialKind?: string; connectionId?: string; previewId?: string; workflowPath?: string; }
export function createCloudDeployments({ context, fetchImpl = fetch }: { context: CommandContext; fetchImpl?: typeof fetch }) {
  const store = { connections: context.repos.connections, secretStore: context.secretStore };
  return { async run(input: CloudDeploymentsInput) {
    const action = input.action ?? 'status';
    if (!['start', 'status', 'preview', 'connect', 'propose-release', 'revoke'].includes(action) || !input.env || input.provider || input.credentialsRef || input.credentialKind || input.connectionId || input.previewId
      || input.workflowPath && action !== 'propose-release') {
      throw new HvError('VALIDATION', 'Deployment access uses an exact environment and separate browser approval. Cloud keys and native identity overrides are not accepted.');
    }
    if (action === 'revoke') {
      const identity = deploymentIdentity(input.env), baseUrl = normalizeHypervibeCloudBaseUrl(input.baseUrl);
      const scope = deploymentGrantScope(baseUrl, identity.repository, identity.env);
      const row = store.connections.findByProviderAndScope(DEPLOYMENT_ACCESS_PROVIDER, scope);
      if (!row) throw new HvError('VALIDATION', 'No deployment device access exists for this exact scope.');
      let access: DeploymentGrant;
      try { access = deploymentGrantSchema.parse(store.secretStore.decryptObject(row.credentialsEncrypted)); }
      catch { throw new HvError('VALIDATION', 'Stored deployment authority could not be read safely.'); }
      if (access.baseUrl !== baseUrl || access.repository !== identity.repository || access.env !== identity.env || access.status !== 'verified' || !access.token) throw new HvError('VALIDATION', 'No verified deployment device access exists for this exact scope.');
      if (!input.confirm) throw new HvError('CONFIRM_REQUIRED', 'Confirm removing only this device’s deployment access. Cloud trust, resources and runtime access remain separately authorized.');
      const current = () => {
        const retained = store.connections.findById(row.id);
        if (retained?.credentialsEncrypted !== row.credentialsEncrypted || retained.status !== row.status || !isDeepStrictEqual(deploymentIdentity(identity.env), identity)) throw new HvError('VALIDATION', 'Deployment authority changed before revocation completed.');
      };
      const forget = () => {
        current(); saveDeploymentState(store, DEPLOYMENT_ACCESS_PROVIDER, scope, { ...access, status: 'revoked', token: undefined, expiresAt: new Date().toISOString() }, row.credentialsEncrypted, row.status);
      };
      current(); let response: unknown;
      try { response = await createCloudJsonClient(baseUrl, fetchImpl, 30_000)('/api/v1/deployment-access', { method: 'DELETE', token: access.token }); }
      catch (error) { if (cloudAccessRejected(error)) forget(); throw error; }
      const receipt = z.object({ applied: z.literal(1), skipped: z.literal(0) }).strict().safeParse(response);
      if (!receipt.success) throw new HvError('PROVIDER_ERROR', 'Hypervibe returned an invalid deployment revocation receipt.');
      forget(); return { status: 'revoked', baseUrl, repository: identity.repository, env: identity.env, ...receipt.data };
    }
    const identity = deploymentIdentity(input.env);
    const baseUrl = normalizeHypervibeCloudBaseUrl(input.baseUrl);
    const accessScope = deploymentGrantScope(baseUrl, identity.repository, identity.env), bindingScope = deploymentBindingScope(identity.repository, identity.env);
    let accessRow = store.connections.findByProviderAndScope(DEPLOYMENT_ACCESS_PROVIDER, accessScope);
    let bindingRow = store.connections.findByProviderAndScope(DEPLOYMENT_BINDING_PROVIDER, bindingScope);
    let grant: DeploymentGrant | undefined, binding: DeploymentBinding | undefined;
    try {
      grant = accessRow ? deploymentGrantSchema.parse(store.secretStore.decryptObject(accessRow.credentialsEncrypted)) : undefined;
      binding = bindingRow ? deploymentBindingSchema.parse(store.secretStore.decryptObject(bindingRow.credentialsEncrypted)) : undefined;
    } catch { throw new HvError('VALIDATION', 'Stored deployment authority could not be read safely.'); }
    if (grant && (grant.baseUrl !== baseUrl || grant.repository !== identity.repository || grant.env !== identity.env)
      || binding && (binding.baseUrl !== baseUrl || binding.repository !== identity.repository || binding.env !== identity.env)) {
      throw new HvError('VALIDATION', 'This environment already has deployment authority from a different exact origin or repository.');
    }
    const historical = (action === 'status' || action === 'preview') && binding && grant?.status === 'verified';
    if (historical && input.sourceBranch !== undefined && input.sourceBranch !== binding!.source.branch)
      throw new HvError('VALIDATION', 'Historical status cannot change the saved deployment branch.');
    // Recovery reads the exact saved source/installation. It neither adopts the
    // checkout nor authorizes native sessions for a different or dirty source.
    const local = historical
      ? { ...identity, source: binding!.source, hostingProvider: binding!.hostingProvider }
      : (() => { const current = deploymentSource(input.env!, identity.repository, input.sourceBranch);
        return { ...current, hostingProvider: current.spec.environments[current.env].hosting.provider }; })();
    const assertCurrent = () => {
      const currentAccess = store.connections.findByProviderAndScope(DEPLOYMENT_ACCESS_PROVIDER, accessScope), currentBinding = store.connections.findByProviderAndScope(DEPLOYMENT_BINDING_PROVIDER, bindingScope);
      if (currentAccess?.credentialsEncrypted !== accessRow?.credentialsEncrypted || currentAccess?.status !== accessRow?.status
        || currentBinding?.credentialsEncrypted !== bindingRow?.credentialsEncrypted || currentBinding?.status !== bindingRow?.status
        || !isDeepStrictEqual(deploymentIdentity(identity.env), identity)
        || !historical && !isDeepStrictEqual(deploymentSource(local.env, local.repository, input.sourceBranch).source, local.source)) {
        throw new HvError('VALIDATION', 'Deployment access, source or connection changed during this request. Inspect current status before continuing.');
      }
    };
    const saveGrant = (next: DeploymentGrant) => {
      assertCurrent(); accessRow = saveDeploymentState(store, DEPLOYMENT_ACCESS_PROVIDER, accessScope, next, accessRow?.credentialsEncrypted ?? null, accessRow?.status ?? null); grant = next;
    };
    const saveBinding = (next: DeploymentBinding) => {
      assertCurrent(); bindingRow = saveDeploymentState(store, DEPLOYMENT_BINDING_PROVIDER, bindingScope, next, bindingRow?.credentialsEncrypted ?? null, bindingRow?.status ?? null); binding = next;
    };
    const summary = (value: DeploymentGrant) => ({ status: value.status, baseUrl, repository: local.repository, env: local.env, sourceBranch: value.sourceBranch, expiresAt: value.expiresAt,
      ...(value.status === 'pending' ? { verificationUrl: value.verificationUrl, userCode: value.userCode } : {}) });
    const raw = createCloudJsonClient(baseUrl, fetchImpl, 30_000);
    const request: typeof raw = async (pathname, options = {}) => {
      assertCurrent();
      try { const result = await raw(pathname, options); assertCurrent(); return result; }
      catch (error) {
        if (options.token && cloudAccessRejected(error) && grant && accessRow) {
          if (binding) {
            const revoked = revokeMatchingDeploymentGrant(store, binding, grant, accessRow.credentialsEncrypted);
            if (revoked) { accessRow = revoked; grant = deploymentGrantSchema.parse(store.secretStore.decryptObject(revoked.credentialsEncrypted)); }
          }
          else saveGrant({ ...grant, status: 'revoked', token: undefined, expiresAt: new Date().toISOString() });
        }
        throw error;
      }
    };
    const pairing = createHypervibeCloudPairingClient({ baseUrl, fetchImpl, grant: { purpose: 'deployment-access', environment: local.env } });
    async function view(supplied?: unknown) {
      if (!grant?.token || !grant.project || accessRow?.status !== 'verified' || bindingRow?.status === 'failed'
        || !binding || binding.projectId !== grant.project.id) throw new HvError('VALIDATION', 'Connect this environment before checking installation.');
      const rawView = supplied ?? await request(`/api/v1/projects/${encodeURIComponent(binding.projectId)}/cloud-deployments/${binding.connectionId}`, { method: 'GET', token: grant.token });
      const parsed = z.object({ connection: browser, deploymentConnection: z.unknown().optional(), releasePolicies: z.array(policySummary).max(16).optional() }).safeParse(rawView);
      if (!parsed.success) throw new HvError('PROVIDER_ERROR', 'Hypervibe returned invalid deployment connection evidence.');
      const remote = parsed.data.connection;
      if (remote.id !== binding.connectionId || remote.environment !== local.env || !isDeepStrictEqual(remote.source, binding.source)
        || remote.connectUrl !== new URL(`/apps/${encodeURIComponent(binding.projectId)}/cloud-connections/${binding.connectionId}`, baseUrl).toString()
        || (remote.status === 'ready') !== (remote.deployment === 'provision-approved')) throw new HvError('PROVIDER_ERROR', 'Deployment evidence belongs to a different approved scope.');
      if (remote.status === 'ready') {
        const receipt = parseDeploymentReceipt(parsed.data.deploymentConnection);
        if (JSON.stringify(receipt).includes(grant.token)) throw new HvError('PROVIDER_ERROR', 'Deployment receipt contains credential material and was rejected.');
        if (receipt.appId !== binding.projectId || receipt.environment !== local.env || receipt.provider !== remote.provider
          || receipt.source.repository !== local.repository || receipt.source.branch !== binding.source.branch
          || receipt.source.revision !== binding.source.revision || receipt.source.specDigest !== binding.source.digest
          || receipt.hostingProvider !== binding.hostingProvider
          || binding.receipt && !isDeepStrictEqual(binding.receipt, receipt)) throw new HvError('PROVIDER_ERROR', 'Deployment identity evidence changed or differs from the exact app, environment and reviewed source.');
        saveBinding({ ...binding, status: 'ready', receipt });

      } else if (parsed.data.deploymentConnection !== undefined) throw new HvError('PROVIDER_ERROR', 'Unready deployment installation cannot return native access evidence.');
      if (binding!.releasePolicy) {
        const retained = binding!.releasePolicy;
        let historical: unknown;
        try { historical = await request(`/api/v1/projects/${encodeURIComponent(binding!.projectId)}/cloud-deployments/${binding!.connectionId}/release-policies/${retained.id}`, { method: 'GET', token: grant.token }); }
        catch (error) { if (!(error instanceof CloudHttpError) || error.status !== 404) throw error; }
        const observed = historical === undefined ? undefined : z.object({ policy: policySummary }).strict().safeParse(historical);
        if (observed && (!observed.success || observed.data.policy.id !== retained.id || retained.digest && observed.data.policy.digest !== retained.digest))
          throw new HvError('PROVIDER_ERROR', 'The exact release policy evidence changed or could not be verified.');
        const next = observed?.success ? observed.data.policy : retained.status === 'pending' ? {} : { status: 'unavailable' as const };
        saveBinding({ ...binding!, releasePolicy: { ...retained, ...next } });
      }
      return { status: remote.status, connection: remote, ...(binding!.releasePolicy ? { releasePolicy: { id: binding!.releasePolicy.id, status: binding!.releasePolicy.status, ...(binding!.releasePolicy.digest ? { digest: binding!.releasePolicy.digest } : {}) } } : {}),
        ...(remote.status === 'ready' ? { nextStep: { command: 'hv_plan', instruction: 'This receipt describes the saved installation. Planning and deployment still require its approved branch and exact committed source; inspecting it does not authorize applying infrastructure changes.' } } : {}) };
    }
    const active = grant?.status === 'verified' && accessRow?.status === 'verified' && Date.parse(grant.expiresAt) > Date.now();
    if (action === 'start') {
      if (grant && accessRow?.status !== 'failed' && Date.parse(grant.expiresAt) > Date.now() && grant.status !== 'revoked') {
        if (grant.sourceBranch !== local.source.branch) throw new HvError('VALIDATION', 'Deployment access already has a different source branch.');
        if (grant.status === 'pending') return summary(grant);
        if (binding) { try { return await view(); } catch (error) { if (!cloudAccessRejected(error)) throw error; } }
        else return summary(grant);
      }
      assertCurrent(); const started = await pairing.start(local.repository.slice('github.com/'.length), local.source.branch); assertCurrent();
      saveGrant({ version: 1, status: 'pending', baseUrl, repository: local.repository, env: local.env, sourceBranch: local.source.branch,
        deviceCode: started.deviceCode, userCode: started.userCode, verificationUrl: started.verificationUrl, expiresAt: started.expiresAt });
      return summary(grant!);
    }
    if (grant?.status === 'pending' && accessRow?.status === 'pending' && Date.parse(grant.expiresAt) > Date.now() && action === 'status' && grant.deviceCode) {
      if (grant.sourceBranch !== local.source.branch) throw new HvError('VALIDATION', 'The deployment approval source branch changed.');
      let exchange;
      try { exchange = await pairing.exchange(grant.deviceCode); assertCurrent(); }
      catch (error) {
        if (error instanceof CloudHttpError && error.status >= 400 && error.status < 500 && error.status !== 429) saveGrant({ ...grant, status: 'revoked', deviceCode: undefined });
        throw error;
      }
      if (exchange.status === 'pending') return { ...summary(grant), retryAfterSeconds: exchange.retryAfterSeconds };
      const access = exchange.credentials[0];
      if (!access?.expiresAt || Date.parse(access.expiresAt) <= Date.now() || Date.parse(access.expiresAt) > Date.now() + 31 * 86400_000) throw new HvError('PROVIDER_ERROR', 'Hypervibe returned invalid deployment access expiry.');
      if (binding && binding.projectId !== exchange.project.id) throw new HvError('PROVIDER_ERROR', 'Deployment approval belongs to another app.');
      saveGrant({ version: 1, status: 'verified', baseUrl, repository: local.repository, env: local.env, sourceBranch: grant.sourceBranch,
        project: exchange.project, environment: access.environment, token: access.token, expiresAt: access.expiresAt });
      return summary(grant!);
    }
    if (!active || !grant?.token || !grant.project || grant.environment?.key !== local.env || grant.sourceBranch !== local.source.branch) throw new HvError('VALIDATION', 'Start a separate deployment browser approval for this environment.');
    if (action === 'propose-release') {
      const current = await view();
      if (binding?.status !== 'ready' || !binding.receipt || current.status !== 'ready') throw new HvError('VALIDATION', 'Finish deployment installation and publish the managed workflow before requesting release approval.');
      if (binding.releasePolicy && (binding.releasePolicy.status === 'pending' || isDeepStrictEqual(binding.releasePolicy.source, local.source) && binding.releasePolicy.workflowPath === input.workflowPath)) return current;
      saveBinding({ ...binding, releasePolicy: { id: randomUUID(), source: local.source, status: 'pending', ...(input.workflowPath ? { workflowPath: input.workflowPath } : {}) } });
      const pending = binding!.releasePolicy!;
      const response = await request(`/api/v1/projects/${encodeURIComponent(binding!.projectId)}/cloud-deployments/${binding!.connectionId}/release-policies`, {
        token: grant.token, body: { policyId: pending.id, expectedSourceRevision: pending.source.revision, expectedSourceDigest: pending.source.digest,
          ...(pending.workflowPath ? { workflowPath: pending.workflowPath } : {}) } });
      const result = z.object({ applied: z.union([z.literal(0), z.literal(1)]), skipped: z.union([z.literal(0), z.literal(1)]),
        policy: policySummary.extend({ receipt: z.unknown().optional() }), connectUrl: z.string().url() }).safeParse(response);
      if (!result.success || result.data.applied + result.data.skipped !== 1 || result.data.policy.id !== pending.id
        || result.data.connectUrl !== current.connection.connectUrl) throw new HvError('PROVIDER_ERROR', 'Hypervibe returned invalid release-policy evidence. Inspect status to recover the exact saved request.');
      const { id, status, digest } = result.data.policy;
      saveBinding({ ...binding!, releasePolicy: { ...pending, id, status, digest } });
      return { status: current.status, connection: current.connection, releasePolicy: { id, status, digest }, connectUrl: result.data.connectUrl,
        nextStep: { instruction: 'An app owner must review and approve this exact release policy in the browser. Device provisioning access does not approve CI releases.' } };
    }
    if (action === 'status' || action === 'preview' || binding) return binding ? view() : summary(grant);
    saveBinding({ version: 1, baseUrl, repository: local.repository, env: local.env, projectId: grant.project.id, connectionId: randomUUID(), source: local.source,
      hostingProvider: local.hostingProvider, status: 'pending' });
    const result = await request(`/api/v1/projects/${encodeURIComponent(grant.project.id)}/cloud-deployments`, { token: grant.token,
      body: { connectionId: binding!.connectionId, expectedSourceRevision: local.source.revision, expectedSourceDigest: local.source.digest } });
    return view(result);
  } };
}

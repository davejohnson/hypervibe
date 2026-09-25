import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { hashEnvValue, type ObservedState } from '../../ports/observe.port.js';
import { SendGridAdapter } from '../../../adapters/providers/sendgrid/sendgrid.adapter.js';
import { planInboundSigning, observeInboundSigning } from '../email-inbound-signing.service.js';
import { adapterFactory } from '../adapter.factory.js';
import { inspectWebhookReadiness } from '../webhook-readiness.service.js';
import { resolvePlanActionAuthority } from '../../plan/action-authority.js';
import { recordRuntimeRolloutRequirements } from '../runtime-rollout.service.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { environmentSpecSchema, SENDGRID_INBOUND_PUBLIC_KEY as KEY } from '../../spec/spec.schema.js';
import { applyEmailAction } from '../email-apply.service.js';
import { emailInboundConfigHash, EMAIL_OPERATIONS, planEmail, resolveEmailIntegrationState } from '../email-plan.service.js';

// Reconstructed documented attached setting; not a recorded response.
// https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks
const hostname = 'inbound.example.com';
const policyId = 'dd677638-a16d-4e19-95ea-20231c35511b';
const oldUrl = 'https://api.example.com/old';
const newUrl = 'https://api.example.com/new';
const spec = () => environmentSpecSchema.parse({domain: 'example.com', hosting: {provider: 'railway'}, services: {api: {workloadKind: 'web', public: true}},
  email: {enabled: true, inbound: {hostname, service: 'api', path: '/new'}}});

describe('Inbound Parse policy preservation through the real client', () => {
  let dir: string;
  let project: ReturnType<ProjectRepository['create']>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-inbound-signing-'));
    SqliteAdapter.resetInstance(); initializeDatabase(path.join(dir, 'test.db'));
    project = new ProjectRepository().create({name: 'inbound-app', defaultPlatform: 'railway'});
    new EnvironmentRepository().create({projectId: project.id, name: 'production', platformBindings: {
      provider: 'railway', projectId: 'project-id', environmentId: 'production-id', services: {api: {serviceId: 'api-id', url: 'https://api.example.com'}},
    }});
    const connection = new ConnectionRepository().create({provider: 'sendgrid', credentialsEncrypted: getSecretStore().encryptObject({apiKey: 'test-only-key'})});
    new ConnectionRepository().updateStatus(connection.id, 'verified');
  });
  afterEach(() => {vi.restoreAllMocks(); SqliteAdapter.resetInstance(); fs.rmSync(dir, {recursive: true, force: true});});

  it.each(['full', 'read-update'])('never deletes and recreates a signed route with %s permission', async access => {
    let setting = {hostname, url: oldUrl, spam_check: true, send_raw: false, security_policy: policyId};
    const mutations: Array<{method: string; pathname: string; body: unknown}> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/v3/scopes') return Response.json({scopes: access === 'read-update' ? ['user.webhooks.parse.settings.read', 'user.webhooks.parse.settings.update'] : ['user.webhooks.parse.settings.read', 'user.webhooks.parse.settings.create', 'user.webhooks.parse.settings.update', 'user.webhooks.parse.settings.delete']});
      if (init?.method !== 'GET') {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        mutations.push({method: init!.method!, pathname, body});
        if (init?.method === 'DELETE') return new Response(null, {status: 204});
        if (init?.method === 'POST') setting = body; // Legacy replacement loses security_policy.
        if (init?.method === 'PATCH') setting = {...setting, ...body};
      }
      return Response.json(pathname.endsWith('/settings') && init?.method === 'GET' ? {result: [setting]} : setting);
    });
    const desired = spec();
    const action = {id: `email:sendgrid:inbound:${hostname}`, type: 'replace' as const, resource: {kind: 'email' as const, name: hostname, provider: 'sendgrid'},
      reason: 'Update inbound path', verified: true, requiresConfirm: true, metadata: {expectedPolicyId: policyId, operation: EMAIL_OPERATIONS.inboundReplace, hostname, service: 'api', path: '/new', aliases: [], spamCheck: true, sendRaw: false, expectedUrl: newUrl, configHash: emailInboundConfigHash(desired)}};
    const result = await applyEmailAction({project, environmentName: 'production', environmentSpec: desired, action, confirmedActionIds: new Set([action.id])});
    expect(result.success).toBe(true);
    expect(mutations).toEqual([{method: 'PATCH', pathname: '/v3/user/webhooks/parse/settings/' + hostname,
      body: {url: newUrl, spam_check: true, send_raw: false, security_policy: policyId}}]);
    expect(setting.security_policy).toBe(policyId);
  });
});

it('preserves explicit inbound verification intent in the declarative spec', () => {
  const input = spec();
  const result = environmentSpecSchema.safeParse({...input, email: {...input.email, inbound: {...input.email.inbound, signatureVerification: true}}});
  expect(result.success).toBe(true);
  if (result.success) expect(result.data.email.inbound).toHaveProperty('signatureVerification', true);
});


// Public example key from the official Inbound Parse security guide. Synthetic hosting state.
const publicKey = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmgmjvPAR/Lmwn2teL2WJUDIx35PqsnLKjPhPbrKkfMg6vK4NZQB1VeFSKbV7whQbEJRFHjF8+1zJxsXRP1GbWw==';
const desiredSigning = () => {const result = spec(); result.email.inbound!.signatureVerification = true; return result;};
describe('Inbound signed-policy key lifecycle', () => {
  let dir: string;
  let project: ReturnType<ProjectRepository['create']>;
  let envId: string;
  let route: {hostname: string; url: string; spam_check: boolean; send_raw: boolean; security_policy?: string};
  let key: string;
  let runtimeValue: string | undefined;
  let unknownHosting: boolean;
  let deploymentId: string;
  let adapter: SendGridAdapter;
  let setEnv: ReturnType<typeof vi.fn>;
  let providerMutations: string[];
  let scopes: string[];
  const environment = () => new EnvironmentRepository().findById(envId)!;
  const observed = (): ObservedState => ({provider: 'railway', projectId: 'project-id', environmentId: 'production-id', projectExists: true,
    observedAt: new Date().toISOString(), partial: unknownHosting, warnings: [], databases: [], services: [{name: 'api', externalId: 'api-id', workloadKind: 'web',
      customDomains: [], config: {}, status: 'running', deployment: {id: deploymentId}, envVarKeys: runtimeValue ? [KEY] : [], envVarHashes: runtimeValue ? {[KEY]: hashEnvValue(runtimeValue)} : {}}]});
  const plan = async (desired = desiredSigning()) => planInboundSigning({spec: desired, environment: environment(), observed: observed(), state: await observeInboundSigning(adapter, hostname), routeReady: true});
  const apply = (action: ReturnType<typeof planInboundSigning>['actions'][number], confirm = true, desired = desiredSigning()) => applyEmailAction({
    project, environmentName: 'production', environmentSpec: desired, action, confirmedActionIds: confirm ? new Set([action.id]) : undefined});
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-inbound-key-'));
    SqliteAdapter.resetInstance(); initializeDatabase(path.join(dir, 'test.db'));
    project = new ProjectRepository().create({name: 'inbound-app', defaultPlatform: 'railway'});
    new ServiceRepository().create({projectId: project.id, name: 'api'});
    envId = new EnvironmentRepository().create({projectId: project.id, name: 'production', platformBindings: {
      provider: 'railway', projectId: 'project-id', environmentId: 'production-id', services: {api: {serviceId: 'api-id', url: 'https://api.example.com'}},
      email: {inbound: {hostname, configHash: emailInboundConfigHash(desiredSigning()), url: newUrl}},
    }}).id;
    const connection = new ConnectionRepository().create({provider: 'sendgrid', credentialsEncrypted: getSecretStore().encryptObject({apiKey: 'test-only-key'})});
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    adapter = new SendGridAdapter(); adapter.connect({apiKey: 'test-only-key'});
    key = publicKey; route = {hostname, url: newUrl, spam_check: true, send_raw: false, security_policy: policyId}; runtimeValue = undefined; unknownHosting = false; deploymentId = 'before'; providerMutations = [];
    scopes = ['user.webhooks.parse.settings.read'];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (init?.method !== 'GET') {providerMutations.push(pathname); throw new Error('unexpected provider write');}
      if (pathname === '/v3/scopes') return Response.json({scopes});
      if (pathname === '/v3/whitelabel/domains') return Response.json([]);
      if (pathname === '/v3/user/webhooks/parse/settings') return Response.json({result: [route]});
      if (pathname === '/v3/user/webhooks/parse/settings/' + hostname) return Response.json(route);
      if (pathname === '/v3/user/webhooks/security/policies/' + route.security_policy) return Response.json({policy: {id: route.security_policy, name: 'documented policy', signature: {public_key: key}, oauth: {client_id: 'test-client', token_url: 'https://oauth.example.com/token'}}});
      throw new Error('Unexpected request ' + pathname);
    });
    setEnv = vi.fn(async (_env, _service, values) => {runtimeValue = values[KEY]; return {success: true, message: 'written'};});
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({success: true, adapter: {observe: vi.fn(async () => observed()), setEnvVars: setEnv} as never});
  });
  afterEach(() => {vi.restoreAllMocks(); SqliteAdapter.resetInstance(); fs.rmSync(dir, {recursive: true, force: true});});

  it('confirms adoption and publishes only the observed key, preserving shared/OAuth policies', async () => {
    const first = await plan(); const action = first.actions[0];
    expect(action).toMatchObject({type: 'update', requiresConfirm: true});
    expect(resolvePlanActionAuthority(action)).toBeTruthy();
    expect(JSON.stringify(first)).not.toContain(publicKey);
    expect((await apply(action, false)).success).toBe(false);
    expect((await apply({...action, requiresConfirm: false})).success).toBe(false);
    expect(setEnv).not.toHaveBeenCalled();
    expect((await apply(action)).success).toBe(true);
    expect(setEnv).toHaveBeenCalledWith(expect.objectContaining({id: envId}), expect.objectContaining({name: 'api'}), {[KEY]: publicKey});
    expect(providerMutations).toEqual([]);
    expect(JSON.stringify(environment().platformBindings)).not.toContain(publicKey);
    const next = await plan(); expect(next.actions[0].type).toBe('noop');
    expect(inspectWebhookReadiness({environmentSpec: desiredSigning(), environment: environment(), observed: observed(), inboundSigningReadiness: next.readiness}))
      .toMatchObject({status: 'configured', applicationVerification: 'not_verified', webhooks: [{providerSigning: 'enabled', signingMaterial: {key: KEY, status: 'present'}}]});
    vi.mocked(fetch).mockClear(); setEnv.mockClear();
    expect((await apply(next.actions[0])).success).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); expect(setEnv).not.toHaveBeenCalled();
  });
  it('reports unknown missing associations and blocks speculative creation', async () => {
    delete route.security_policy;
    const result = await plan(); expect(result.actions[0].metadata?.blockedReason).toMatch(/could not be verified/);
    expect(result.readiness?.providerSigning).toBe('unknown');
    expect((await apply(result.actions[0])).success).toBe(false); expect(setEnv).not.toHaveBeenCalled(); expect(providerMutations).toEqual([]);
  });
  it.each(['create', 'update'] as const)('blocks unsigned route creation through a %s action when verification requires an existing signed policy', async actionType => {
    scopes = ['read', 'create', 'update', 'delete'].map(scope => 'user.webhooks.parse.settings.' + scope);
    const desired = desiredSigning(); desired.email.inbound!.hostname = 'new.example.com';
    const result = await planEmail({project, environmentName: 'production', environment: environment(), environmentSpec: desired, observed: observed()});
    const action = result.actions.find(item => item.id === 'email:sendgrid:inbound:new.example.com')!;
    expect(action.metadata?.blockedReason).toMatch(/existing signed/i);
    expect((await apply(action, true, desired)).success).toBe(false);
    const {blockedReason: _blocked, ...metadata} = action.metadata!;
    expect(await apply({...action, type: actionType, metadata}, true, desired)).toMatchObject({success: false, status: 'blocked', message: expect.stringMatching(/existing signed/i)});
    expect(providerMutations).toEqual([]); expect(setEnv).not.toHaveBeenCalled();
  });
  it('preserves the policy and key when disabling or removing managed intent', async () => {
    await apply((await plan()).actions[0]); setEnv.mockClear();
    const disabled = desiredSigning(); disabled.email.inbound!.signatureVerification = false;
    const omitted = spec();
    for (const desired of [disabled, omitted, environmentSpecSchema.parse({hosting: {provider: 'railway'}, services: {api: {workloadKind: 'web'}}, email: {enabled: false}})]) {
      const result = await plan(desired); expect(result.actions[0].metadata?.blockedReason).toBeTruthy();
      expect((await apply(result.actions[0], true, desired)).success).toBe(false);
    }
    expect(setEnv).not.toHaveBeenCalled(); expect(providerMutations).toEqual([]); expect(runtimeValue).toBe(publicKey);
  });
  it('detects runtime drift without rotating the provider policy', async () => {
    await apply((await plan()).actions[0]); runtimeValue = 'stale value';
    const drift = await plan(); expect(drift.readiness?.keyWiring).toBe('drifted'); expect(drift.actions[0].requiresConfirm).toBe(true);
    expect((await apply(drift.actions[0])).success).toBe(true); expect(providerMutations).toEqual([]);
  });
  it('blocks partial and masked hosting observations and absent local environments', async () => {
    unknownHosting = true; expect((await plan()).actions[0].metadata?.blockedReason).toMatch(/unknown/);
    unknownHosting = false; runtimeValue = publicKey; const obs = observed(); obs.services[0].envVarHashes = {};
    expect(planInboundSigning({spec: desiredSigning(), environment: environment(), observed: obs, state: await observeInboundSigning(adapter, hostname), routeReady: true}).actions[0].metadata?.blockedReason).toMatch(/unknown/);
    expect(planInboundSigning({spec: desiredSigning(), environment: null, observed: null, routeReady: true}).actions[0].metadata?.blockedReason).toMatch(/HTTPS/);
  });
  it('blocks a changed policy or route between planning and apply', async () => {
    const action = (await plan()).actions[0]; route.security_policy = 'different-policy';
    expect((await apply(action)).success).toBe(false); expect(setEnv).not.toHaveBeenCalled();
    route.security_policy = policyId; route.url = oldUrl;
    expect((await apply(action)).success).toBe(false); expect(setEnv).not.toHaveBeenCalled();
  });
  it('blocks changed hosting identity even when the URL stays the same', async () => {
    const action = (await plan()).actions[0];
    new EnvironmentRepository().updatePlatformBindings(envId, {services: {api: {serviceId: 'different-id', url: 'https://api.example.com'}}});
    expect((await apply(action)).success).toBe(false); expect(setEnv).not.toHaveBeenCalled();
  });
  it('recovers a committed hosting write whose receipt or binding persistence failed', async () => {
    setEnv.mockImplementationOnce(async (_env, _service, values) => {runtimeValue = values[KEY]; throw new Error('echo ' + publicKey);});
    const failed = await apply((await plan()).actions[0]); expect(failed.success).toBe(false); expect(JSON.stringify(failed)).not.toContain(publicKey);
    expect(await apply((await plan()).actions[0])).toMatchObject({success: false, status: 'pending'});
    expect((await plan()).readiness?.status).not.toBe('configured');
    deploymentId = 'after-reviewed-deployment';
    new EnvironmentRepository().updatePlatformBindings(envId, {services: {api: {
      ...((environment().platformBindings.services as Record<string, Record<string, unknown>>).api), imageUri: 'registry.example.com/app@sha256:new-image',
    }}});
    expect((await apply((await plan()).actions[0])).success).toBe(true); expect(setEnv).toHaveBeenCalledTimes(1);
    runtimeValue = undefined;
    const action = (await plan()).actions[0];
    const save = EnvironmentRepository.prototype.updatePlatformBindings;
    let saves = 0;
    vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockImplementation(function (this: EnvironmentRepository, ...args) {
      if (++saves === 3) throw new Error('disk unavailable'); // Intent and acknowledgement persisted; completion failed.
      return save.apply(this, args);
    });
    expect((await apply(action)).success).toBe(false);
    expect((await apply((await plan()).actions[0])).success).toBe(true); expect(setEnv).toHaveBeenCalledTimes(2);
  });
  it('retains rollout evidence', async () => {
    setEnv.mockImplementationOnce(async (_env, _service, values) => {runtimeValue = values[KEY]; return {success: true, message: 'written', data: {runtimeRolloutRequired: true, rolloutBaseline: {state: 'present', deploymentId: 'before'}}};});
    expect(await apply((await plan()).actions[0])).toMatchObject({success: true, data: {runtimeRolloutRequired: true, rolloutBaselines: {api: {state: 'present', deploymentId: 'before'}}}});
  });
  it('adopts an already matching key without a hosting write', async () => {
    runtimeValue = publicKey;
    expect((await plan()).actions[0]).toMatchObject({type: 'update', requiresConfirm: true});
    expect((await apply((await plan()).actions[0])).success).toBe(true);
    expect(setEnv).not.toHaveBeenCalled();
    expect((await plan()).actions[0].type).toBe('noop');
  });
  it('replays acknowledged rollout evidence after delayed key observation without another write', async () => {
    setEnv.mockImplementationOnce(async (_env, _service, values) => {
      runtimeValue = values[KEY]; unknownHosting = true;
      return {success: true, message: 'written', data: {runtimeRolloutRequired: true, rolloutBaseline: {state: 'present', deploymentId: 'before'}}};
    });
    expect(await apply((await plan()).actions[0])).toMatchObject({success: false, status: 'pending'});
    unknownHosting = false;
    const next = await plan(); expect(next.actions[0].type).toBe('update');
    expect(await apply(next.actions[0])).toMatchObject({success: true, data: {runtimeRolloutRequired: true, rolloutBaselines: {api: {state: 'present', deploymentId: 'before'}}}});
    expect(setEnv).toHaveBeenCalledTimes(1);
  });
  it('does not write a key when ownership intent cannot be persisted', async () => {
    const action = (await plan()).actions[0];
    vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockImplementationOnce(() => {throw new Error('disk unavailable');});
    expect((await apply(action)).success).toBe(false);
    expect(setEnv).not.toHaveBeenCalled();
  });
  it('keeps lost acknowledgement persistence pending until a new running deployment is observed', async () => {
    const action = (await plan()).actions[0];
    const save = EnvironmentRepository.prototype.updatePlatformBindings;
    let saves = 0;
    vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockImplementation(function (this: EnvironmentRepository, ...args) {
      if (++saves === 2) throw new Error('acknowledgement journal unavailable');
      return save.apply(this, args);
    });
    setEnv.mockImplementationOnce(async (_env, _service, values) => {
      runtimeValue = values[KEY];
      return {success: true, message: 'written', data: {runtimeRolloutRequired: true, rolloutBaseline: {state: 'present', deploymentId: 'before'}}};
    });
    expect((await apply(action)).success).toBe(false);
    expect(await apply((await plan()).actions[0])).toMatchObject({success: false, status: 'pending'});
    expect(setEnv).toHaveBeenCalledTimes(1);
    deploymentId = 'after-reviewed-deployment';
    expect((await apply((await plan()).actions[0])).success).toBe(true);
    expect(setEnv).toHaveBeenCalledTimes(1);
  });
  it('preserves acknowledged rollout evidence when the final binding save fails', async () => {
    const action = (await plan()).actions[0];
    const save = EnvironmentRepository.prototype.updatePlatformBindings;
    let saves = 0;
    vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockImplementation(function (this: EnvironmentRepository, ...args) {
      if (++saves === 3) return null;
      return save.apply(this, args);
    });
    setEnv.mockImplementationOnce(async (_env, _service, values) => {
      runtimeValue = values[KEY];
      return {success: true, message: 'written', data: {runtimeRolloutRequired: true, rolloutBaseline: {state: 'present', deploymentId: 'before'}}};
    });
    expect((await apply(action)).success).toBe(false);
    expect(await apply((await plan()).actions[0])).toMatchObject({success: true, data: {runtimeRolloutRequired: true, rolloutBaselines: {api: {state: 'present', deploymentId: 'before'}}}});
    expect(setEnv).toHaveBeenCalledTimes(1);
  });
  it('replays rollout evidence if the outer apply lost the successful action receipt', async () => {
    const action = (await plan()).actions[0];
    setEnv.mockImplementationOnce(async (_env, _service, values) => {
      runtimeValue = values[KEY];
      return {success: true, message: 'written', data: {runtimeRolloutRequired: true, rolloutBaseline: {state: 'present', deploymentId: 'before'}}};
    });
    expect((await apply(action)).success).toBe(true);
    // Simulate a crash after this action, before the outer apply saves rollout requirements.
    const recovery = (await plan()).actions[0]; expect(recovery.type).toBe('update');
    const recovered = await apply(recovery);
    expect(recovered).toMatchObject({success: true, data: {runtimeRolloutRequired: true}});
    recordRuntimeRolloutRequirements({environment: environment(), provider: 'railway', observed: observed(), actions: [recovery],
      receipts: [{actionId: recovery.id, status: 'succeeded', message: recovered.message, data: recovered.data}], applyRunId: 'recovery-run'});
    expect((await plan()).actions[0].type).toBe('noop');
    expect(setEnv).toHaveBeenCalledTimes(1);
  });
  it('routes shared planning and fresh fingerprints through real provider reads', async () => {
    const desired = desiredSigning();
    const result = await planEmail({project, environmentName: 'production', environment: environment(), environmentSpec: desired, observed: observed()});
    const action = result.actions.find(item => item.id === 'email:sendgrid:inbound-key')!;
    expect(action).toMatchObject({type: 'update', requiresConfirm: true});
    expect((await apply(action)).success).toBe(true);
    expect((await resolveEmailIntegrationState({project, environment: environment(), environmentSpec: desired})).inboundSigning).toMatchObject({status: 'known', policy: {id: policyId}});
    const next = await planEmail({project, environmentName: 'production', environment: environment(), environmentSpec: desired, observed: observed()});
    expect(next.inboundSigningReadiness?.status).toBe('configured');
    expect(JSON.stringify(next)).not.toContain(publicKey);
  });
  it('isolates a second environment and rejects spoofed action authority', async () => {
    const action = (await plan()).actions[0];
    new EnvironmentRepository().create({projectId: project.id, name: 'staging', platformBindings: {...environment().platformBindings, environmentId: 'staging-id'}});
    expect((await applyEmailAction({project, environmentName: 'staging', environmentSpec: desiredSigning(), action, confirmedActionIds: new Set([action.id])})).success).toBe(false);
    expect((await apply({...action, resource: {...action.resource, provider: 'foreign-provider'}})).success).toBe(false);
    expect(setEnv).not.toHaveBeenCalled(); expect(providerMutations).toEqual([]);
  });
  it('reserves the public-key role from ordinary env configuration', () => {
    const desired = desiredSigning();
    expect(environmentSpecSchema.safeParse({...desired, envVars: {[KEY]: 'manual'}}).success).toBe(false);
    expect(environmentSpecSchema.safeParse({...desired, removeEnvVars: [KEY]}).success).toBe(false);
  });
  it('records alias-only intent without changing the signed provider route', async () => {
    const desired = desiredSigning(); desired.email.inbound!.aliases = ['support'];
    const result = await planEmail({project, environmentName: 'production', environment: environment(), environmentSpec: desired, observed: observed()});
    const action = result.actions.find(item => item.id === 'email:sendgrid:inbound:' + hostname)!;
    expect(action.metadata?.operation).toBe(EMAIL_OPERATIONS.inboundAdopt);
    expect((await apply(action, true, desired)).success).toBe(true);
    expect(providerMutations).toEqual([]);
  });
  it('blocks a managed target move before an ordinary inbound action can write', async () => {
    await apply((await plan()).actions[0]);
    const desired = desiredSigning(); desired.email.inbound!.hostname = 'other.example.com';
    const result = await planEmail({project, environmentName: 'production', environment: environment(), environmentSpec: desired, observed: observed()});
    const action = result.actions.find(item => item.id === 'email:sendgrid:inbound:other.example.com')!;
    expect(action.metadata?.blockedReason).toMatch(/target changed/);
    expect((await apply(action, true, desired)).success).toBe(false); expect(providerMutations).toEqual([]);
  });

  it('retains managed ownership when the first host write commits but its receipt is lost', async () => {
    setEnv.mockImplementationOnce(async (_env, _service, values) => {runtimeValue = values[KEY]; throw new Error('lost receipt');});
    expect((await apply((await plan()).actions[0])).success).toBe(false);
    expect((await plan(spec())).actions[0]?.metadata?.blockedReason).toMatch(/Restore/);
    const moved = desiredSigning(); moved.email.inbound!.hostname = 'other.example.com';
    expect((await plan(moved)).actions[0]?.metadata?.blockedReason).toMatch(/target changed/);
  });

});

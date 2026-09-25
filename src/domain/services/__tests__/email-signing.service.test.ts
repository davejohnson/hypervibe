import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { planEmail, resolveEmailIntegrationState, emailDeliveryEventsConfigHash } from '../email-plan.service.js';
import { applyEmailAction } from '../email-apply.service.js';
import { resolvePlanActionAuthority } from '../../plan/action-authority.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { SendGridAdapter } from '../../../adapters/providers/sendgrid/sendgrid.adapter.js';
import { environmentSpecSchema, SENDGRID_DELIVERY_EVENTS, SENDGRID_EVENT_PUBLIC_KEY as KEY } from '../../spec/spec.schema.js';
import { hashEnvValue, type ObservedState } from '../../ports/observe.port.js';
import { adapterFactory } from '../adapter.factory.js';
import { applyEventSigning, planEventSigning } from '../email-signing.service.js';
import { inspectWebhookReadiness } from '../webhook-readiness.service.js';

// Reconstructed SendGrid settings/toggle responses, not live recordings. Public test key
// from https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks
const publicKey = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmgmjvPAR/Lmwn2teL2WJUDIx35PqsnLKjPhPbrKkfMg6vK4NZQB1VeFSKbV7whQbEJRFHjF8+1zJxsXRP1GbWw==';
const endpointId = '77d4a5da-7015-11ed-a1eb-0242ac120002';
const url = 'https://api.example.com/events';
const desired = (enabled: boolean | undefined = true) => environmentSpecSchema.parse({
  hosting: {provider: 'railway'}, services: {api: {workloadKind: 'web', public: true}},
  email: {enabled: true, deliveryEvents: {service: 'api', path: '/events', events: ['delivered'], signatureVerification: enabled}},
});

describe('SendGrid signing lifecycle through real HTTP client and shared hosting env boundary', () => {
  let dir: string;
  let project: ReturnType<ProjectRepository['create']>;
  let envId: string;
  let signing: boolean;
  let runtimeValue: string | undefined;
  let ambiguous: boolean;
  let partial: boolean;
  let adapter: SendGridAdapter;
  let writes: Array<{method: string; path: string; body: unknown}>;
  let setEnv: ReturnType<typeof vi.fn>;
  let removeEnv: ReturnType<typeof vi.fn>;
  const environment = () => new EnvironmentRepository().findById(envId)!;
  const observe = (): ObservedState => ({ provider: 'railway', observedAt: new Date().toISOString(), projectExists: true, partial, warnings: [], databases: [],
    services: [{name: 'api', externalId: 'api-id', workloadKind: 'web', customDomains: [], config: {}, status: 'running', envVarKeys: runtimeValue ? [KEY] : [], envVarHashes: runtimeValue ? {[KEY]: hashEnvValue(runtimeValue)} : {}}],
  });
  const plan = async (spec = desired()) => planEventSigning({spec, environment: environment(), observed: observe(), state: {status: 'known', value: await adapter.getEventWebhookSigning(endpointId)}, deliveryReady: true});
  const apply = async (action: ReturnType<typeof planEventSigning>['actions'][number], spec = desired(), confirm = true) => applyEventSigning({project, environment: environment(), spec, action, adapter, confirmedActionIds: confirm ? new Set([action.id]) : undefined});
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-signing-'));
    SqliteAdapter.resetInstance(); initializeDatabase(path.join(dir, 'test.db'));
    project = new ProjectRepository().create({name: 'signing', defaultPlatform: 'railway'});
    new ServiceRepository().create({projectId: project.id, name: 'api'});
    envId = new EnvironmentRepository().create({projectId: project.id, name: 'production', platformBindings: {provider: 'railway', projectId: 'project-id', environmentId: 'prod-id', services: {api: {serviceId: 'api-id', url: 'https://api.example.com'}}, email: {deliveryEvents: {endpointId}}}}).id;
    signing = false; runtimeValue = undefined; ambiguous = false; partial = false; writes = [];
    adapter = new SendGridAdapter(); adapter.connect({apiKey: 'test-private-key'});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (init?.method === 'PATCH') {
        expect(pathname).toBe('/v3/user/webhooks/event/settings/signed/' + endpointId);
        const body = JSON.parse(String(init.body)); writes.push({method: 'PATCH', path: pathname, body});
        signing = body.enabled;
        if (ambiguous) throw new Error('test-private-key provider echo');
        return new Response(JSON.stringify({id: endpointId, public_key: signing ? publicKey : ''}));
      }
      expect(pathname).toBe('/v3/user/webhooks/event/settings/' + endpointId);
      return new Response(JSON.stringify({id: endpointId, enabled: true, url, delivered: true, ...(signing ? {public_key: publicKey} : {})}));
    });
    setEnv = vi.fn(async (_env, _service, values) => { runtimeValue = values[KEY]; return {success: true, message: 'written'}; });
    removeEnv = vi.fn(async () => { runtimeValue = undefined; return {success: true, message: 'removed'}; });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({success: true, adapter: {observe: vi.fn(async () => observe()), setEnvVars: setEnv, deleteEnvVars: removeEnv} as never});
  });
  afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); fs.rmSync(dir, {recursive: true, force: true}); });

  it('stages exact confirmed signing before key publication, then becomes mutation-free noop', async () => {
    const first = await plan(); expect(first.actions).toHaveLength(1);
    expect((await apply(first.actions[0], desired(), false)).success).toBe(false);
    expect((await apply({...first.actions[0], requiresConfirm: false})).success).toBe(false);
    expect(writes).toHaveLength(0);
    expect((await apply(first.actions[0])).success).toBe(true);
    expect(writes).toHaveLength(1); expect(setEnv).not.toHaveBeenCalled();
    const second = await plan(); expect(second.actions.map(a => a.type)).toEqual(['noop', 'update']);
    expect(JSON.stringify(second)).not.toContain(publicKey);
    expect((await apply(second.actions[1])).success).toBe(true);
    expect(setEnv).toHaveBeenCalledWith(expect.objectContaining({id: envId}), expect.objectContaining({name: 'api'}), {[KEY]: publicKey});
    expect(environment().platformBindings.email).not.toHaveProperty('publicKey');
    const final = await plan(); expect(final.actions.every(a => a.type === 'noop')).toBe(true);
    vi.mocked(fetch).mockClear(); setEnv.mockClear();
    for (const action of final.actions) expect((await apply(action)).success).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); expect(setEnv).not.toHaveBeenCalled();
    const report = inspectWebhookReadiness({environmentSpec: desired(), environment: environment(), observed: observe(), eventSigningReadiness: final.readiness});
    expect(report).toMatchObject({status: 'configured', applicationVerification: 'not_verified'});
  });
  it('recovers a committed signing write with a lost receipt without toggling again', async () => {
    const first = await plan(); ambiguous = true;
    const result = await apply(first.actions[0]); expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('test-private-key');
    const retry = await plan(); expect(retry.actions[0].type).toBe('noop');
    expect((await apply(retry.actions[1])).success).toBe(true); expect(writes).toHaveLength(1);
  });
  it('does not repeat a hosting write after its receipt was lost', async () => {
    signing = true;
    setEnv.mockImplementationOnce(async (_env, _service, values) => {runtimeValue = values[KEY]; throw new Error('lost receipt ' + publicKey);});
    const first = await plan(); expect((await apply(first.actions[1])).success).toBe(false);
    expect((await apply((await plan()).actions[1])).success).toBe(true);
    expect(setEnv).toHaveBeenCalledTimes(1);
  });
  it('removes only an owned key after confirmed disabling; intent can then be removed', async () => {
    signing = true; expect((await apply((await plan()).actions[1])).success).toBe(true);
    const disable = await plan(desired(false)); expect(disable.actions).toHaveLength(1);
    expect((await apply(disable.actions[0], desired(false))).success).toBe(true); expect(removeEnv).not.toHaveBeenCalled();
    expect((await apply((await plan(desired(false))).actions[1], desired(false))).success).toBe(true);
    const unmanaged = desired(); delete unmanaged.email.deliveryEvents!.signatureVerification;
    expect((await plan(unmanaged)).actions).toEqual([]);
  });
  it('blocks unknown observations, missing environments and removal of active intent', async () => {
    signing = true; partial = true;
    const blocked = await plan(); expect(blocked.actions[1].metadata?.blockedReason).toBeTruthy();
    expect((await apply(blocked.actions[1])).success).toBe(false); expect(setEnv).not.toHaveBeenCalled();
    expect(planEventSigning({spec: desired(), environment: null, observed: null, deliveryReady: true}).actions[0].metadata?.blockedReason).toBeTruthy();
    partial = false; await apply((await plan()).actions[1]);
    const unmanaged = desired(); delete unmanaged.email.deliveryEvents!.signatureVerification;
    expect((await plan(unmanaged)).actions[0].metadata?.blockedReason).toMatch(/Restore/);
  });
  it('does not delete an unrelated key', async () => {
    runtimeValue = 'another-owner';
    const result = await plan(desired(false)); expect(result.actions[1].metadata?.blockedReason).toMatch(/not proven owned/);
    expect((await apply(result.actions[1], desired(false))).success).toBe(false); expect(removeEnv).not.toHaveBeenCalled();
  });
  it('rejects a changed hosting identity even if it retains the same URL', async () => {
    signing = true; const action = (await plan()).actions[1];
    new EnvironmentRepository().updatePlatformBindings(envId, {services: {api: {serviceId: 'different-id', url: 'https://api.example.com'}}});
    expect((await apply(action)).success).toBe(false); expect(setEnv).not.toHaveBeenCalled();
  });
  it('preserves runtime rollout evidence for the shared lifecycle', async () => {
    signing = true;
    setEnv.mockImplementationOnce(async (_env, _service, values) => {runtimeValue = values[KEY]; return {success: true, message: 'written', data: {runtimeRolloutRequired: true, rolloutBaseline: {state: 'present', deploymentId: 'old'}}};});
    expect(await apply((await plan()).actions[1])).toMatchObject({success: true, data: {runtimeRolloutRequired: true, rolloutBaselines: {api: {state: 'present', deploymentId: 'old'}}}});
  });
  it('requires provider convergence and never publishes a key on an acknowledged-but-unobserved toggle', async () => {
    const action = (await plan()).actions[0];
    vi.mocked(fetch).mockImplementation(async (_input, init) => new Response(JSON.stringify(init?.method === 'PATCH' ? {public_key: publicKey} : {id: endpointId, enabled: true, url})));
    expect(await apply(action)).toMatchObject({success: false, status: 'pending'});
    expect(setEnv).not.toHaveBeenCalled();
  });
  it('blocks provider signing drift between planning and key apply', async () => {
    signing = true; const action = (await plan()).actions[1]; signing = false;
    expect((await apply(action)).success).toBe(false); expect(setEnv).not.toHaveBeenCalled();
  });
  it('persists intent before consuming the signing transition', async () => {
    const action = (await plan()).actions[0];
    vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockImplementationOnce(() => {throw new Error('disk unavailable');});
    expect((await apply(action)).success).toBe(false); expect(writes).toHaveLength(0);
  });
  it('reconciles a committed hosting write after binding persistence fails', async () => {
    signing = true; const action = (await plan()).actions[1];
    vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockImplementationOnce(() => {throw new Error('disk unavailable');});
    expect((await apply(action)).success).toBe(false);
    expect((await apply((await plan()).actions[1])).success).toBe(true); expect(setEnv).toHaveBeenCalledTimes(1);
  });
  it('blocks masked keys and drifted key deletion', async () => {
    signing = true; runtimeValue = publicKey;
    const observation = observe(); observation.services[0].envVarHashes = {};
    const result = planEventSigning({spec: desired(), environment: environment(), observed: observation, state: {status: 'known', value: await adapter.getEventWebhookSigning(endpointId)}, deliveryReady: true});
    expect(result.actions[1].metadata?.blockedReason).toMatch(/unknown/);
    expect(result.readiness?.keyWiring).toBe('unknown');
  });
  it('pins environment scope even when another environment uses the same service name and URL', async () => {
    signing = true; const action = (await plan()).actions[1];
    const staging = new EnvironmentRepository().create({projectId: project.id, name: 'staging', platformBindings: {...environment().platformBindings, environmentId: 'staging-id'}});
    expect((await applyEventSigning({project, environment: staging, spec: desired(), action, adapter, confirmedActionIds: new Set([action.id])})).success).toBe(false);
    expect(setEnv).not.toHaveBeenCalled(); expect(writes).toHaveLength(0);
  });
  it('reserves the generated public-key role from ordinary runtime configuration', () => {
    const spec = desired();
    expect(environmentSpecSchema.safeParse({...spec, envVars: {[KEY]: 'manual'}}).success).toBe(false);
    expect(environmentSpecSchema.safeParse({...spec, removeEnvVars: [KEY]}).success).toBe(false);
  });

  it('routes shared email planning, confirmed apply, and readiness through exact provider transport', async () => {
    const connection = new ConnectionRepository().create({provider: 'sendgrid', credentialsEncrypted: getSecretStore().encryptObject({apiKey: 'test-private-key'})});
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    new EnvironmentRepository().updatePlatformBindings(envId, {email: {deliveryEvents: {endpointId, configHash: emailDeliveryEventsConfigHash(desired()), url}}});
    const first = await planEmail({project, environmentName: 'production', environment: environment(), environmentSpec: desired(), observed: observe()});
    const action = first.actions.find(a => a.id === 'email:sendgrid:delivery-signing')!;
    expect(action).toMatchObject({type: 'update', requiresConfirm: true});
    expect(resolvePlanActionAuthority(action)).toBeTruthy();
    expect(await applyEmailAction({project, environmentName: 'production', environmentSpec: desired(), action, confirmedActionIds: new Set([action.id])})).toMatchObject({success: true});
    const second = await planEmail({project, environmentName: 'production', environment: environment(), environmentSpec: desired(), observed: observe()});
    const key = second.actions.find(a => a.id === 'email:sendgrid:delivery-key')!;
    expect(key).toMatchObject({type: 'update', requiresConfirm: true});
    expect(resolvePlanActionAuthority(key)).toBeTruthy();
    expect(await applyEmailAction({project, environmentName: 'production', environmentSpec: desired(), action: key, confirmedActionIds: new Set([key.id])})).toMatchObject({success: true});
    const state = await resolveEmailIntegrationState({project, environment: environment(), environmentSpec: desired()});
    expect(state.eventSigning).toMatchObject({status: 'known', value: {id: endpointId, signing: true}});
    expect(JSON.stringify(second.actions)).not.toContain(publicKey);
  });

  it('does not accept a same-named provider service as the bound receiving identity', async () => {
    signing = true; runtimeValue = publicKey;
    const observation = observe(); observation.services[0].externalId = 'unrelated-service';
    const result = planEventSigning({spec: desired(), environment: environment(), observed: observation, state: {status: 'known', value: await adapter.getEventWebhookSigning(endpointId)}, deliveryReady: true});
    expect(result.actions[1].metadata?.blockedReason).toMatch(/unknown/);
    expect(result.readiness?.keyWiring).toBe('unknown');
  });

  it('uses a signing-only durable ID for later delivery-event updates too', async () => {
    const connection = new ConnectionRepository().create({provider: 'sendgrid', credentialsEncrypted: getSecretStore().encryptObject({apiKey: 'test-private-key'})});
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    const spec = desired(); spec.email.deliveryEvents!.events.push('bounce');
    new EnvironmentRepository().updatePlatformBindings(envId, {email: {eventSigning: {endpointId}, deliveryEvents: {configHash: emailDeliveryEventsConfigHash(spec), url}}});
    let settings = {enabled: true, url, ...Object.fromEntries(SENDGRID_DELIVERY_EVENTS.map(event => [event, event === 'delivered']))};
    const patches: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith('/scopes')) return Response.json({scopes: ['mail.send', 'user.webhooks.event.settings.read', 'user.webhooks.event.settings.update']});
      // Documented optional response ID is deliberately omitted; requested identity must survive.
      expect(pathname).toBe('/v3/user/webhooks/event/settings/' + endpointId);
      if (init?.method === 'PATCH') { patches.push(pathname); settings = JSON.parse(String(init.body)); }
      return Response.json(settings);
    });
    const result = await planEmail({project, environmentName: 'production', environment: environment(), environmentSpec: spec, observed: observe()});
    const action = result.actions.find(a => a.id === 'email:sendgrid:delivery-events')!;
    expect(action.type).toBe('update');
    expect(await applyEmailAction({project, environmentName: 'production', environmentSpec: spec, action})).toMatchObject({success: true});
    expect(patches).toEqual(['/v3/user/webhooks/event/settings/' + endpointId]);
    expect(environment().platformBindings.email).toMatchObject({deliveryEvents: {endpointId}});
  });

});

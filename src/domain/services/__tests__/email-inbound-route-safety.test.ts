import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import type { PlanAction } from '../../plan/plan.types.js';
import { environmentSpecSchema, type EnvironmentSpec } from '../../spec/spec.schema.js';
import { applyEmailAction } from '../email-apply.service.js';
import { emailInboundConfigHash, EMAIL_OPERATIONS } from '../email-plan.service.js';

// Reconstructed from the official attached-setting PATCH example, not recorded traffic:
// https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks
const hostname = 'inbound.example.com';
const policyId = 'dd677638-a16d-4e19-95ea-20231c35511b';
const oldUrl = 'https://api.example.com/old';
const newUrl = 'https://api.example.com/new';
const providerKey = 'test-private-sendgrid-key';
type Route = { hostname: string; url: string; spam_check: boolean; send_raw: boolean; security_policy?: string };
const originalRoute = (): Route => ({hostname, url: oldUrl, spam_check: true, send_raw: false, security_policy: policyId});

describe('Inbound route action safety through real SendGrid HTTP transport', () => {
  let dir: string;
  let project: ReturnType<ProjectRepository['create']>;
  let desired: EnvironmentSpec;
  let route: Route;
  let mutations: Array<{method: string; pathname: string; body: unknown}>;
  let scopes: string[];
  let delayed: boolean;
  let lostReceipt: boolean;
  let unavailable: boolean;
  let unknownRead: 'scopes' | 'list' | undefined;
  const action = (): PlanAction => ({
    id: `email:sendgrid:inbound:${hostname}`, type: 'replace', resource: {kind: 'email', name: hostname, provider: 'sendgrid'},
    reason: 'Update inbound URL while preserving its policy', verified: true, requiresConfirm: true,
    metadata: {operation: EMAIL_OPERATIONS.inboundReplace, hostname, service: 'api', path: '/new',
      aliases: desired.email.inbound!.aliases, spamCheck: true, sendRaw: false, configHash: emailInboundConfigHash(desired),
      expectedUrl: newUrl, expectedPolicyId: policyId},
  });
  const apply = (reviewed: PlanAction, confirm = true) => applyEmailAction({project, environmentName: 'production', environmentSpec: desired,
    action: reviewed, confirmedActionIds: confirm ? new Set([reviewed.id]) : undefined});

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-inbound-route-safety-'));
    SqliteAdapter.resetInstance(); initializeDatabase(path.join(dir, 'test.db'));
    project = new ProjectRepository().create({name: 'route-safety', defaultPlatform: 'railway'});
    new EnvironmentRepository().create({projectId: project.id, name: 'production', platformBindings: {
      provider: 'railway', projectId: 'project-id', environmentId: 'production-id', services: {api: {serviceId: 'api-id', url: 'https://api.example.com'}},
    }});
    const connection = new ConnectionRepository().create({provider: 'sendgrid', credentialsEncrypted: getSecretStore().encryptObject({apiKey: providerKey})});
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    desired = environmentSpecSchema.parse({domain: 'example.com', hosting: {provider: 'railway'}, services: {api: {workloadKind: 'web', public: true}},
      email: {enabled: true, inbound: {hostname, service: 'api', path: '/new'}}});
    route = originalRoute(); mutations = []; delayed = false; lostReceipt = false; unavailable = false; unknownRead = undefined;
    scopes = ['user.webhooks.parse.settings.read', 'user.webhooks.parse.settings.update'];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (unknownRead === 'scopes' && pathname === '/v3/scopes'
        || unknownRead === 'list' && pathname === '/v3/user/webhooks/parse/settings') {
        return Response.json({errors: [{message: providerKey}]}, {status: 403});
      }
      if (pathname === '/v3/scopes') return Response.json({scopes});
      if (init?.method !== 'GET') {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        mutations.push({method: init!.method!, pathname, body});
        expect(init?.method).toBe('PATCH');
        expect(pathname).toBe('/v3/user/webhooks/parse/settings/' + hostname);
        route = {...route, ...body};
        if (lostReceipt) throw new Error('Ambiguous write echoed ' + providerKey);
        return Response.json(route);
      }
      if (pathname === '/v3/user/webhooks/parse/settings') return Response.json({result: [route]});
      expect(pathname).toBe('/v3/user/webhooks/parse/settings/' + hostname);
      if (unavailable) return Response.json({errors: [{message: providerKey}]}, {status: 403});
      return Response.json(delayed && mutations.length ? originalRoute() : route);
    });
  });
  afterEach(() => {vi.restoreAllMocks(); SqliteAdapter.resetInstance(); fs.rmSync(dir, {recursive: true, force: true});});

  it.each(['id', 'resource', 'blocked'] as const)('refuses invalid %s authority before provider writes', async invalid => {
    const reviewed = action();
    if (invalid === 'id') reviewed.id = 'email:sendgrid:inbound:other.example.com';
    if (invalid === 'resource') reviewed.resource.kind = 'service';
    if (invalid === 'blocked') reviewed.metadata!.blockedReason = 'Review is blocked';
    expect((await apply(reviewed)).success).toBe(false);
    expect(mutations).toEqual([]);
  });

  it.each(['marker', 'caller'] as const)('requires the exact confirmation %s', async missing => {
    const reviewed = action();
    if (missing === 'marker') reviewed.requiresConfirm = false;
    expect((await apply(reviewed, missing !== 'caller')).success).toBe(false);
    expect(mutations).toEqual([]);
  });

  it('makes a noop mutation-free without reading provider state', async () => {
    expect(await apply({...action(), type: 'noop'})).toMatchObject({success: true});
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['omitted', 'changed', 'unavailable', 'unreviewed'] as const)('preserves the route when its policy is %s', async state => {
    const reviewed = action();
    if (state === 'omitted') delete route.security_policy;
    if (state === 'changed') route.security_policy = 'another-policy-id';
    if (state === 'unavailable') unavailable = true;
    if (state === 'unreviewed') delete reviewed.metadata!.expectedPolicyId;
    const result = await apply(reviewed);
    expect(result.success).toBe(false); expect(mutations).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(providerKey);
  });

  it.each(['scopes', 'list'] as const)('keeps an unknown %s read value-free and mutation-free', async endpoint => {
    unknownRead = endpoint;
    const result = await apply(action());
    expect(result.success).toBe(false); expect(mutations).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(providerKey);
  });

  it('returns pending after an acknowledged but unobserved PATCH, then reconciles without another write', async () => {
    delayed = true;
    expect(await apply(action())).toMatchObject({success: false, status: 'pending'});
    expect(mutations).toEqual([{method: 'PATCH', pathname: '/v3/user/webhooks/parse/settings/' + hostname,
      body: {url: newUrl, spam_check: true, send_raw: false, security_policy: policyId}}]);
    delayed = false;
    expect(await apply(action())).toMatchObject({success: true});
    expect(mutations).toHaveLength(1);
  });

  it('reconciles a committed PATCH with a lost receipt without another PATCH or rollback', async () => {
    lostReceipt = true;
    const result = await apply(action());
    expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain(providerKey);
    expect(await apply(action())).toMatchObject({success: true});
    expect(mutations).toHaveLength(1); expect(route.security_policy).toBe(policyId);
  });

  it.each(['null', 'throw'] as const)('reports a %s binding-save failure honestly and safely reconciles the committed route', async failure => {
    const save = vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockImplementationOnce(() => {
      if (failure === 'throw') throw new Error('Persist echoed ' + providerKey);
      return null;
    });
    const result = await apply(action());
    expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain(providerKey);
    expect(save).toHaveBeenCalledTimes(1); expect(route.url).toBe(newUrl);
    expect(await apply(action())).toMatchObject({success: true});
    expect(mutations).toHaveLength(1);
  });

  it('records alias-only adoption with read access and no provider mutation', async () => {
    scopes = ['user.webhooks.parse.settings.read']; route.url = newUrl;
    desired.email.inbound!.aliases = ['support'];
    const reviewed = action(); reviewed.type = 'update'; reviewed.requiresConfirm = false;
    reviewed.metadata!.operation = EMAIL_OPERATIONS.inboundAdopt;
    expect(await apply(reviewed, false)).toMatchObject({success: true});
    expect(mutations).toEqual([]);
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'production')?.platformBindings.email)
      .toMatchObject({inbound: {aliases: ['support'], securityPolicyId: policyId}});
  });
});

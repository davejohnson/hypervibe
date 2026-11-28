import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { dnsRecordAddress } from '../../adapters/dns/tofu/dns-engine.backend.js';
import type { DnsRecordIntent } from '../../domain/ports/dns.port.js';
import * as origin from '../../domain/services/domain-target.service.js';
import * as cloudflare from '../../domain/services/cloudflare-ops.service.js';
import * as dns from '../dns-engine.js';
import { planDomainHandoff } from '../domain-handoff.js';
import { executePlanApply } from '../apply-plan.js';
import { domainHandoffBlocker } from '../../domain/services/domain-handoff-guard.js';
import { mergeRepoPlatformBindings } from '../../domain/spec/repo-bindings-file.js';
import { resolveServiceBaseUrl } from '../../domain/services/health.service.js';
import * as engine from '../infrastructure-engine.js';
import * as secrets from '../secret-rotation.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { exactHandoffDnsChanges, handoffReviewSchema } from '../../domain/plan/domain-handoff.js';
import { ConvergeExecutor } from '../../domain/plan/converge.executor.js';
import { CommandRegistry } from '../commands.js';
import { createCommandContext } from '../context.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { registerLifecycleTools } from '../../tools/lifecycle.tools.js';

const hostname = 'example.com';
const route = { hostname, service: 'web', fromEnvironment: 'production' };
const source = { hosting: { provider: 'railway' }, services: { web: {} }, domain: hostname, domainProxy: true,
  dns: { provider: 'cloudflare', zone: { id: 'zone', name: hostname, accountId: 'account' }, policy: { proxy: 'on' } },
  domainTarget: { environment: 'next', service: 'web' }, maintenance: { enabled: true, mode: 'application', page: 'off' } };
const target = { hosting: { provider: 'cloudrun' }, services: { web: {} }, edgeDomain: route };
const project = { version: 1, project: 'example', environments: { production: source, next: target } };

describe('retaining a live hostname when retiring its old hosting environment', () => {
  let dir: string;
  beforeEach(() => {
    SqliteAdapter.resetInstance();
    dir = mkdtempSync(path.join(tmpdir(), 'hv-domain-handoff-'));
    SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(dir, { recursive: true, force: true }); });
  it('accepts a target-owned Worker in the reviewed spec before and after removing the old environment', () => {
    for (const environments of [project.environments, { next: target }]) {
      const parsed = projectSpecSchema.safeParse({ ...project, environments });
      expect(parsed.success && parsed.data.environments.next).toMatchObject({ edgeDomain: route });
    }
  });

  it('exposes a separate handoff plan through the shared CLI and MCP command', () => {
    const commands = new CommandRegistry();
    registerCoreTools(commands, createCommandContext());
    expect(commands.get('hv_plan')?.inputSchema.safeParse({ env: 'next', scope: 'domain-handoff' }).success).toBe(true);
  });

  function fixture() {
    const ctx = createCommandContext();
    const app = ctx.repos.projects.create({ name: project.project, defaultPlatform: 'railway' });
    const saved = new SpecStore().replace(app, project);
    const zone = { provider: 'cloudflare' as const, zoneId: 'zone', zoneName: hostname, scope: { accountId: 'account' } };
    const native = 'next-a1.run.app';
    const original = '123.up.railway.app';
    const edge = { hostname, accountId: 'account', zoneId: 'zone', routeId: 'route', scriptName: 'forwarder', contentHash: 'hash',
      origin: `https://${native}`, targetFingerprint: '1'.repeat(64) };
    const snapshot = { serviceId: 'web-id', environmentId: 'rail-env', workloadKind: 'web' as const, wasRunning: true };
    const attachment = { name: hostname, providerDomainId: 'attachment-id', serviceId: 'web-id', environmentId: 'rail-env', serviceName: 'web', records: [], proxied: true };
    const sourceEnv = ctx.repos.environments.create({ projectId: app.id, name: 'production', platformBindings: {
      provider: 'railway', projectId: 'rail-project', environmentId: 'rail-env', domainDns: attachment, services: { web: { serviceId: 'web-id', customDomains: [hostname] } },
      maintenance: { state: 'active', mode: 'application', edge, workloads: { web: snapshot } }, dnsEngine: { fixture: 'private-state-receipt' },
    } });
    const targetEnv = ctx.repos.environments.create({ projectId: app.id, name: 'next', platformBindings: { provider: 'cloudrun' } });
    const mutable = { present: true, marker: true, endpoint: 200, routeTo: original, proof: true, unknown: false, scopedReadUnknown: false, replacedAttachment: false, lostAck: false };
    const trafficIntent: DnsRecordIntent = { name: hostname, key: 'hosting-domain:traffic.0', type: 'CNAME', values: [native], ttl: 1, proxied: true,
      authority: { kind: 'managed', nativeId: 'zone/record', preserveValues: [] } };
    const proofIntent: DnsRecordIntent = { name: '_railway-verify.example.com', key: 'hosting-domain:verification.0', type: 'TXT',
      values: ['private-verification'], ttl: 300, authority: { kind: 'managed', nativeId: 'zone/proof', preserveValues: [] } };
    const trafficAddress = dnsRecordAddress(zone, trafficIntent);
    const proofAddress = dnsRecordAddress(zone, proofIntent);
    const proof = { id: 'zone/proof', name: '_railway-verify.example.com', type: 'TXT' as const, value: 'private-verification', address: proofAddress, key: 'proof' };
    const writes: string[] = [];
    vi.spyOn(origin, 'observeEngineDomainOrigin').mockResolvedValue({ state: 'ready', target: edge });
    vi.spyOn(cloudflare, 'getCloudflareAdapter').mockReturnValue({ adapter: { prepareTrafficEdge: vi.fn(), ensureTrafficEdge: vi.fn(),
      observeTrafficEdge: vi.fn(async () => ({ state: mutable.marker ? 'active' : 'unknown', markerVerified: mutable.marker, hostname })) } } as never);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: mutable.endpoint, headers: mutable.endpoint === 302 ? { Location: '/login' } : {} })));
    const detachCustomDomain = vi.fn(async (params: unknown) => {
      expect(params).toEqual({ projectId: 'rail-project', environmentId: 'rail-env', serviceId: 'web-id', customDomainId: 'attachment-id', domain: hostname });
      expect(mutable.routeTo).toBe(native);
      expect(mutable.proof).toBe(true);
      writes.push('detach');
      mutable.present = false;
      return { success: !mutable.lostAck };
    });
    vi.spyOn(ctx.adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: {
      name: 'railway', observe: async () => ({ provider: 'railway', projectId: 'rail-project', environmentId: 'rail-env', projectExists: true,
        completeness: { project: 'complete', environment: 'complete', services: mutable.unknown ? 'unknown' : 'complete' },
        services: [{ name: 'web', externalId: 'web-id', customDomains: mutable.present ? [hostname] : [],
          customDomainStatus: mutable.present ? { [hostname]: { providerDomainId: mutable.replacedAttachment ? 'new-claim' : 'attachment-id',
            dnsRecords: [{ name: hostname, type: 'CNAME', value: original, purpose: 'TRAFFIC' }, proof] } } : {} }] }),
      getCustomDomainStatus: async () => {
        if (mutable.scopedReadUnknown) throw new Error('The exact service instance omitted domains.');
        return mutable.present ? { id: mutable.replacedAttachment ? 'new-claim' : 'attachment-id', domain: hostname } : null;
      },
      observeMaintenanceWorkload: async () => ({ ...snapshot, state: 'suspended' }), suspendMaintenanceWorkload: vi.fn(), resumeMaintenanceWorkload: vi.fn(),
      detachCustomDomain,
    } } as never);
    vi.spyOn(dns, 'observeEdgeDomainDns').mockImplementation(async (_ctx, _project, env, _hostname, transferred) => {
      expect(env.id).toBe(transferred ? targetEnv.id : sourceEnv.id);
      expect(env.platformBindings[transferred ? 'dnsEngine_edge-domain' : 'dnsEngine']).toMatchObject({ fixture: 'private-state-receipt' });
      return { zone, connectionId: 'dns-connection', traffic: { id: 'zone/record', key: 'traffic', name: hostname, type: 'CNAME' as const,
        value: mutable.routeTo, address: trafficAddress }, verification: mutable.proof ? [proof] : [], pending: false };
    });
    const segment = { engine: 'opentofu' as const, id: 'saved', planDigest: 'plan-digest', configurationDigest: 'config-digest',
      engineVersion: '1.12.2', providerVersions: { cloudflare: '5.19.1' } };
    vi.spyOn(dns, 'prepareDnsEnginePlan').mockImplementation(async input => {
      expect(input.records).toEqual([{ key: 'traffic', name: hostname, type: 'CNAME', values: [native], ttl: 1, proxied: true }]);
      expect(input.retainExistingTypes).toEqual(mutable.present ? ['TXT'] : undefined);
      const address = mutable.present ? trafficAddress : proofAddress;
      const action: PlanAction = { id: `dns:${address}`, type: mutable.present ? 'update' : 'destroy', verified: true, requiresConfirm: true,
        resource: { provider: 'dns-cloudflare', kind: 'domain', name: mutable.present ? hostname : proof.name },
        reason: 'fixture', metadata: { operation: 'dnsEngine', engineSegment: { ...segment, addresses: [address] } } };
      return { actions: [action], ready: false, descriptor: { version: 1, planId: 'saved-plan', segment,
        state: { provider: 'dns-cloudflare', projectId: app.id, environmentId: sourceEnv.id, partition: 'environment' }, zone, owner: 'hosting-domain',
        domain: hostname, connectionId: 'dns-connection', zoneFingerprint: 'dns-zone', payloadEncrypted: ctx.secretStore.encryptObject({
          records: mutable.present ? [trafficIntent, proofIntent] : [trafficIntent], retired: mutable.present ? [] : [proofIntent],
        }) } };
    });
    vi.spyOn(dns, 'executeDnsEngineSegment').mockImplementation(async ({ segment }) => {
      const [address] = segment.addresses;
      if (address === trafficAddress) { writes.push('replace-cname-value'); mutable.routeTo = native; }
      else { expect(address).toBe(proofAddress); expect(mutable.present).toBe(false); writes.push('remove-source-proof'); mutable.proof = false; }
      return { outcomes: { [address!]: 'succeeded' }, diagnostics: [] };
    });
    const params = { project: app, spec: saved.spec, environmentName: 'next', specRevision: saved.revision };
    const plan = async () => {
      const p = await planDomainHandoff(ctx, params);
      if ('blocked' in p) throw new Error(p.blocked.join(' '));
      return p;
    };
    const apply = async (p: Awaited<ReturnType<typeof plan>>, confirm = p.confirmActions) =>
      executePlanApply(ctx, { ...params, planId: p.planRunId, confirmActions: confirm });
    return { ctx, params, writes, sourceEnv, targetEnv, mutable, plan, apply, detachCustomDomain, native, trafficAddress, proofAddress };
  }

  it('preserves the route across reviewed DNS, an interrupted source release, verification cleanup, ownership transfer and source retirement', async () => {
    const f = fixture();
    const commands = new CommandRegistry();
    registerCoreTools(commands, f.ctx);
    const published = await commands.execute('hv_plan', { project: f.params.project.name, env: 'next', scope: 'domain-handoff' });
    expect(published).toMatchObject({ ok: true, data: { confirmActions: [`dns:${f.trafficAddress}`] } });
    expect((await f.plan()).confirmActions).toEqual([`dns:${f.trafficAddress}`]);
    expect(await f.apply(await f.plan(), [])).toMatchObject({ result: { success: false } });
    expect(f.writes).toEqual([]);
    expect(await f.apply(await f.plan())).toMatchObject({ result: { success: true } });
    const release = await f.plan();
    const persisted = f.ctx.repos.runs.findById(release.planRunId)?.plan;
    const review = handoffReviewSchema.parse(persisted && 'handoff' in persisted ? persisted.handoff : undefined);
    const record = { id: 'record', name: hostname, type: 'CNAME', zone_id: 'zone', ttl: 1, proxied: true, content: 'old.up.railway.app' };
    const cname = { address: review.recordAddress, type: 'cloudflare_dns_record', mode: 'managed',
      change: { actions: ['update'], before: record, after: { ...record, content: f.native } } };
    const verification = { id: 'proof', name: '_railway-verify.example.com', type: 'TXT', zone_id: 'zone', content: 'private' };
    const proof = { address: review.verification[0]!.address, type: 'cloudflare_dns_record', mode: 'managed',
      change: { actions: ['no-op'], before: verification, after: verification } };
    const planShape = (traffic: unknown, txt: unknown) => ({ resource_changes: [traffic, txt] });
    expect(exactHandoffDnsChanges(planShape(cname, proof), review, 'route')).toBe(true);
    expect(exactHandoffDnsChanges(planShape({ ...cname, change: { ...cname.change, after: { ...cname.change.after, content: 'different-origin.example.net' } } }, proof), review, 'route')).toBe(false);
    expect(exactHandoffDnsChanges(planShape({ ...cname, change: { ...cname.change, after: { ...cname.change.after, proxied: false } } }, proof), review, 'route')).toBe(false);
    expect(exactHandoffDnsChanges(planShape({ ...cname, change: { ...cname.change, actions: ['delete','create'] } }, proof), review, 'route')).toBe(false);
    expect(exactHandoffDnsChanges(planShape(cname, { ...proof, change: { ...proof.change, actions: ['delete'], after: null } }), review, 'route')).toBe(false);
    const retained = (content: string) => ({ ...cname, change: { actions: ['no-op'], before: { ...record, content }, after: { ...record, content } } });
    const removed = { ...proof, change: { ...proof.change, actions: ['delete'], after: null } };
    expect(exactHandoffDnsChanges(planShape(retained(f.native), removed), review, 'cleanup')).toBe(true);
    expect(exactHandoffDnsChanges(planShape(retained('different-origin.example.net'), removed), review, 'cleanup')).toBe(false);
    const alteredSpec = structuredClone(f.params.spec);
    delete alteredSpec.environments.next!.edgeDomain;
    expect(domainHandoffBlocker(alteredSpec, 'next', f.ctx.repos.environments.findById(f.targetEnv.id), true)).toMatch(/transfer/i);
    f.mutable.marker = false;
    expect(await f.apply(release)).toMatchObject({ result: { success: false } });
    expect(f.detachCustomDomain).not.toHaveBeenCalled();
    f.mutable.marker = true;
    f.mutable.endpoint = 302;
    f.mutable.lostAck = true;
    expect(await f.apply(await f.plan())).toMatchObject({ result: { success: false } });
    expect(f.mutable.present).toBe(false);
    expect(f.mutable.proof).toBe(true);
    f.mutable.scopedReadUnknown = true;
    await expect(f.plan()).rejects.toThrow();
    expect(f.mutable.proof).toBe(true);
    f.mutable.scopedReadUnknown = false;
    const cleanup = await f.plan();
    expect(cleanup.confirmActions).toEqual([`dns:${f.proofAddress}`]);
    expect(await f.apply(cleanup)).toMatchObject({ result: { success: true } });
    expect(await f.apply(await f.plan())).toMatchObject({ result: { success: true } });
    const recipient = f.ctx.repos.environments.findById(f.targetEnv.id)!;
    const donor = f.ctx.repos.environments.findById(f.sourceEnv.id)!;
    expect(recipient.platformBindings.edgeDomain).toMatchObject({ sourceId: f.sourceEnv.id, targetId: f.targetEnv.id, recordId: 'zone/record' });
    expect(donor.platformBindings).not.toHaveProperty('dnsEngine');
    expect(donor.platformBindings).not.toHaveProperty('maintenance');
    expect(mergeRepoPlatformBindings(donor.platformBindings, { ...f.sourceEnv.platformBindings, dnsEngine: { domain: hostname } })).not.toHaveProperty('domainDns');
    expect(domainHandoffBlocker(f.params.spec, 'production', donor)).toMatch(/remove/i);
    expect(domainHandoffBlocker(f.params.spec, 'next', recipient, true)).toMatch(/owns/i);
    registerLifecycleTools(commands, f.ctx);
    const destroy = (input: Record<string, unknown>) => commands.execute('hv_destroy', { project: f.params.project.name, ...input, confirm: true });
    expect(await destroy({ scope: 'environment', env: 'next' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await destroy({ scope: 'project' })).toMatchObject({ ok: false });
    expect(await destroy({ scope: 'service', name: 'web' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await destroy({ scope: 'environment', env: 'production' })).toMatchObject({ ok: true });
    delete f.params.spec.environments.production;
    expect((await f.plan()).actions).toMatchObject([{ type: 'noop', resource: { name: hostname } }]);
    new SpecStore().replace(f.params.project, f.params.spec);
    vi.spyOn(engine, 'engineWorkerStatus').mockResolvedValue({ workers: [], warnings: [] });
    vi.spyOn(secrets, 'secretAges').mockResolvedValue({ blocked: 'No secret ages in this fixture.' });
    const status = () => commands.execute('hv_status', { project: f.params.project.name, env: 'next' });
    expect(await status()).toMatchObject({ ok: true, data: { edgeDomain: { state: 'serving', publicUrl: 'https://example.com', nativeOrigin: `https://${f.native}` } } });
    expect(resolveServiceBaseUrl(recipient, 'web')).toBe('https://example.com');
    expect(resolveServiceBaseUrl(recipient, 'worker')).toBeNull();
    f.mutable.marker = false;
    expect(await status()).toMatchObject({ ok: true, data: { edgeDomain: { state: 'unverified', publicUrl: 'https://example.com' } } });
    expect(f.writes).toEqual(['replace-cname-value', 'detach', 'remove-source-proof']);
  });

  it('blocks changed attachment, incomplete inventories and unhealthy public responses before any source mutation', async () => {
    const f = fixture();
    f.mutable.routeTo = f.native;
    const approved = await f.plan();
    f.mutable.replacedAttachment = true;
    expect(await f.apply(approved)).toMatchObject({ result: { success: false } });
    f.mutable.replacedAttachment = false;
    f.mutable.unknown = true;
    await expect(f.plan()).rejects.toThrow(/inventory/i);
    f.mutable.unknown = false;
    f.mutable.endpoint = 503;
    await expect(f.plan()).rejects.toThrow(/health/i);
    expect(f.writes).toEqual([]);
  });

  it('refuses a saved DNS intention for a different origin even when the record ID and action still match', async () => {
    const f = fixture();
    const plan = await f.plan();
    const loaded = new ConvergeExecutor().loadPlan(plan.planRunId);
    if ('error' in loaded) throw new Error(loaded.error);
    const document = loaded.document;
    const dns = document.dns!;
    const payload = f.ctx.secretStore.decryptObject<{ records: DnsRecordIntent[]; retired: DnsRecordIntent[] }>(dns.descriptor.payloadEncrypted);
    payload.records[0]!.values = ['different-origin.example.net'];
    f.ctx.repos.runs.updatePlan(plan.planRunId, { ...document, dns: { ...dns, descriptor: { ...dns.descriptor, payloadEncrypted: f.ctx.secretStore.encryptObject(payload) } } });
    expect(await f.apply(plan)).toMatchObject({ result: { success: false } });
    expect(f.writes).toEqual([]);
  });

  it('preserves both owners and their exact service when source absence is uncertain after a lost release reply', async () => {
    const f = fixture();
    f.mutable.routeTo = f.native; f.mutable.lostAck = true;
    expect(await f.apply(await f.plan())).toMatchObject({ result: { success: false } });
    f.mutable.scopedReadUnknown = true;
    await expect(f.plan()).rejects.toThrow();
    const commands = new CommandRegistry(); registerLifecycleTools(commands, f.ctx);
    f.ctx.repos.services.create({ projectId: f.params.project.id, name: 'web' });
    f.ctx.repos.services.create({ projectId: f.params.project.id, name: 'unrelated' });
    for (const input of [{ scope: 'project' }, { scope: 'environment', env: 'production' }, { scope: 'environment', env: 'next' }, { scope: 'service', name: 'web' }]) {
      expect(await commands.execute('hv_destroy', { project: f.params.project.name, ...input })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    }
    expect(await commands.execute('hv_destroy', { project: f.params.project.name, scope: 'service', name: 'unrelated', confirm: true })).toMatchObject({ ok: true });
    expect(f.writes).toEqual(['detach']);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { HttpDnsObserver } from '../../adapters/dns-observation/http-observer.js';
import { PublicDnsClient } from '../../adapters/dns/public-dns.client.js';
import { parseEnginePlan, translateEnginePlan } from '../../adapters/engine/opentofu/plan-mapping.js';
import type { OpenTofuEngine } from '../../adapters/engine/opentofu/engine.js';
import { createCommandRegistry } from '../../application/commands.js';
import { createCommandContext } from '../../application/context.js';
import { readDnsOwnedRecords } from '../../application/dns-engine.js';
import { migrationCutoverReadiness } from '../../application/migration-cutover-readiness.js';
import * as engines from '../../application/engine-shared.js';
import type { DnsObservedRecord } from '../../domain/ports/dns.port.js';
import type { ObservedState } from '../../domain/ports/observe.port.js';
import type { IProviderLifecycleAdapter } from '../../domain/ports/provider.port.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { environmentSpecSchema } from '../../domain/spec/spec.schema.js';
import * as managedCi from '../../domain/services/managed-ci.service.js';

// Redacted source shape: a verified Railway hostname, an individually identified
// proxied apex CNAME and a separate, same-name mail TXT outside this migration.
const hostname = 'example.com';
const target = 'verified-source.up.railway.app';
const zoneId = 'b'.repeat(32), accountId = 'a'.repeat(32), recordId = 'c'.repeat(32);
const identity = { provider: 'cloudflare' as const, zoneId, zoneName: hostname, scope: { accountId } };
const dns = { provider: 'cloudflare', zone: { id: zoneId, name: hostname, accountId },
  policy: { proxy: 'on' },
  adoptRecords: [{ id: recordId, name: hostname, type: 'CNAME', values: [target] }] };
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hv-existing-domain-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(join(directory, 'test.sqlite')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const ctx = createCommandContext(), commands = createCommandRegistry(ctx);
  const project = ctx.repos.projects.create({ name: 'existing-domain', defaultPlatform: 'railway' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
    provider: 'railway', projectId: 'source-project', environmentId: 'source-env', services: { web: { serviceId: 'source-web' } },
  } });
  new SpecStore().replace(project, { version: 1, project: project.name, gitRemoteUrl: 'https://github.com/fixture/existing-domain.git',
    environments: { staging: { hosting: { provider: 'railway' }, services: { web: {} },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'staging' } } } });
  const saved = await commands.execute('hv_spec', { project: project.name, spec: { environments: { staging: { domain: hostname, dns } } } });
  expect(saved).toMatchObject({ ok: true });
  const observed: ObservedState = { provider: 'railway', projectId: 'source-project', environmentId: 'source-env', projectExists: true,
    completeness: { project: 'complete', services: 'complete', environment: 'complete', databases: 'complete' },
    observedAt: new Date().toISOString(), partial: false, warnings: [], databases: [], services: [{ name: 'web', externalId: 'source-web',
      workloadKind: 'web', status: 'running', sourceState: 'disconnected', config: {}, envVarKeys: [], envVarHashes: {}, customDomains: [hostname],
      customDomainStatus: { [hostname]: { providerDomainId: 'source-claim', providerVerified: true, dnsConfigured: false,
        certificateStatus: 'CERTIFICATE_STATUS_TYPE_VALID', dnsRecords: [
          { type: 'CNAME', name: hostname, value: target, purpose: 'DNS_RECORD_PURPOSE_TRAFFIC_ROUTE' },
          { type: 'TXT', name: '_railway-verify', value: 'synthetic-verification-value', purpose: 'verification' },
        ] } } }] };
  const adapter = { name: 'railway', capabilities: { supportsObserve: true }, observe: vi.fn(async () => structuredClone(observed)),
    attachCustomDomain: vi.fn(), detachCustomDomain: vi.fn(), deploy: vi.fn() };
  vi.spyOn(ctx.adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: adapter as unknown as IProviderLifecycleAdapter });
  const connection = ctx.repos.connections.create({ provider: 'cloudflare', credentialsEncrypted: ctx.secretStore.encryptObject({ apiToken: 'synthetic-token', accountId }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  const railway = ctx.repos.connections.create({ provider: 'railway', credentialsEncrypted: ctx.secretStore.encryptObject({ apiToken: 'synthetic-hosting' }) });
  ctx.repos.connections.updateStatus(railway.id, 'verified');
  vi.spyOn(HttpDnsObserver.prototype, 'observeZone').mockResolvedValue({ status: 'present', value: { identity, providerNativeId: zoneId,
    dnssec: 'disabled', visibility: 'public', nameservers: ['ns.example.net'] } });
  const records: DnsObservedRecord[] = [
    { nativeId: `${zoneId}/${recordId}`, name: hostname, type: 'CNAME', values: [target], ttl: 1, proxied: true },
    { nativeId: `${zoneId}/${'d'.repeat(32)}`, name: hostname, type: 'TXT', values: ['v=spf1 -all'], ttl: 300, proxied: false },
  ];
  vi.spyOn(HttpDnsObserver.prototype, 'observeRecordSets').mockImplementation(async (name, type) => {
    const matches = records.filter(record => record.name === name && record.type === type);
    return matches.length ? { status: 'present', value: structuredClone(matches) } : { status: 'absent' };
  });
  vi.spyOn(PublicDnsClient.prototype, 'query').mockResolvedValue({ status: 'known', code: 0, answers: [], authenticated: false });
  const state = new Map<string, string>();
  let action = 'no-op';
  const enginePlan = vi.fn(async (params: Parameters<OpenTofuEngine['plan']>[0]) => {
    const { configuration, planId } = params;
    const rows = Object.entries(configuration.resources).map(([address]) => ({ address, mode: 'managed', type: 'cloudflare_dns_record',
      change: { actions: [action], ...(configuration.imports?.[address] ? { importing: { id: configuration.imports[address] } } : {}) } }));
    const shown = { format_version: '1.2', resource_changes: rows };
    if (params.verifyPlannedChanges && !params.verifyPlannedChanges(shown)) return { ok: false as const, stage: 'plan review', error: 'The saved engine plan does not match the reviewed change.' };
    const segment = { id: `opentofu:${planId}`, engine: 'opentofu' as const, planDigest: 'p'.repeat(64),
      configurationDigest: 'c'.repeat(64), engineVersion: '1.12.2', providerVersions: { cloudflare: '5.19.1' } };
    return { ok: true as const, segment, ...translateEnginePlan({ provider: 'dns-cloudflare', configuration, segment,
      parsed: parseEnginePlan(JSON.stringify(shown)) }) };
  });
  const engineApply = vi.fn(async (params: Parameters<OpenTofuEngine['apply']>[0]) => {
    for (const address of params.approvedAddresses) state.set(address, recordId);
    return { outcomes: Object.fromEntries(params.approvedAddresses.map(address => [address, 'succeeded'])), diagnostics: [] };
  });
  const inspectState = vi.fn(async (params: { project: (value: unknown) => unknown }) => ({ ok: true, present: true,
    value: params.project({ format_version: '1.0', values: { root_module: { resources: [...state].map(([address, id]) => ({
      address, mode: 'managed', values: { id } })) } } }) }));
  vi.spyOn(engines, 'openTofuEngine').mockResolvedValue({ plan: enginePlan, apply: engineApply, inspectState } as unknown as OpenTofuEngine);
  const plan = () => commands.execute('hv_plan', { project: project.name, env: environment.name, scope: 'domain-adoption' });
  const apply = (planId: string, confirmActions: string[] = []) => commands.execute('hv_apply', { project: project.name, planId, confirmActions });
  const current = () => ctx.repos.environments.findById(environment.id)!;
  return { ctx, project, commands, current, observed, adapter, records, plan, apply, enginePlan, engineApply, state, action: (next: string) => { action = next; } };
}

it('adopts the verified source and its unchanged apex CNAME through isolated public plans while CI is pending', async () => {
  const f = await fixture();
  const initialRecords = structuredClone(f.records);
  const attachment = await f.plan();
  expect(attachment).toMatchObject({ ok: true, data: { actions: [{ id: `domain:${hostname}`, type: 'update' }] } });
  const local = attachment.data as { planId: string; confirmActions: string[] };
  expect(await f.apply(local.planId, local.confirmActions)).toMatchObject({ ok: true, data: { applied: true } });
  expect(f.current().platformBindings.domainDns).toMatchObject({ name: hostname, serviceName: 'web', serviceId: 'source-web',
    environmentId: 'source-env', providerDomainId: 'source-claim' });
  const imported = await f.plan();
  expect(imported).toMatchObject({ ok: true, data: { scope: 'dns-engine', actions: [{ type: 'update', requiresConfirm: true }] } });
  const review = imported.data as { planId: string; confirmActions: string[] };
  const configuration = f.enginePlan.mock.lastCall![0].configuration;
  expect(Object.values(configuration.imports ?? {})).toEqual([`${zoneId}/${recordId}`]);
  expect(JSON.stringify(configuration)).not.toContain('v=spf1');
  expect(JSON.stringify([attachment, imported, configuration])).not.toContain('synthetic-verification-value');
  expect(configuration.files['dns.tf.json']).toMatchObject({ resource: { cloudflare_dns_record: {
    [Object.keys(configuration.resources)[0]!.split('.')[1]!]: { content: target, ttl: 1, proxied: true },
  } } });
  await f.apply(review.planId);
  expect(f.engineApply).not.toHaveBeenCalled();
  expect(await f.apply(review.planId, review.confirmActions)).toMatchObject({ ok: true, data: { applied: true } });
  expect(f.engineApply).toHaveBeenCalledOnce();
  expect(readDnsOwnedRecords(f.ctx, f.current(), 'hosting-domain')).toEqual([expect.objectContaining({ nativeId: `${zoneId}/${recordId}`, type: 'CNAME' })]);
  expect(await f.plan()).toMatchObject({ ok: true, data: { actions: [], confirmActions: [] } });
  expect(f.records).toEqual(initialRecords);
  for (const effect of [f.adapter.deploy, f.adapter.attachCustomDomain, f.adapter.detachCustomDomain]) expect(effect).not.toHaveBeenCalled();
});

it.each(['provider', 'claim', 'verification'] as const)('rejects a changed hosting %s at apply', async change => {
  const f = await fixture();
  const review = await f.plan();
  expect(review.ok).toBe(true);
  if (change === 'provider') f.observed.provider = 'other';
  else if (change === 'claim') f.observed.services[0]!.customDomainStatus![hostname]!.providerDomainId = 'recreated';
  else f.observed.services[0]!.customDomainStatus![hostname]!.providerVerified = false;
  const local = review.data as { planId: string; confirmActions: string[] };
  const applied = await f.apply(local.planId, local.confirmActions);
  expect(applied.ok && (applied.data as { applied: boolean }).applied).toBe(false);
  expect(f.current().platformBindings.domainDns).toBeUndefined();
});

it('rejects an OpenTofu import that would update the record and a stale reviewed DNS record', async () => {
  const f = await fixture();
  const local = await f.plan();
  expect(local.ok).toBe(true);
  const claim = local.data as { planId: string; confirmActions: string[] };
  await f.apply(claim.planId, claim.confirmActions);
  f.action('update');
  expect((await f.plan()).ok).toBe(false);
  f.action('no-op');
  const reviewed = await f.plan();
  expect(reviewed.ok).toBe(true);
  const dnsPlan = reviewed.data as { planId: string; confirmActions: string[] };
  f.records[0]!.proxied = false;
  const applied = await f.apply(dnsPlan.planId, dnsPlan.confirmActions);
  expect(applied.ok && (applied.data as { applied: boolean }).applied).toBe(false);
  expect(f.engineApply).not.toHaveBeenCalled();
  expect(readDnsOwnedRecords(f.ctx, f.current(), 'hosting-domain')).toEqual([]);
});

it('finishes the exact source receipt after a local write interruption without repeating the DNS import', async () => {
  const f = await fixture();
  const review = async () => {
    const result = await f.plan();
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.data as { planId: string; confirmActions: string[]; actions: Array<{ type: string }> };
  };
  const claim = await review();
  await f.apply(claim.planId, claim.confirmActions);
  const imported = await review();
  const update = f.ctx.repos.environments.updatePlatformBindings.bind(f.ctx.repos.environments);
  let interrupted = false;
  const writer = vi.spyOn(f.ctx.repos.environments, 'updatePlatformBindings').mockImplementation((id, changes) => {
    if (!interrupted && (changes.domainDns as { trafficOnlyDomainId?: string } | undefined)?.trafficOnlyDomainId) {
      interrupted = true;
      throw new Error('Simulated interruption before committing the source traffic receipt.');
    }
    return update(id, changes);
  });
  const first = await f.apply(imported.planId, imported.confirmActions);
  expect(first.ok && (first.data as { applied: boolean }).applied).toBe(false);
  expect(interrupted).toBe(true);
  expect(f.engineApply).toHaveBeenCalledOnce();
  expect(f.current().platformBindings.domainDns).not.toHaveProperty('trafficOnlyDomainId');
  vi.spyOn(managedCi, 'planManagedCiDeploy').mockResolvedValue({ warnings: [], actions: [] });
  const full = () => f.commands.execute('hv_plan', { project: f.project.name, env: 'staging' });
  expect(await full()).toMatchObject({ ok: true, data: { scope: 'dns-engine', actions: [{ id: 'dns-reconcile:hosting-domain', type: 'update' }] } });
  const targetEnvironment = f.ctx.repos.environments.create({ projectId: f.project.id, name: 'next' });
  const sourceSpec = new SpecStore().get(f.project)!.spec.environments.staging!;
  const targetSpec = environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: {} } });
  const preview = () => migrationCutoverReadiness(f.project, f.current(), sourceSpec, targetEnvironment, targetSpec, 'web');
  expect((await preview()).problems).toContainEqual(expect.stringContaining('domain-adoption'));
  const receipt = await review();
  expect(receipt.actions).toEqual([expect.objectContaining({ type: 'update' })]);
  expect(f.current().platformBindings.domainDns).not.toHaveProperty('trafficOnlyDomainId');
  const address = [...f.state.keys()][0]!;
  f.state.set(address, 'f'.repeat(32));
  const stale = await f.apply(receipt.planId, receipt.confirmActions);
  expect(stale.ok && (stale.data as { applied: boolean }).applied).toBe(false);
  expect(f.current().platformBindings.domainDns).not.toHaveProperty('trafficOnlyDomainId');
  f.state.set(address, recordId);
  const retry = await review();
  expect(await f.apply(retry.planId, retry.confirmActions)).toMatchObject({ ok: true, data: { applied: true } });
  expect(f.current().platformBindings.domainDns).toMatchObject({ trafficOnlyDomainId: 'source-claim' });
  expect(f.engineApply).toHaveBeenCalledOnce();
  const noop = await review();
  expect(noop.actions).toEqual([]);
  writer.mockClear();
  await f.apply(noop.planId);
  expect(writer).not.toHaveBeenCalled();
  expect(await full()).toMatchObject({ ok: true, data: { scope: 'full' } });
  expect((await preview()).problems).toEqual([]);
  for (const effect of [f.adapter.attachCustomDomain, f.adapter.detachCustomDomain, f.adapter.deploy]) expect(effect).not.toHaveBeenCalled();
});

it('verifies the adopted source in the normal cutover preview before publishing an unrelated CI change', async () => {
  const f = await fixture();
  for (let stage = 0; stage < 2; stage++) {
    const reviewed = await f.plan();
    expect(reviewed.ok).toBe(true);
    const plan = reviewed.data as { planId: string; confirmActions: string[] };
    expect(await f.apply(plan.planId, plan.confirmActions)).toMatchObject({ ok: true, data: { applied: true } });
  }
  const ci = vi.spyOn(managedCi, 'planManagedCiDeploy').mockResolvedValue({ warnings: [], actions: [{
    id: 'ci:github-actions:staging:deploy-branch', type: 'update', verified: true, reason: 'Workflow publication pending.',
    resource: { kind: 'ci', name: 'deploy-branch', provider: 'github-actions' }, metadata: { workflowPublicationRequired: true, codeProvider: 'github' },
  }] });
  const full = async () => {
    const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging' });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result;
  };
  expect(await full()).toMatchObject({ ok: true, data: { scope: 'managed-ci-publication' } });
  const target = f.ctx.repos.environments.create({ projectId: f.project.id, name: 'next' });
  const sourceSpec = new SpecStore().get(f.project)!.spec.environments.staging!;
  const targetSpec = environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: {} } });
  const preview = () => migrationCutoverReadiness(f.project, f.current(), sourceSpec, target, targetSpec, 'web');
  expect(await preview()).toMatchObject({ domain: hostname, problems: [], alreadyForwarding: false });
  // A converged full plan must leave the separately managed Railway verification TXT alone too.
  ci.mockResolvedValue({ warnings: [], actions: [] });
  expect(await full()).toMatchObject({ ok: true, data: { scope: 'full' } });
  f.records[0]!.values = ['other.up.railway.app'];
  expect((await preview()).problems.length).toBeGreaterThan(0);
  expect(f.engineApply).toHaveBeenCalledOnce();
});

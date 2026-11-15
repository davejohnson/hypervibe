import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { ConvergeExecutor, type PlanRunDocument } from '../converge.executor.js';
import type { PlanAction } from '../plan.types.js';
import type { EngineActionSegment } from '../../ports/infrastructure-engine.port.js';

let projectId: string;
let environmentId: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-engine-segment-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  projectId = new ProjectRepository().create({ name: 'engine-segment' }).id;
  environmentId = new EnvironmentRepository().create({ projectId, name: 'staging' }).id;
});

const segment = (addresses: string[]): EngineActionSegment => ({
  id: 'opentofu:plan-1', engine: 'opentofu', planDigest: 'p', configurationDigest: 'c',
  engineVersion: '1.13.9', providerVersions: {}, addresses,
});

function engineAction(name: string, extra: Partial<PlanAction> = {}): PlanAction {
  return {
    id: `service:${name}`,
    type: 'create',
    resource: { kind: 'service', name, provider: 'gcp' },
    verified: true,
    reason: 'engine',
    metadata: { engineSegment: segment([`google_cloud_run_v2_service.${name}`]) },
    ...extra,
  };
}

function storePlan(actions: PlanAction[]): string {
  const document = { kind: 'hv_plan', scope: 'infrastructure-engine', engine: { planId: 'plan-1' }, environmentName: 'staging', specRevision: 1, observedFingerprint: null, actions } as PlanRunDocument;
  return new RunRepository().create({ projectId, environmentId, type: 'plan', plan: document as unknown as Record<string, unknown> }).id;
}

describe('engine segments', () => {
  it('executes one saved engine plan once and records a receipt per action', async () => {
    const planRunId = storePlan([engineAction('web'), engineAction('api')]);
    const handler = vi.fn();
    const segmentHandler = vi.fn(async () => ({
      outcomes: { 'google_cloud_run_v2_service.web': 'succeeded' as const, 'google_cloud_run_v2_service.api': 'succeeded' as const },
      diagnostics: [],
    }));
    const result = await new ConvergeExecutor().execute({ planRunId, currentSpecRevision: 1, handler, segmentHandler });
    expect(result.success).toBe(true);
    expect(segmentHandler).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(result.receipts.map((r) => [r.actionId, r.status])).toEqual([['service:web', 'succeeded'], ['service:api', 'succeeded']]);
  });

  it('reports each member truthfully after a partial engine failure', async () => {
    const planRunId = storePlan([engineAction('web'), engineAction('api'), engineAction('worker')]);
    const result = await new ConvergeExecutor().execute({
      planRunId, currentSpecRevision: 1, handler: vi.fn(),
      segmentHandler: async () => ({
        outcomes: {
          'google_cloud_run_v2_service.web': 'failed',
          'google_cloud_run_v2_service.api': 'succeeded',
          'google_cloud_run_v2_service.worker': 'unknown',
        },
        diagnostics: ['quota exceeded'],
      }),
    });
    expect(result.success).toBe(false);
    expect(Object.fromEntries(result.receipts.map((r) => [r.actionId, r.status]))).toEqual({
      'service:web': 'failed', 'service:api': 'succeeded', 'service:worker': 'pending',
    });
  });

  it('rejects engine actions outside the isolated engine stage', async () => {
    const document = { kind: 'hv_plan', environmentName: 'staging', specRevision: 1, observedFingerprint: null, actions: [engineAction('web')] } as PlanRunDocument;
    const planRunId = new RunRepository().create({ projectId, environmentId, type: 'plan', plan: document as unknown as Record<string, unknown> }).id;
    expect(new ConvergeExecutor().loadPlan(planRunId)).toHaveProperty('error');
  });

  it('blocks engine actions when the apply path has no engine executor', async () => {
    const planRunId = storePlan([engineAction('web')]);
    const result = await new ConvergeExecutor().execute({ planRunId, currentSpecRevision: 1, handler: vi.fn() });
    expect(result.receipts[0]).toMatchObject({ actionId: 'service:web', status: 'blocked' });
  });

  it('does not run the engine before its external prerequisites complete', async () => {
    const prerequisite: PlanAction = {
      id: 'secret:api-key', type: 'create', resource: { kind: 'secret', name: 'api-key', provider: 'gcp' }, verified: true, reason: 'secret', metadata: { operation: 'gcpSecretManagerEnsure' },
    };
    const planRunId = storePlan([prerequisite, engineAction('web', { dependsOn: ['secret:api-key'] })]);
    const segmentHandler = vi.fn();
    const result = await new ConvergeExecutor().execute({
      planRunId, currentSpecRevision: 1, segmentHandler,
      handler: async () => ({ success: false, message: 'secret write failed' }),
    });
    expect(segmentHandler).not.toHaveBeenCalled();
    expect(result.receipts.map((r) => r.status)).toEqual(['failed', 'aborted']);
  });

  it('requires confirmation of destructive engine actions before anything runs', async () => {
    const planRunId = storePlan([engineAction('web', { type: 'replace', requiresConfirm: true })]);
    const segmentHandler = vi.fn();
    const result = await new ConvergeExecutor().execute({ planRunId, currentSpecRevision: 1, handler: vi.fn(), segmentHandler });
    expect(segmentHandler).not.toHaveBeenCalled();
    expect(result.receipts[0]?.status).toBe('skipped_requires_confirm');
  });
});

describe('engine plan documents', () => {
  it('admits a separately saved DNS engine segment without authorizing other lifecycle actions', async () => {
    const { planRunDocumentSchema } = await import('../converge.executor.js');
    const action = { ...engineAction('dns'), resource: { kind: 'domain', name: 'app.example.com', provider: 'dns-cloudflare' } };
    const { addresses: _addresses, ...reviewedSegment } = segment(['cloudflare_dns_record.app']);
    const descriptor = { version: 1, planId: 'plan-1', segment: reviewedSegment,
      state: { provider: 'dns-cloudflare', projectId, environmentId, partition: 'environment' },
      zone: { provider: 'cloudflare', zoneId: 'a'.repeat(32), zoneName: 'example.com', scope: { accountId: 'b'.repeat(32) } },
      owner: 'hosting-domain:app.example.com', domain: 'app.example.com', connectionId: 'connection-1',
      zoneFingerprint: 'fingerprint', payloadEncrypted: 'encrypted-payload' };
    const document = { kind: 'hv_plan', scope: 'dns-engine', environmentName: 'staging', specRevision: 1,
      observedFingerprint: null, dns: { descriptor }, actions: [action] };
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
    expect(planRunDocumentSchema.safeParse({ ...document, actions: [action, {
      id: 'service:other', type: 'create', resource: { kind: 'service', name: 'other', provider: 'railway' },
      reason: 'unrelated', verified: true,
    }] }).success).toBe(false);
    expect(planRunDocumentSchema.safeParse({ ...document, dns: { descriptor: { ...descriptor,
      segment: { ...reviewedSegment, id: 'other-segment' } } } }).success).toBe(false);
    const reconciliation = { id: 'dns-reconcile:hosting', type: 'update',
      resource: { kind: 'domain', name: descriptor.domain, provider: 'dns-cloudflare' },
      verified: true, reason: 'Verify exact existing DNS and update local ownership', metadata: { operation: 'dnsOwnershipReconcile' } };
    expect(planRunDocumentSchema.safeParse({ ...document, actions: [reconciliation] }).success).toBe(true);
    expect(planRunDocumentSchema.safeParse({ ...document, actions: [reconciliation, action] }).success).toBe(false);
    expect(planRunDocumentSchema.safeParse({ ...document, actions: [{ ...reconciliation,
      resource: { ...reconciliation.resource, name: 'another.example.com' } }] }).success).toBe(false);
    const { buildDnsConfiguration, dnsEngineBackend } = await import('../../../adapters/dns/tofu/dns-engine.backend.js');
    const { parseEnginePlan, translateEnginePlan } = await import('../../../adapters/engine/opentofu/plan-mapping.js');
    const configuration = buildDnsConfiguration({ zone: descriptor.zone as import('../../ports/dns.port.js').DnsZoneIdentity, records: [
      { key: 'existing', name: 'existing.example.com', type: 'A', values: ['192.0.2.1'], ttl: 300, authority: { kind: 'absent' } },
      { key: 'new', name: 'new.example.com', type: 'A', values: ['192.0.2.2'], ttl: 300, authority: { kind: 'absent' } },
    ] });
    const addresses = Object.keys(configuration.resources);
    const translated = translateEnginePlan({ provider: dnsEngineBackend(descriptor.zone as import('../../ports/dns.port.js').DnsZoneIdentity).provider,
      configuration, segment: reviewedSegment,
      parsed: parseEnginePlan(JSON.stringify({ resource_changes: addresses.map((address, index) => ({ address,
        type: 'cloudflare_dns_record', change: { actions: [index === 0 ? 'no-op' : 'create'], before: null, after: {} } })) })),
    });
    expect(translated.actions.some(action => action.type === 'noop' && !action.metadata?.engineSegment)).toBe(true);
    expect(planRunDocumentSchema.safeParse({ ...document, actions: translated.actions }).success).toBe(true);
  });

  it('accept every action shape the OpenTofu stage persists', async () => {
    const { planRunDocumentSchema } = await import('../converge.executor.js');
    const hv = (id: string, kind: PlanAction['resource']['kind'], operation: string, type: PlanAction['type'] = 'create'): PlanAction =>
      ({ id, type, resource: { kind, name: id, provider: 'gcp' }, verified: true, reason: 'x', metadata: { operation } });
    const actions: PlanAction[] = [
      hv('secret:SESSION_SECRET', 'secret', 'gcpSecretManagerEnsure'),
      hv('domain-verify:app.example.com', 'domain', 'gcpDomainVerify'),
      hv('domain-dns:app.example.com', 'domain', 'gcpDomainDns'),
      engineAction('web', { billable: true, requiresConfirm: true }),
      { ...engineAction('db'), id: 'database:postgres', resource: { kind: 'database', name: 'postgres', provider: 'gcp' }, billable: true, dataBearing: true },
      { ...engineAction('domain'), id: 'domain:app.example.com', resource: { kind: 'domain', name: 'app.example.com', provider: 'gcp' } },
      { ...engineAction('uploads'), id: 'storage:uploads', resource: { kind: 'storage', name: 'uploads', provider: 'gcp' }, billable: true, dataBearing: true, requiresConfirm: true },
      { ...engineAction('uploads-gone'), id: 'storage:old', type: 'destroy', resource: { kind: 'storage', name: 'old', provider: 'gcp' }, dataBearing: true, requiresConfirm: true },
      hv('database-credential:postgres', 'secret', 'gcpDatabaseCredentialEnsure'),
      hv('domain-ready:app.example.com', 'domain', 'gcpDomainReady', 'update'),
      { ...hv('secret-delete:old', 'secret', 'gcpSecretManagerDelete', 'destroy'), dataBearing: true, requiresConfirm: true },
      { ...hv('domain-dns-remove:old.example.com', 'domain', 'gcpDomainDnsRemove', 'destroy'), requiresConfirm: true },
      { ...hv('release:web', 'service', 'engineImageRelease', 'update') },
      { ...engineAction('redis'), id: 'cache:redis', resource: { kind: 'cache', name: 'redis', provider: 'gcp' }, billable: true, requiresConfirm: true },
      hv('cache-credential:redis', 'secret', 'gcpCacheCredentialEnsure'),
      { ...engineAction('emails'), id: 'queue:emails', resource: { kind: 'queue', name: 'emails', provider: 'gcp' }, billable: true, dataBearing: true, requiresConfirm: true },
      { ...engineAction('nightly'), id: 'service:nightly', billable: true, requiresConfirm: true },
    ];
    const document = { kind: 'hv_plan', scope: 'infrastructure-engine', engine: { planId: 'p' }, environmentName: 'staging', specRevision: 1, observedFingerprint: null, actions };
    const parsed = planRunDocumentSchema.safeParse(document);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)).toEqual([]);
  });
});

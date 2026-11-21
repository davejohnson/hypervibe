import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { probeWorkloadDigest } from '../../adapters/providers/gcp/gcp-transfer-probe-workload.js';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  recoverTerminalTransferResources,
  runAccessProbeJob,
  type TransferResources,
} from '../migration-transfer-gcp.js';

vi.mock('../infrastructure-engine.js', () => ({}));

const project = 'sample-project';
const region = 'us-central1';
const email = `sample-runtime@${project}.iam.gserviceaccount.com`;
const marker = '17'.repeat(32);
const input = {
  role: 'app' as const,
  expectedEmail: email,
  projectNumber: '123456789012',
  secretId: 'migration-slot',
  version: '7',
  bucket: 'sample-bucket',
  object: 'migrations/staging/hypervibe-access-probe-12341234-1234-4123-a123-123456789012',
  generation: '170000000001',
  marker,
};
const name = `projects/${input.projectNumber}/secrets/${input.secretId}/versions/7`;
const secret = 'https://secretmanager.googleapis.com/v1/' + name + ':access';
const object = `https://storage.googleapis.com/storage/v1/b/${input.bucket}/o/${encodeURIComponent(input.object)}?alt=media&generation=${input.generation}`;
const metadata = object.replace('?alt=media&', '?');
const date = '20261120T180000Z';
const query = new URLSearchParams({
  generation: input.generation,
  'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
  'X-Goog-Date': date,
  'X-Goog-Expires': '900',
  'X-Goog-SignedHeaders': 'host',
  'X-Goog-Credential': `signer@${project}.iam.gserviceaccount.com/${date.slice(0, 8)}/auto/storage/goog4_request`,
  'X-Goog-Signature': '14'.repeat(256),
});
const signed = `https://storage.googleapis.com/${input.bucket}/${input.object}?${query}`;
const json = (x: unknown, status = 200) => Response.json(x, { status });
const accessDenial = (permission: string) =>
  json(
    {
      error: {
        code: 403,
        message: `Permission '${permission}' denied on resource (or it may not exist).`,
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            domain: 'global',
            reason: 'forbidden',
            metadata: { permission },
          },
        ],
      },
    },
    403,
  );
const secretResult = (value = { marker, url: signed }, resource = name) =>
  json({ name: resource, payload: { data: Buffer.from(JSON.stringify(value)).toString('base64') } });

interface FixtureOptions {
  role?: 'app' | 'copy' | 'file-app';
  email?: string;
  observedEmail?: string;
  observedScriptChanged?: boolean;
  secret?: Response;
  object?: Response;
  metadata?: Response;
  file?: Response;
  token?: Response;
  failedCount?: number;
  deletionRejected?: boolean;
  logResult?: Record<string, unknown>;
}
interface CreatedJob {
  template: {
    template: {
      serviceAccount: string;
      containers: {
        image: string;
        command: string[];
        args: string[];
        env: { name: string; value: string }[];
      }[];
    };
  };
  labels: Record<string, string>;
}

function fixture(options: FixtureOptions = {}) {
  const local = vi.fn(async () => 'operator-token-fixture');
  const recorded: Array<TransferResources | null> = [];
  const logs: string[] = [];
  const loggingQuotaProjects: Array<string | null> = [];
  const visited: string[] = [];
  const controls: string[] = [];
  let body: CreatedJob;
  let job: string;
  let exists = false;
  const scope = `projects/${project}/locations/${region}`;
  const worker = async (url: string | URL, init: RequestInit) => {
    const dest = String(url);
    visited.push(dest);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeTruthy();
    const headers = new Headers(init.headers);
    if (dest === 'http://metadata.google.internal/computeMetadata/v1/project/numeric-project-id')
      return new Response(input.projectNumber);
    if (dest.startsWith('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/')) {
      expect(headers.get('Metadata-Flavor')).toBe('Google');
      if (dest.endsWith('/email')) return new Response(options.email ?? email);
      if (dest.endsWith('/token'))
        return options.token ?? json({ access_token: 'runtime-token-fixture', token_type: 'Bearer' });
    }
    if (dest === signed) {
      expect(headers.has('authorization')).toBe(false);
      return options.file ?? new Response(marker);
    }
    expect(headers.get('authorization')).toBe('Bearer runtime-token-fixture');
    if (dest === metadata) return options.metadata ?? accessDenial('storage.objects.get');
    if (dest === secret)
      return (
        options.secret ?? (options.role === 'copy' ? secretResult() : accessDenial('secretmanager.versions.access'))
      );
    if (dest === object)
      return (
        options.object ??
        json(
          {
            error: {
              code: 403,
              message: `${email} does not have storage.objects.get access to the Google Cloud Storage object.`,
              errors: [{ reason: 'forbidden', domain: 'global' }],
            },
          },
          403,
        )
      );
    throw new Error('Unapproved destination');
  };
  vi.stubGlobal('fetch', async (location: string, init: RequestInit = {}) => {
    const url = new URL(location);
    const path = url.pathname.replace(/^\/v2\//, '');
    const method = init.method ?? 'GET';
    controls.push(`${method} ${path}`);
    const nativeJob = () => ({ ...body, name: job, uid: 'native-uid', etag: 'native-etag' });
    if (url.hostname === 'logging.googleapis.com')
      loggingQuotaProjects.push(new Headers(init.headers).get('X-Goog-User-Project'));
    if (url.hostname === 'logging.googleapis.com')
      return json({
        entries: String(init.body).includes('HV_RESTORE_ERROR') ? [] :
          (options.logResult ? ['HV_TRANSFER_RESULT ' + JSON.stringify(options.logResult)] : logs).map((textPayload) => ({ textPayload })),
      });
    if (method === 'POST' && path === `${scope}/jobs`) {
      job = `${scope}/jobs/${url.searchParams.get('jobId')}`;
      body = JSON.parse(String(init.body));
      exists = true;
      return json({ name: `${scope}/operations/create`, done: true, response: nativeJob() });
    }
    if (method === 'GET') {
      if (!exists) return json({}, 404);
      const observed = structuredClone(nativeJob());
      if (options.observedEmail) observed.template.template.serviceAccount = options.observedEmail;
      if (options.observedScriptChanged) observed.template.template.containers[0].args = ['-e', 'process.exit(0)'];
      return json(observed);
    }
    if (method === 'POST' && path === job + ':run') {
      expect(JSON.parse(String(init.body))).toEqual({ etag: 'native-etag' });
      const [container] = body.template.template.containers;
      expect(container.command).toEqual(['node']);
      expect(container.args[0]).toBe('-e');
      expect(
        createHash('sha256')
          .update(JSON.stringify([container.image, ...container.command, ...container.args]))
          .digest('hex'),
      ).toBe(probeWorkloadDigest);
      expect(container.image).toMatch(/^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(container.env)).not.toMatch(
        /operator-token-fixture|runtime-token-fixture|X-Goog-Signature/,
      );
      const env = Object.fromEntries(container.env.map((v: { name: string; value: string }) => [v.name, v.value]));
      if (options.role === 'file-app') {
        expect(Object.keys(env).sort()).toEqual(['BUCKET', 'GENERATION', 'OBJECT', 'PROBE_ROLE', 'PROJECT_NUMBER', 'SERVICE_ACCOUNT']);
        expect(JSON.stringify(container.env)).not.toContain(marker);
        expect(env.PROBE_ROLE).toBe('file-app');
      }
      await runInNewContext(container.args[1], {
        process: { env },
        fetch: worker,
        URL,
        URLSearchParams,
        Buffer,
        AbortSignal,
        console: { log: (value: string) => logs.push(value) },
      });
      return json({
        name: `${scope}/operations/run`,
        done: true,
        response: {
          name: `${job}/executions/exact-run`,
          succeededCount: options.failedCount ? 0 : 1,
          failedCount: options.failedCount,
          completionTime: '2026-11-20T18:01:00Z',
        },
      });
    }
    if (method === 'DELETE' && path === job) {
      if (options.deletionRejected) return json({}, 403);
      exists = false;
      return json({ name: `${scope}/operations/delete`, done: true, response: {} });
    }
    throw new Error('Unexpected control-plane request');
  });
  return {
    visited,
    controls,
    logs,
    loggingQuotaProjects,
    recorded,
    run: (override: Partial<typeof input> = {}) => {
      const { secretId, version, marker, ...common } = { ...input, ...override };
      return runAccessProbeJob(
        {
          token: local,
          gcpProjectId: project,
          region,
          runtimeServiceAccountEmail: email,
          environmentLabel: 'staging',
          recordTransferResources: (value) => {
            recorded.push(value);
            if (value?.probe) controls.push('save ' + value.probe.stage);
          },
        },
        options.role === 'file-app'
          ? { ...common, role: 'file-app' }
          : { ...common, role: options.role ?? 'app', secretId, version, marker },
      );
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('bounded access check in the scoped Cloud Run job', () => {
  // Anonymous reads returned HTML for media and JSON for metadata (both 401).
  // This authenticated 403 pair is reconstructed from that split and Google's
  // permission contract, not a recording of the Cloud Run identity.
  // https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get
  // https://docs.cloud.google.com/storage/docs/troubleshooting#403_Forbidden
  it('corroborates a non-JSON download rejection on the very same generation', async () => {
    const f = fixture({
      object: new Response(`<p>${email} does not have storage.objects.get access to the Google Cloud Storage object.</p>`, {
        status: 403, headers: { 'Content-Type': 'text/html' },
      }),
    });
    expect(await f.run()).toEqual({
      ok: true,
      fileEvidence: {
        outcome: 'denied',
        media: { status: 403, classification: 'non-json-forbidden' },
        metadata: { status: 403, classification: 'permission-denied' },
      },
    });
    expect(f.visited.slice(-3)).toEqual([secret, object, metadata]);
  });
  it('requires permission-specific denials from both APIs and cleans up the owned job', async () => {
    const f = fixture();
    expect(await f.run()).toEqual({
      ok: true,
      fileEvidence: { outcome: 'denied', media: { status: 403, classification: 'permission-denied' } },
    });
    expect(f.visited.slice(-2)).toEqual([secret, object]);
    expect(f.recorded.at(-1)).toBeNull();
    expect(f.recorded.at(-2)?.jobUid).toBe('native-uid');
  });
  it('proves a copy only through the pinned secret and an unauthenticated signed GET on its generation', async () => {
    const f = fixture({ role: 'copy' });
    expect(await f.run()).toEqual({ ok: true });
    expect(f.visited.slice(-2)).toEqual([secret, signed]);
    expect(f.loggingQuotaProjects).toEqual([project]);
    expect(f.logs.join(' ')).not.toMatch(/X-Goog-|runtime-token-fixture/);
    expect(f.logs.join(' ')).not.toContain(marker);
  });
  it('tests only the fresh generation as the app without any secret reference or secret access', async () => {
    const f = fixture({ role: 'file-app', secret: new Response('PRIVATE SECRET') });
    expect(await f.run()).toMatchObject({ ok: true, fileEvidence: { outcome: 'denied' } });
    expect(f.visited.filter((url) => url.startsWith('https:'))).toEqual([object]);
    expect(f.recorded.at(-1)).toBeNull();
  });
  it.each([{ marker }, { secretId: input.secretId }, { version: input.version }])(
    'rejects a file-only job carrying an unexpected challenge or secret reference before any cloud call', async (extra) => {
      const { marker: omitted, secretId, version, ...scope } = input;
      const token = vi.fn(async () => 'unused');
      const ctx = { token, gcpProjectId: project, region, runtimeServiceAccountEmail: email, environmentLabel: 'staging', recordTransferResources: vi.fn() };
      // @ts-expect-error Simulate an untyped caller trying to submit a forbidden field.
      expect((await runAccessProbeJob(ctx, { ...scope, role: 'file-app', ...extra })).ok).toBe(false);
      expect(token).not.toHaveBeenCalled();
    },
  );
  it.each([200, 206])('reports direct file access on HTTP %s without reading the response body', async (status) => {
    const response = new Response('PRIVATE UNEXPECTED FILE', { status });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const f = fixture({ role: 'file-app', object: response });
    const result = await f.run();
    expect(result).toMatchObject({ ok: false, fileEvidence: { outcome: 'readable', media: { status, classification: 'readable' } } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.visited).not.toContain(metadata);
    expect(JSON.stringify([f.logs, result])).not.toMatch(/PRIVATE UNEXPECTED FILE|runtime-token-fixture/);
    expect(JSON.stringify([f.logs, result])).not.toContain(marker);
  });
  it.each([
    [401, 'Anonymous caller does not have storage.objects.get access to the Google Cloud Storage object.'],
    [403, "Request is prohibited by organization's policy."],
    [403, 'Request had insufficient authentication scopes.'],
    [403, 'someone-else does not have storage.objects.get access to the Google Cloud Storage object.'],
    [403, `another-${email} does not have storage.objects.get access to the Google Cloud Storage object.`],
    [403, 'PRIVATE UNRECOGNIZED ERROR'],
    [404, 'Not Found'],
    [503, 'Unavailable'],
  ] as const)('keeps HTTP %s inconclusive for %s', async (status, body) => {
    const f = fixture({ role: 'file-app', object: new Response(body, { status }) });
    const result = await f.run();
    expect(result).toMatchObject({ ok: false, fileEvidence: { outcome: 'inconclusive', media: { status, classification: 'inconclusive' } } });
    expect(f.visited).not.toContain(metadata);
    expect(JSON.stringify([f.logs, result])).not.toContain(body);
  });
  it.each([
    [200, {}, 'readable'],
    [401, {}, 'inconclusive'],
    [403, { error: { code: 403, message: 'Forbidden' } }, 'inconclusive'],
    [403, { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'SECURITY_POLICY_VIOLATED' }] } }, 'inconclusive'],
    [404, {}, 'inconclusive'],
  ] as const)('requires matching permission evidence even if metadata returns HTTP %s', async (status, body, classification) => {
    const f = fixture({ role: 'file-app', object: new Response('Forbidden', { status: 403 }), metadata: json(body, status) });
    expect(await f.run()).toMatchObject({
      ok: false, fileEvidence: { outcome: 'inconclusive', media: { status: 403, classification: 'non-json-forbidden' }, metadata: { status, classification } },
    });
    expect(f.visited.slice(-2)).toEqual([object, metadata]);
  });
  it('retains a validated file observation if job cleanup remains unresolved', async () => {
    const f = fixture({ role: 'file-app', deletionRejected: true });
    expect(await f.run()).toMatchObject({ ok: false, accessPassed: true, error: expect.stringContaining('Cleanup'), fileEvidence: { outcome: 'denied' } });
    expect(f.recorded.at(-1)?.jobUid).toBe('native-uid');
  });
  it.each([true, false])('rejects a log claiming a failed check only needs cleanup (deletion rejected: %s)', async (deletionRejected) => {
    const result = await fixture({
      role: 'file-app', deletionRejected, logResult: {
        ok: false, check: 'cleanup', accessPassed: true,
        fileEvidence: { outcome: 'denied', media: { status: 403, classification: 'permission-denied' } },
      },
    }).run();
    expect(result.ok).toBe(false);
    expect(result.accessPassed).toBeUndefined();
  });
  it.each([
    { ok: true },
    { ok: true, fileEvidence: { outcome: 'denied', media: { status: 200, classification: 'permission-denied' } } },
    { ok: true, fileEvidence: { outcome: 'denied', media: { status: 403, classification: 'non-json-forbidden' } } },
    { ok: true, fileEvidence: { outcome: 'denied', media: { status: 403, classification: 'permission-denied', body: 'PRIVATE' } } },
    { ok: false, check: 'object-denial', fileEvidence: { outcome: 'inconclusive', media: { status: 98765, classification: 'PRIVATE' } } },
  ])('never returns malformed, overbroad or contradictory file evidence from a log', async (logResult) => {
    const result = await fixture({ role: 'file-app', logResult }).run();
    expect(result.ok).toBe(false);
    expect(result.fileEvidence).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it.each([
    'missing',
    'disabled',
    'no-iam-evidence',
    'wrong-permission',
    'scopes',
    'secret-readable',
    'file-readable',
  ] as const)('rejects incomplete denials: %s', async (scenario) => {
    const body = new Response('PRIVATE OVERSHARED BODY');
    const cancel = vi.spyOn(body.body!, 'cancel');
    const responses: Record<string, FixtureOptions> = {
      missing: { object: json({}, 404) },
      disabled: {
        secret: json(
          { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } },
          403,
        ),
      },
      'no-iam-evidence': { object: json({ error: { code: 403, message: 'forbidden' } }, 403) },
      'wrong-permission': { secret: accessDenial('secretmanager.secrets.get') },
      scopes: { token: json({}, 403) },
      'secret-readable': { secret: body },
      'file-readable': { object: body },
    };
    const f = fixture(responses[scenario]);
    const result = await f.run();
    expect(result.ok).toBe(false);
    expect(JSON.stringify([result, f.logs])).not.toContain('PRIVATE OVERSHARED BODY');
    if (scenario === 'secret-readable' || scenario === 'file-readable') expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(['identity', 'job-identity', 'program', 'terminal-failure'] as const)(
    'rejects mismatched runtime evidence: %s',
    async (scenario) => {
      const f = fixture({
        email: scenario === 'identity' ? 'foreign' : email,
        observedEmail: scenario === 'job-identity' ? 'foreign' : email,
        observedScriptChanged: scenario === 'program',
        failedCount: scenario === 'terminal-failure' ? 1 : 0,
      });
      expect((await f.run()).ok).toBe(false);
      if (scenario === 'identity') expect(f.visited).toHaveLength(1);
      if (scenario === 'job-identity' || scenario === 'program')
        expect(f.controls.some((call) => call.endsWith(':run'))).toBe(false);
    },
  );
  it.each([
    'foreign-host',
    'foreign-path',
    'other-generation',
    'duplicate',
    'extra',
    'unsigned',
    'ttl',
    'payload',
    'resource',
    'bad-marker',
    'bad-bytes',
    'redirect',
  ] as const)('rejects unverified copy evidence: %s', async (scenario) => {
    const url = new URL(signed);
    if (scenario === 'foreign-host') url.host = 'other.invalid';
    if (scenario === 'foreign-path') url.pathname += '/elsewhere';
    if (scenario === 'other-generation') url.searchParams.set('generation', '1');
    if (scenario === 'duplicate') url.searchParams.append('generation', input.generation);
    if (scenario === 'extra') url.searchParams.append('uploadId', 'fake');
    if (scenario === 'unsigned') url.searchParams.delete('X-Goog-Signature');
    if (scenario === 'ttl') url.searchParams.set('X-Goog-Expires', '901');
    const f = fixture({
      role: 'copy',
      secret:
        scenario === 'payload'
          ? json({ payload: {} })
          : secretResult(
              { marker: scenario === 'bad-marker' ? 'foreign' : marker, url: url.href },
              scenario === 'resource' ? name + '2' : name,
            ),
      file:
        scenario === 'bad-bytes'
          ? new Response('foreign')
          : scenario === 'redirect'
            ? Response.redirect('https://other.invalid', 302)
            : undefined,
    });
    expect((await f.run()).ok).toBe(false);
    expect(f.visited).toHaveLength(['bad-bytes', 'redirect'].includes(scenario) ? 5 : 4);
  });
  it.each([
    { object: 'production/data' },
    { version: 'latest' },
    { generation: '' },
    { projectNumber: 'other' },
    { secretId: 'nested/id' },
    { expectedEmail: 'other@example.net' },
    { marker: 'not-a-challenge' },
  ])('rejects unscoped input before creating a job', async (override) => {
    const f = fixture();
    expect((await f.run(override)).ok).toBe(false);
    expect(f.controls).toEqual([]);
  });
});

describe('recovery across probe job creation and submission', () => {
  const context = { gcpProjectId: project, region, runtimeServiceAccountEmail: email, token: async () => 'fixture' };
  const jobId = 'hv-migrate-access-abcdef1234567890';
  const jobName = `projects/${project}/locations/${region}/jobs/${jobId}`;
  const ownershipToken = '12341234-1234-4123-a123-123456789012';
  it('journals the unsubmitted scope before create and the exact native revision before :run', async () => {
    const f = fixture();
    expect((await f.run()).ok).toBe(true);
    expect(f.recorded[0]?.probe).toEqual({ stage: 'before-run', serviceAccount: email });
    expect(f.recorded.at(-2)).toMatchObject({
      jobUid: 'native-uid',
      probe: { stage: 'run-may-be-submitted', serviceAccount: email, etag: 'native-etag' },
    });
    expect(f.controls.indexOf('save before-run')).toBeLessThan(
      f.controls.findIndex((s) => s.endsWith('/jobs') && s.startsWith('POST ')),
    );
    expect(f.controls.indexOf('save run-may-be-submitted')).toBeLessThan(
      f.controls.findIndex((s) => s.endsWith(':run')),
    );
  });
  it.each([
    'owned',
    'twice-interrupted',
    'missing-journal',
    'journal-write-failed',
    'adopted-revision-changed',
    'acknowledged',
    'late-create',
    'pending-run',
    'foreign-account',
    'wrong-planned-account',
    'foreign-owner',
    'uid-changed',
    'etag-changed',
    'execution-seen',
    'unknown-inventory',
  ] as const)('fences cleanup after %s', async (scenario) => {
    let reads = 0;
    let deleted = false;
    const accepted = ['owned', 'acknowledged'].includes(scenario);
    const receipt: TransferResources = {
      gcpProjectId: project,
      region,
      jobId,
      secretIds: [],
      ownershipToken,
      jobUid: ['acknowledged', 'pending-run', 'adopted-revision-changed'].includes(scenario) ? 'owned-uid' : undefined,
      probe: {
        stage: scenario === 'pending-run' ? ('run-may-be-submitted' as const) : ('before-run' as const),
        serviceAccount: email,
        etag: scenario === 'adopted-revision-changed' ? 'old-revision' : scenario === 'pending-run' ? 'rev' : undefined,
      },
    };
    let durable = structuredClone(receipt);
    let uidAtDelete: string | undefined;
    let restarted = false;
    const recovery = {
      ...context,
      runtimeServiceAccountEmail: scenario === 'wrong-planned-account' ? 'unrelated' : email,
      recordTransferResources:
        scenario === 'missing-journal'
          ? undefined
          : async (next: TransferResources | null) => {
              if (scenario === 'journal-write-failed') throw new Error('Interrupted journal write');
              if (next) durable = structuredClone(next);
            },
    };
    vi.stubGlobal('fetch', async (location: string, opts: RequestInit = {}) => {
      const url = new URL(location);
      if (url.pathname.endsWith('/executions'))
        return scenario === 'unknown-inventory'
          ? json({}, 503)
          : json(scenario === 'execution-seen' ? { executions: [{ name: jobName + '/executions/run' }] } : {});
      if (url.pathname !== '/v2/' + jobName) throw new Error('Wrong scope');
      if (opts.method === 'DELETE') {
        uidAtDelete = durable.jobUid;
        expect(url.searchParams.get('etag')).toBe('rev');
        deleted = true;
        return json({ name: `projects/${project}/locations/${region}/operations/del`, done: true, response: {} });
      }
      reads++;
      if (deleted && scenario === 'twice-interrupted' && !restarted) return json({}, 503);
      if (deleted || scenario === 'late-create') return json({}, 404);
      return json({
        name: jobName,
        uid: scenario === 'uid-changed' && reads > 1 ? 'other-uid' : 'owned-uid',
        etag: scenario === 'etag-changed' && reads > 1 ? 'rev2' : 'rev',
        labels: {
          'managed-by': 'hypervibe',
          'hv-temporary': 'true',
          'hv-transfer': scenario === 'foreign-owner' ? 'different' : ownershipToken,
        },
        template: { template: { serviceAccount: scenario === 'foreign-account' ? 'other' : email } },
      });
    });
    expect(await recoverTerminalTransferResources(recovery, receipt)).toBe(accepted);
    if (scenario === 'twice-interrupted') {
      expect(uidAtDelete).toBe('owned-uid');
      expect(durable.probe).toMatchObject({ stage: 'before-run', serviceAccount: email, etag: 'rev' });
      restarted = true;
      expect(await recoverTerminalTransferResources(recovery, durable)).toBe(true);
    }
    expect(deleted).toBe(accepted || scenario === 'twice-interrupted');
  });
  it('accepts the documented legacy Secret Manager denial only for the exact pinned resource', async () => {
    const denied = (resource: string) =>
      json(
        {
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: `Permission 'secretmanager.versions.access' denied for resource '${resource}' (or it may not exist).`,
          },
        },
        403,
      );
    expect((await fixture({ secret: denied(name) }).run()).ok).toBe(true);
    expect((await fixture({ secret: denied(name + '0') }).run()).ok).toBe(false);
  });
});

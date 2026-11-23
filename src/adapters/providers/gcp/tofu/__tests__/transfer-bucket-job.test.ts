import { describe, expect, it } from 'vitest';
import { BUCKET_COPY_IMAGE, BUCKET_COPY_SCRIPT } from '../../gcp-transfer-bucket-workload.js';
import { transferSlot } from '../transfer-slot.js';
import { matchesTransferBucketJobState, transferBucketJob, verifyTransferBucketJobPlan, type TransferBucketJobEvidence } from '../transfer-bucket-job.js';

const scope = {
  target: { projectId: 'test-project', targetRegion: 'us-central1', sourceEnvironmentId: 'source',
    sourceRailwayProjectId: 'railway-project', sourceRailwayEnvironmentId: 'railway-production', targetEnvironmentId: 'dest' },
  storageName: 'documents', sourceBucketId: 'native-id', sourceBucketName: 'documents-hash', targetBucket: 'hv-12345678-test-documents',
};
const absent: TransferBucketJobEvidence = { projectNumber: '123', copyUniqueId: '234', bucketTimeCreated: '2025-12-03T05:05:05Z',
  jobUid: null, creator: false, viewer: false };
const owned = { ...absent, jobUid: '26d6ee00-846b-4a52-b63e-a80f93412a36', creator: true, viewer: true };
const slot = transferSlot(scope.target);

const job = transferBucketJob(scope);
const bucketRoles = { viewer: 'roles/storage.objectViewer', creator: 'roles/storage.objectCreator' } as const;
const jobName = 'projects/test-project/locations/us-central1/jobs/' + job.jobId;
function rows(existing = false) {
  return Object.entries(job.addresses).map(([key, address]) => {
    // The provider's plan flattens repeated blocks to lists and supplies empty
    // blocks/defaults. The runtime program in a native plan is literal shell.
    const stored = Object.values(job.configuration.files)[0] as {resource: Record<string, Record<string, Record<string, any>>>};
    const [type, name] = address.split('.') as [string, string];
    const after: Record<string, any> = structuredClone(stored.resource[type]![name]!);
    delete after.lifecycle;
    if (key === 'job') {
      after.run_execution_token = null;
      after.start_execution_token = null;
      const container = after.template[0].template[0].containers[0];
      container.args = container.args.map((argument: string) => argument.replaceAll('$${', '${').replaceAll('%%{', '%{'));
      container.env = container.env.map((v: object) => ({ ...v, value_source: [] }));
      if (existing) Object.assign(after, { uid: owned.jobUid, id: jobName, execution_count: 0, latest_created_execution: [] });
    } else {
      after.condition = [];
      if (existing) {
        after.bucket = 'b/' + scope.targetBucket;
        after.id = after.bucket + '/' + after.role + '/' + after.member;
      }
    }
    const after_unknown = existing ? {} : key === 'job' ? { id: true, uid: true, latest_created_execution: true,
      template: [{ template: [{ containers: [{ args: [false, false], env: [{ value_source: [] }, { value_source: [] }], startup_probe: true }] }] }] }
      : { id: true, etag: true, condition: [] };
    return { address, type, mode: 'managed', name, provider_name: 'registry.opentofu.org/hashicorp/google',
      change: { actions: existing ? ['no-op'] : ['create'], before: existing ? structuredClone(after) : null, after, after_unknown } };
  });
}

describe('reviewed Railway bucket copy job', () => {
  it('creates only two grants on the target bucket and one non-executing fixed job for the copy account', () => {
    const native = rows();
    expect(native).toHaveLength(3);
    for (const [key, role] of Object.entries(bucketRoles)) {
      const { after } = native.find(row => row.address === job.addresses[key as keyof typeof bucketRoles])!.change;
      expect(after).toMatchObject({ role, bucket: scope.targetBucket, member: slot.member });
    }
    const after = native.find(row => row.address === job.addresses.job)!.change.after;
    const task = after.template[0].template[0];
    expect(after).toMatchObject({ name: job.jobId, project: scope.target.projectId, location: scope.target.targetRegion,
      template: [{ task_count: 1, parallelism: 1, template: [{ max_retries: 0, service_account: slot.accountEmail }] }] });
    expect(task.containers).toHaveLength(1);
    expect(task.containers[0]).toMatchObject({ image: BUCKET_COPY_IMAGE, command: ['/bin/sh'], args: ['-c', BUCKET_COPY_SCRIPT],
      env: [{ name: 'HV_SOURCE_BUCKET', value: scope.sourceBucketName }, { name: 'HV_TARGET_BUCKET', value: scope.targetBucket }] });
    expect(BUCKET_COPY_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(verifyTransferBucketJobPlan({ resource_changes: native }, job, absent)).toBe(true);
    expect(verifyTransferBucketJobPlan({ resource_changes: rows(true) }, job, owned)).toBe(true);
  });
  it('binds both bucket identities and will not silently add another bucket grant for the same account', () => {
    for (const key of ['sourceBucketId', 'sourceBucketName', 'storageName', 'targetBucket'] as const) {
      const changed = transferBucketJob({ ...scope, [key]: scope[key] + '-new' });
      expect(changed.id).toBe(job.id);
      expect(changed.configuration).not.toEqual(job.configuration);
    }
    expect(() => transferBucketJob({ ...scope, targetBucket: 'wrong/bucket' })).toThrow();
  });
  it('rejects unknown or different job behavior, broader grants, additional changes and native drift', () => {
    const check = (edit: (nativeRows: ReturnType<typeof rows>) => void) => {
      const native = rows();
      edit(native);
      expect(verifyTransferBucketJobPlan({ resource_changes: native }, job, absent)).toBe(false);
    };
    for (const field of ['start_execution_token', 'run_execution_token']) {
      check(rows => { rows.find(row => row.address === job.addresses.job)!.change.after[field] = 'execute'; });
      check(rows => { Object.assign(rows.find(row => row.address === job.addresses.job)!.change.after_unknown, { [field]: true }); });
    }
    for (const mutate of [
      (t: any) => { t.containers[0].env.push({ name: 'HV_RAILWAY_CONFIG', value: 'private' }); },
      (t: any) => { t.containers[0].image = 'unreviewed:latest'; },
      (t: any) => { t.containers.push(t.containers[0]); },
      (t: any) => { t.service_account = 'application@example.com'; },
      (t: any) => { t.volumes = [{ name: 'unreviewed' }]; },
    ]) check(rows => mutate(rows.find(row => row.address === job.addresses.job)!.change.after.template[0].template[0]));
    check(rows => { rows.find(row => row.address === job.addresses.creator)!.change.after.role = 'roles/storage.objectAdmin'; });
    check(rows => { rows.find(row => row.address === job.addresses.viewer)!.change.after.bucket = 'unrelated'; });
    check(rows => { rows.push({ ...rows[0]!, address: 'google_project_iam_member.stray' }); });
    check(rows => { rows.pop(); });
    check(rows => { Object.assign(rows[0]!.change, { importing: { id: 'unowned' } }); });
    expect(verifyTransferBucketJobPlan({ resource_changes: rows(), deferred_changes: [{}] }, job, absent)).toBe(false);
    expect(verifyTransferBucketJobPlan({ resource_changes: rows(), resource_drift: [rows()[0]] }, job, absent)).toBe(false);
  });
  it('accepts only etag refreshes on owned, otherwise unchanged project permission rows', () => {
    const address = 'google_project_iam_member.grant_original';
    const identity = { project: scope.target.projectId, member: 'serviceAccount:app@test-project.iam.gserviceaccount.com', role: 'roles/storage.objectUser',
      id: 'test-project/roles/storage.objectUser/serviceAccount:app@test-project.iam.gserviceaccount.com', condition: [] };
    const before = { ...identity, etag: 'prior-policy' }, after = { ...identity, etag: 'current-policy' };
    const row = { address, mode: 'managed', type: 'google_project_iam_member', provider_name: 'registry.opentofu.org/hashicorp/google' };
    const drift = { ...row, change: { actions: ['update'], before, after } };
    const noop = { ...row, change: { actions: ['no-op'], before: after, after } };
    const doc = { resource_changes: [...rows(), noop], resource_drift: [drift] };
    const known = new Set([address]);
    expect(verifyTransferBucketJobPlan(doc, job, absent, known)).toBe(true);
    expect(verifyTransferBucketJobPlan(doc, job, absent, new Set())).toBe(false);
    const roleChange = { ...after, role: 'roles/owner' };
    expect(verifyTransferBucketJobPlan({ ...doc, resource_drift: [{ ...drift, change: { ...drift.change, after: roleChange } }] }, job, absent, known)).toBe(false);
    expect(verifyTransferBucketJobPlan({ ...doc, resource_changes: rows() }, job, absent, known)).toBe(false);
    expect(verifyTransferBucketJobPlan({ ...doc, resource_drift: [drift, drift] }, job, absent, known)).toBe(false);
  });
  it('matches the disabled job options written by the Google provider after creation', () => {
    const native = rows(true);
    const jobRow = native.find(row => row.address === job.addresses.job)!;
    const template = jobRow.change.after.template[0];
    const task = template.template[0];
    const container = task.containers[0];
    template.delay_execution = false;
    task.gpu_zonal_redundancy_disabled = false;
    container.sandbox_launcher = false;
    const matchesState = () => matchesTransferBucketJobState({ values: { root_module: {
      resources: native.map(({ change, ...row }) => ({ ...row, values: change.after })),
    } } }, job, owned);
    expect(matchesState()).toBe(true);
    expect(verifyTransferBucketJobPlan({ resource_changes: native }, job, owned)).toBe(true);
    for (const [block, key] of [[template, 'delay_execution'], [task, 'gpu_zonal_redundancy_disabled'], [container, 'sandbox_launcher']] as const) {
      for (const value of [true, 'false', {}, []]) {
        block[key] = value;
        expect(matchesState()).toBe(false);
        expect(verifyTransferBucketJobPlan({ resource_changes: native }, job, owned)).toBe(false);
      }
      block[key] = false;
    }
    task.sandbox_launcher = false;
    expect(matchesState()).toBe(false);
  });
  it('requires original native state and rejects a recreated job or mismatched, deposed or unowned bindings', () => {
    const resources = rows(true).map(({ change, ...row }) => ({ ...row, values: change.after }));
    const state = (resources: unknown[]) => ({ values: { root_module: { resources } } });
    expect(matchesTransferBucketJobState(state([]), job, absent)).toBe(true);
    expect(matchesTransferBucketJobState(state(resources), job, owned)).toBe(true);
    expect(matchesTransferBucketJobState(state(resources), job, absent)).toBe(false);
    expect(matchesTransferBucketJobState(state(resources.map(row => row.address === job.addresses.creator
      ? { ...row, values: { ...row.values, id: 'b/unowned' } } : row)), job, owned)).toBe(false);
    expect(matchesTransferBucketJobState(state(resources.map(row => row.address === job.addresses.job
      ? { ...row, values: { ...row.values, execution_count: 1 } } : row)), job, owned)).toBe(false);
    expect(matchesTransferBucketJobState(state(resources), job, { ...owned, jobUid: 'recreated' })).toBe(false);
    expect(matchesTransferBucketJobState(state(resources.map(row => ({ ...row, deposed_key: 'old' }))), job, owned)).toBe(false);
    expect(verifyTransferBucketJobPlan({ resource_changes: rows(true) }, job, absent)).toBe(false);
    expect(verifyTransferBucketJobPlan({ resource_changes: rows() }, job, owned)).toBe(false);
  });
});

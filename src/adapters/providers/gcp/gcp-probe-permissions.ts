import { z } from 'zod';
import type { TransferIsolationScope } from './tofu/transfer-isolation.js';
import { transferSlot } from './tofu/transfer-slot.js';
export class ProbeProblem extends Error {}
export function requireProbe(value: unknown, problem: string): asserts value {
  if (!value) throw new ProbeProblem(problem);
}
const softDeleteSchema = z.object({
  name: z.string(),
  timeCreated: z.string(),
  softDeletePolicy: z.object({ retentionDurationSeconds: z.string().regex(/^\d+$/) }).optional(),
  retentionPolicy: z.object({ retentionPeriod: z.string() }).optional(),
  versioning: z.object({ enabled: z.boolean() }).optional(),
  defaultEventBasedHold: z.boolean().optional(),
});
export async function checkProbePermissions(scope: TransferIsolationScope, token: string) {
  const project = scope.target.projectId,
    slot = transferSlot(scope.target);
  const read = async (url: string, method = 'GET', body?: unknown) => {
    const response = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    requireProbe(response.ok, 'Google could not verify the permissions and retention settings for this test.');
    return response.json();
  };
  const permission = async (url: string, permissions: string[], label: string, method = 'POST') => {
    const result = await read(url, method, method === 'POST' ? { permissions } : undefined);
    const granted = z.object({ permissions: z.array(z.string()) }).safeParse(result);
    requireProbe(
      granted.success && permissions.every((p) => granted.data.permissions.includes(p)),
      `The current Google login lacks access to ${label}.`,
    );
  };
  const bucketUrl = 'https://storage.googleapis.com/storage/v1/b/' + scope.bucket;
  const objPermissions = ['storage.objects.create', 'storage.objects.get', 'storage.objects.delete'];
  const bucket = await read(
    bucketUrl + '?fields=name,timeCreated,softDeletePolicy,retentionPolicy,versioning,defaultEventBasedHold',
  );
  const policy = softDeleteSchema.safeParse(bucket);
  requireProbe(
    policy.success &&
      policy.data.name === scope.bucket &&
      policy.data.timeCreated === scope.bucketTimeCreated &&
      !policy.data.defaultEventBasedHold &&
      !policy.data.retentionPolicy &&
      !policy.data.versioning?.enabled,
    'The original test bucket must allow generation-matched cleanup without an object hold, retention lock or object versioning.',
  );
  await Promise.all([
    ...[scope.runtimeEmail, slot.accountEmail].map((email) =>
      permission(
        'https://iam.googleapis.com/v1/projects/' +
          project +
          '/serviceAccounts/' +
          encodeURIComponent(email) +
          ':testIamPermissions',
        ['iam.serviceAccounts.actAs'],
        'run the job as ' + email,
      ),
    ),
    permission(
      'https://cloudresourcemanager.googleapis.com/v1/projects/' + project + ':testIamPermissions',
      [
        'run.jobs.create',
        'run.jobs.get',
        'run.jobs.run',
        'run.jobs.delete',
        'run.executions.list',
        'run.operations.get',
        'logging.logEntries.list',
        'serviceusage.services.use',
      ],
      'run and verify the two temporary jobs',
    ),
    permission(
      'https://secretmanager.googleapis.com/v1/projects/' +
        scope.projectNumber +
        '/secrets/' +
        slot.secretId +
        ':testIamPermissions',
      ['secretmanager.versions.add', 'secretmanager.versions.get', 'secretmanager.versions.destroy'],
      'create and destroy the disposable test version',
    ),
    permission(
      bucketUrl +
        '/iam/testPermissions?' +
        new URLSearchParams(objPermissions.map((p) => ['permissions', p] as [string, string])),
      objPermissions,
      'create, read and delete the test file',
      'GET',
    ),
  ]);
  return Number(policy.data.softDeletePolicy?.retentionDurationSeconds ?? 0);
}

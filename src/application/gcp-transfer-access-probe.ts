import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ProbeCreateRejected, transferProbeFixtures } from '../adapters/providers/gcp/gcp-transfer-probe-fixtures.js';
import { TransferEvidenceError } from '../adapters/providers/gcp/gcp-transfer-slot-evidence.js';
import { transferSlot } from '../adapters/providers/gcp/tofu/transfer-slot.js';
import {
  findTransferAccessProbeReport,
  loadProbe,
  probeActions,
  probeHistory,
  probeIdPattern,
  storeProbe,
  withProbeLock,
  type ProbePlan,
  type ProbeRun,
} from '../adapters/storage/transfer-access-probe.js';
import {
  inspectProbeReadiness,
  originalProbeScope,
  ProbeProblem,
  requireProbe,
  type AccessProbeRequest,
} from './gcp-transfer-access-readiness.js';
import { probeWorkloadDigest } from '../adapters/providers/gcp/gcp-transfer-probe-workload.js';
import { recoverTerminalTransferResources, runAccessProbeJob, type TransferContext } from './migration-transfer-gcp.js';

function publicPlan(plan: ProbePlan) {
  const result = findTransferAccessProbeReport(plan.projectId, plan.scope.target.projectId, plan.planId);
  requireProbe(result, 'The saved HTML review could not be opened.');
  return {
    planId: plan.planId,
    htmlPath: result.htmlPath,
    actions: plan.actions,
    softDeleteSeconds: plan.softDeleteSeconds,
  };
}

async function runSavedCheck(input: AccessProbeRequest) {
  const { project, target, planId } = input;
  const scope = originalProbeScope(input),
    slot = transferSlot(target);
  requireProbe(
    input.confirm ? typeof planId === 'string' && probeIdPattern.test(planId) : planId === undefined,
    'Confirm only the exact saved access check ID from the HTML review.',
  );
  const saved = planId ? loadProbe(project.id, target.projectId, planId) : undefined;
  requireProbe(
    !input.confirm ||
      (saved &&
        isDeepStrictEqual(scope, saved.plan.scope) &&
        saved.plan.sourceName === input.sourceEnvironmentName &&
        saved.plan.deployEmail === input.deployEmail),
    'The saved access check does not match this source, destination and Google project.',
  );
  if (saved?.run.status === 'passed')
    return {
      success: true,
      mode: 'confirm',
      ...publicPlan(saved.plan),
      message:
        'This single-use test already passed and its cleanup was verified. Its results describe the time of the test.',
    };
  requireProbe(
    saved?.run.status !== 'failed',
    'This single-use test ended without verifying access. Preview a new check to try again.',
  );
  const active = probeHistory(project.id, target.projectId, slot.secretId).find((x) => x.run.status === 'running');
  requireProbe(
    !active || active.plan.planId === planId,
    `Finish cleanup for the interrupted access check ${active?.plan.planId} before starting another.`,
  );
  const token = await input.token();
  const id = saved?.plan.planId ?? 'probe-' + randomUUID();
  const fixtures = transferProbeFixtures(token, scope, id.slice('probe-'.length));
  const previousRun = saved?.run.status === 'running';
  const ready = previousRun ? undefined : await inspectProbeReadiness(input, token);
  if (!previousRun) await fixtures.assertReady();
  const proposed: Omit<ProbePlan, 'actions'> = saved?.plan ?? {
    planId: id,
    createdAt: new Date().toISOString(),
    projectId: project.id,
    projectName: project.name,
    sourceName: input.sourceEnvironmentName,
    scope,
    deployEmail: input.deployEmail,
    evidenceDigest: ready!.evidenceDigest,
    inventoryDigest: ready!.inventoryDigest,
    softDeleteSeconds: ready!.softDeleteSeconds,
    workloadDigest: probeWorkloadDigest,
    objectName: fixtures.objectName,
  };
  const plan: ProbePlan = saved?.plan ?? { ...proposed, actions: probeActions(proposed) };
  if (!input.confirm) {
    storeProbe(plan, { status: 'ready' }, true);
    return {
      success: true,
      mode: 'preview',
      ...publicPlan(plan),
      message: 'Review the two test jobs, the disposable data and cleanup before running the check.',
    };
  }
  requireProbe(
    plan.objectName === fixtures.objectName &&
      (previousRun ||
        (plan.evidenceDigest === ready!.evidenceDigest &&
          plan.inventoryDigest === ready!.inventoryDigest &&
          plan.softDeleteSeconds === ready!.softDeleteSeconds &&
          plan.workloadDigest === probeWorkloadDigest &&
          isDeepStrictEqual(plan.actions, probeActions(proposed)))),
    'The access check or its Google Cloud settings changed. Preview the test again.',
  );
  const run = saved!.run;
  const save = (update: Partial<ProbeRun>) => {
    Object.assign(run, update);
    storeProbe(plan, run);
  };
  const ctx = {
    gcpProjectId: target.projectId,
    region: target.targetRegion,
    token: input.token,
    environmentLabel: scope.targetEnvironmentName,
    recordTransferResources: (job: ProbeRun['job'] | null) => save({ job: job ?? undefined }),
  };
  // A retry may finish cleanup. It cannot issue a second job execution or publish a second version.
  let failure = 'The interrupted test did not finish both access checks.';
  if (!previousRun) {
    const marker = randomBytes(32).toString('hex');
    save({ status: 'running', marker });
    try {
      const object = await fixtures.createObject(marker, () => save({ pending: 'object' }));
      save({ object, pending: undefined });
      await fixtures.readObject(object, marker);
      const url = ready!.sign(object.name, object.generation);
      const version = await fixtures.addVersion(marker, url, object, () => save({ pending: 'version' }));
      save({ version, pending: undefined });
      const common = {
        projectNumber: scope.projectNumber,
        secretId: slot.secretId,
        version: version.name.split('/').at(-1)!,
        bucket: scope.bucket,
        object: object.name,
        generation: object.generation,
        marker,
      };
      for (const role of ['copy', 'app'] as const) {
        const expectedEmail = role === 'copy' ? slot.accountEmail : scope.runtimeEmail;
        failure =
          role === 'copy'
            ? 'The copy account did not prove it could read the test version and download the expected bytes.'
            : 'The app did not prove it received permission denied for both the test version and the file.';
        const job = await runAccessProbeJob(
          { ...ctx, runtimeServiceAccountEmail: expectedEmail } satisfies TransferContext,
          { ...common, role, expectedEmail },
        );
        if (!job.ok) {
          if (job.error) failure = job.error;
          break;
        }
        save(role === 'copy' ? { copyPassed: true } : { appPassed: true });
      }
    } catch (error) {
      if (error instanceof ProbeCreateRejected && error.resource === run.pending) save({ pending: undefined });
      if (!run.version) failure = 'The disposable file and version could not both be prepared and verified.';
    }
  }
  // Resource receipts are persisted immediately after each successful operation, before the next API call.
  // Preserve unknown outcomes instead of repeating a non-idempotent create or destroying an unidentified version.
  const waiting: string[] = [];
  if (run.job) {
    try {
      const recovered = await recoverTerminalTransferResources(
        { ...ctx, runtimeServiceAccountEmail: run.copyPassed ? scope.runtimeEmail : slot.accountEmail },
        run.job,
      );
      if (recovered) save({ job: undefined });
      else waiting.push('temporary job');
    } catch {
      waiting.push('temporary job');
    }
  }
  if (run.pending === 'object') {
    try {
      const owned = await fixtures.recoverObject(run.marker!);
      if (owned) save({ object: owned, pending: undefined });
      else waiting.push('unacknowledged file upload');
    } catch {
      waiting.push('unacknowledged file upload');
    }
  }
  if (run.pending === 'version') {
    if (previousRun) {
      try {
        save({ version: await fixtures.recoverVersion(run.marker!, plan.createdAt), pending: undefined });
      } catch {
        waiting.push('Google audit record for the unacknowledged version');
      }
    } else waiting.push('Google audit record for the unacknowledged version');
  }
  if (run.version && !run.destroyed) {
    try {
      save({ destroyed: await fixtures.destroyVersion(run.version) });
    } catch {
      waiting.push('test version');
    }
  }
  if (run.object) {
    try {
      await fixtures.deleteObject(run.object);
      save({ object: undefined });
    } catch {
      waiting.push('test file');
    }
  }
  requireProbe(
    !waiting.length,
    `Cleanup is unverified for the ${waiting.join(' and ')}. Resume ${id} to check its recorded resources. A retry only finishes cleanup.`,
  );
  if (run.copyPassed && run.appPassed && run.destroyed) {
    try {
      await inspectProbeReadiness(input, await input.token());
    } catch {
      throw new ProbeProblem(
        `The test jobs finished, but final verification of the account permissions and secret inventory is incomplete. Resume ${id} to verify cleanup.`,
      );
    }
    save({ status: 'passed', finishedAt: new Date().toISOString(), marker: undefined });
    return {
      success: true,
      mode: 'confirm',
      ...publicPlan(plan),
      message:
        'The copy account read the disposable version and downloaded the expected file. Google denied both direct reads by the app. The jobs are gone, the version is destroyed, and the file generation was deleted.',
    };
  }
  save({ status: 'failed', finishedAt: new Date().toISOString(), marker: undefined });
  throw new ProbeProblem(failure + ' The recorded fixtures were cleaned up. The production copy remains paused.');
}
export async function runGcpTransferAccessProbe(
  input: AccessProbeRequest,
): Promise<Record<string, unknown> & { success: boolean }> {
  try {
    return await withProbeLock(input.project.id, input.target.projectId, () => runSavedCheck(input));
  } catch (error) {
    const errorText =
      error instanceof ProbeProblem || error instanceof TransferEvidenceError
        ? error.message
        : (error as { code?: string })?.code === 'SQLITE_BUSY'
          ? 'Another project setup or access test is in progress. Try again when it finishes.'
          : 'Hypervibe could not verify the saved check, its original project state or the Google connection. The production copy remains paused.';
    return { success: false, error: errorText };
  }
}

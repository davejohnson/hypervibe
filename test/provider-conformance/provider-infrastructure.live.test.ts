import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectSpecSchema } from '../../src/domain/spec/spec.schema.js';
import {
  databaseProviderContracts,
  hostingProviderContracts,
  managedWorkflowGitHubCredentials,
  type ProviderCredentialField,
} from './provider-matrix.js';
import {
  actionIdsRequiringConfirmation,
  nonNoopActions,
  pendingInfrastructureReview,
  selectTriggeredWorkflowRun,
  terminalReceiptFailures,
} from './managed-workflow-harness.js';
import {
  buildLoadBalancerLiveSpec,
  buildRecoveryLiveSpec,
  restoreDrillResourceEvents,
  safeLoadBalancerBinding,
  safeOutstandingActions,
  successfulRestoreDrillEvidence,
  type JsonObject,
} from './infrastructure-live-harness.js';

type InfrastructureSelection =
  | 'cloudsql-recovery'
  | 'cloudflare-load-balancer';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(repositoryRoot, 'dist/index.js');
const selectedInfrastructure = process.env.HYPERVIBE_LIVE_INFRASTRUCTURE?.trim();
const liveDescribe = selectedInfrastructure ? describe : describe.skip;
const REVIEW_POLL_MS = 10_000;
const WORKFLOW_POLL_MS = 10_000;
const RESTORE_DRILL_WORKFLOW = 'hypervibe-db-restore-drill-production.yml';
const RECOVERY_ENVIRONMENT = 'production';
const LOAD_BALANCER_ENVIRONMENT = 'conformance';
const cloudflareCredentials: ProviderCredentialField[] = [
  { field: 'apiToken', environmentVariable: 'HYPERVIBE_TEST_CLOUDFLARE_API_TOKEN' },
  {
    field: 'accountId',
    environmentVariable: 'HYPERVIBE_TEST_CLOUDFLARE_ACCOUNT_ID',
    optional: true,
  },
];

let selection: InfrastructureSelection;
let workspace = '';
let dataDirectory = '';
let projectName = '';
let repository = '';
let loadBalancerHostname = '';
let resourcesMayExist = false;
let workflowReviewStarted = false;
let workflowInstalled = false;
let restoreDrillRunStarted = false;
let restoreDrillRunTerminal = false;
let restoreDrillCleanupBlockedReason = '';
let temporaryWorkspace = false;
let loadBalancerPhaseStarted = false;
let resumedWorkspace = false;

function positiveDuration(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds`);
  }
  return parsed;
}

function parseCredentialValue(
  credential: ProviderCredentialField,
  value: string
): unknown {
  try {
    if (credential.parseAs === 'json') return JSON.parse(value);
    if (credential.parseAs === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error('not a finite number');
      return parsed;
    }
    if (credential.parseAs === 'boolean') {
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error('not true or false');
    }
    return value;
  } catch {
    throw new Error(
      `${credential.environmentVariable} must contain a valid ${
        credential.parseAs ?? 'string'
      } value`
    );
  }
}

function requiredCredentials(
  fields: ProviderCredentialField[]
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const credential of fields) {
    const value = process.env[credential.environmentVariable];
    if (value === undefined || value.length === 0) {
      if (!credential.optional) missing.push(credential.environmentVariable);
      continue;
    }
    output[credential.field] = parseCredentialValue(credential, value);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing live-provider credential environment variables: ${missing.join(', ')}`
    );
  }
  return output;
}

async function runProcess(
  executable: string,
  args: string[],
  cwd: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(
        `${executable} ${args.join(' ')} failed (exit ${code}): ${stderr.slice(0, 2000)}`
      ));
    });
  });
}

async function runHypervibe(
  command: string[],
  input: JsonObject
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, ...command, '--input', '-', '--json'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HYPERVIBE_DATA_DIR: dataDirectory,
          HYPERVIBE_DISABLE_REPO_SPEC: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      let envelope: JsonObject;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        reject(new Error(
          `Hypervibe ${command.join(' ')} returned non-JSON output (exit ${code}). `
          + `${stderr.slice(0, 2000)} ${stdout.slice(0, 2000)}`
        ));
        return;
      }
      if (code !== 0 || envelope.ok !== true) {
        reject(new Error(
          `Hypervibe ${command.join(' ')} failed (exit ${code}): `
          + JSON.stringify(envelope.error ?? envelope).slice(0, 4000)
        ));
        return;
      }
      resolve(envelope);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function connectProvider(
  provider: string,
  credentials: ProviderCredentialField[],
  scope?: string
): Promise<void> {
  const credentialPath = path.join(
    dataDirectory,
    `.credentials-${provider}-${process.pid}.json`
  );
  writeFileSync(
    credentialPath,
    JSON.stringify(requiredCredentials(credentials)),
    { encoding: 'utf8', mode: 0o600 }
  );
  chmodSync(credentialPath, 0o600);
  try {
    await runHypervibe(['connect'], {
      provider,
      credentialsRef: `file:${credentialPath}`,
      ...(scope ? { scope } : {}),
    });
  } finally {
    rmSync(credentialPath, { force: true });
  }
}

function providerCredentials(
  kind: 'hosting' | 'database',
  provider: string
): ProviderCredentialField[] {
  const contract = kind === 'hosting'
    ? hostingProviderContracts.find((entry) => entry.provider === provider)
    : databaseProviderContracts.find((entry) => entry.provider === provider);
  if (!contract || contract.status === 'planned') {
    throw new Error(`${kind} provider ${provider} is not ready for live conformance.`);
  }
  return contract.credentials;
}

function recoverySpec(params: {
  github: boolean;
  replica: boolean;
  restoreDrill: boolean;
  database: boolean;
}): JsonObject {
  return buildRecoveryLiveSpec({
    projectName,
    repository,
    ...params,
  });
}

function loadBalancerSpec(params: {
  services: boolean;
  loadBalancer: boolean;
  healthCheckPath?: string;
}): JsonObject {
  return buildLoadBalancerLiveSpec({
    projectName,
    hostname: loadBalancerHostname,
    ...params,
  });
}

async function setSpec(spec: JsonObject): Promise<void> {
  await runHypervibe(['spec', 'set'], {
    project: projectName,
    replace: true,
    spec,
  });
}

async function plan(environmentName: string): Promise<JsonObject> {
  return runHypervibe(['plan'], {
    project: projectName,
    env: environmentName,
    includeEnvFile: false,
  });
}

function assertPlanCanApply(planEnvelope: JsonObject): void {
  expect(planEnvelope.data.blocked ?? []).toEqual([]);
  expect(planEnvelope.data.inputRequired ?? []).toEqual([]);
  expect(
    nonNoopActions(planEnvelope)
      .filter((action) => typeof action.metadata?.blockedReason === 'string')
  ).toEqual([]);
  expect(
    nonNoopActions(planEnvelope)
      .filter((action) => action.verified !== true)
  ).toEqual([]);
}

async function apply(planEnvelope: JsonObject): Promise<JsonObject> {
  return runHypervibe(['apply'], {
    project: projectName,
    planId: planEnvelope.data.planId,
    confirmActions: actionIdsRequiringConfirmation(planEnvelope),
  });
}

function assertNoTerminalApplyFailure(applyEnvelope: JsonObject): void {
  expect(terminalReceiptFailures(applyEnvelope)).toEqual([]);
}

async function convergeDirect(
  environmentName: string,
  options: { maxCycles?: number; cleanupOnly?: boolean } = {}
): Promise<JsonObject> {
  const maxCycles = options.maxCycles ?? 8;
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const currentPlan = await plan(environmentName);
    assertPlanCanApply(currentPlan);
    if (options.cleanupOnly) {
      const creates = nonNoopActions(currentPlan).filter(
        (action) => action.type === 'create'
      );
      if (creates.length > 0) {
        throw new Error(
          `Cleanup would create provider resources; refusing: ${JSON.stringify(
            safeOutstandingActions({ data: { actions: creates } })
          )}`
        );
      }
    }
    if (nonNoopActions(currentPlan).length === 0) return currentPlan;
    const applied = await apply(currentPlan);
    assertNoTerminalApplyFailure(applied);
    const pending = (applied.data.receipts as JsonObject[] ?? [])
      .filter((receipt) => receipt.status === 'pending');
    if (pending.length > 0) {
      throw new Error(
        `Direct lifecycle convergence returned pending receipts: ${JSON.stringify(
          pending.map((receipt) => receipt.actionId)
        )}`
      );
    }
    if (applied.data.applied !== true) {
      throw new Error(
        `Direct lifecycle convergence stopped before apply completed: ${JSON.stringify(
          (applied.data.receipts as JsonObject[] ?? []).map((receipt) => ({
            actionId: receipt.actionId,
            status: receipt.status,
          }))
        )}`
      );
    }
  }
  throw new Error(
    `Hypervibe did not converge ${environmentName} after ${maxCycles} plan/apply cycles.`
  );
}

async function convergeReviewedInfrastructure(
  environmentName: string,
  cleanupOnly = false
): Promise<void> {
  const timeoutMs = positiveDuration(
    'HYPERVIBE_LIVE_REVIEW_TIMEOUT_MS',
    30 * 60_000
  );
  const deadline = Date.now() + timeoutMs;
  let announcedUrl: string | undefined;

  while (Date.now() < deadline) {
    const currentPlan = await plan(environmentName);
    assertPlanCanApply(currentPlan);
    if (cleanupOnly) {
      const creates = nonNoopActions(currentPlan).filter(
        (action) => action.type === 'create'
      );
      if (creates.length > 0) {
        throw new Error(
          `Reviewed cleanup would create provider resources; refusing: ${JSON.stringify(
            safeOutstandingActions({ data: { actions: creates } })
          )}`
        );
      }
    }
    if (nonNoopActions(currentPlan).length === 0) return;
    const applied = await apply(currentPlan);
    assertNoTerminalApplyFailure(applied);
    const review = pendingInfrastructureReview(applied);
    if (!review) {
      if (applied.data.applied !== true) {
        throw new Error('Reviewed infrastructure apply stopped without a review URL or terminal success.');
      }
      continue;
    }
    workflowReviewStarted = true;
    if (announcedUrl !== review.pullRequestUrl) {
      announcedUrl = review.pullRequestUrl;
      process.stdout.write(
        `\nHypervibe infrastructure review required: ${review.pullRequestUrl}\n`
        + 'Merge that PR after review; this live test will continue automatically.\n'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, REVIEW_POLL_MS));
  }

  throw new Error(
    `Timed out waiting for the Hypervibe infrastructure review${
      announcedUrl ? ` at ${announcedUrl}` : ''
    }.`
  );
}

async function workflowIsActive(): Promise<boolean> {
  const workflows = await runHypervibe(['ci', 'status'], {
    project: projectName,
    repo: repository,
    include: ['workflows'],
  });
  if (workflows.data.workflows?.error) {
    throw new Error(
      `hv_ci_status could not inspect workflows: ${workflows.data.workflows.error}`
    );
  }
  return (workflows.data.workflows as JsonObject[] ?? []).some(
    (workflow) => workflow.path === `.github/workflows/${RESTORE_DRILL_WORKFLOW}`
      && workflow.state === 'active'
  );
}

async function waitForRestoreDrillRun(
  triggeredAfterMs: number,
  existingRunIds: Set<number>
): Promise<{ run: JsonObject; logs: unknown }> {
  const timeoutMs = positiveDuration(
    'HYPERVIBE_LIVE_WORKFLOW_TIMEOUT_MS',
    45 * 60_000
  );
  const deadline = Date.now() + timeoutMs;
  let run: JsonObject | null = null;

  while (Date.now() < deadline) {
    const status = await runHypervibe(['ci', 'status'], {
      project: projectName,
      repo: repository,
      include: ['runs'],
      workflow: RESTORE_DRILL_WORKFLOW,
    });
    if (status.data.runs?.error) {
      throw new Error(
        `hv_ci_status could not inspect restore-drill runs: ${status.data.runs.error}`
      );
    }
    run = selectTriggeredWorkflowRun(status.data.runs ?? [], {
      existingRunIds,
      triggeredAfterMs,
    });
    if (run?.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, WORKFLOW_POLL_MS));
  }

  if (!run || run.status !== 'completed') {
    throw new Error(`Timed out waiting for ${RESTORE_DRILL_WORKFLOW}.`);
  }
  const jobs = await runHypervibe(['ci', 'status'], {
    project: projectName,
    repo: repository,
    include: ['jobs'],
    runId: run.id,
  });
  if (jobs.data.jobs?.error) {
    throw new Error(
      `hv_ci_status could not inspect restore-drill jobs: ${jobs.data.jobs.error}`
    );
  }
  const logs = await runHypervibe(['ci', 'status'], {
    project: projectName,
    repo: repository,
    include: ['logs'],
    runId: run.id,
    logLines: 250,
  });
  if (logs.data.logs?.error) {
    throw new Error(
      `hv_ci_status could not inspect restore-drill logs: ${logs.data.logs.error}`
    );
  }
  const unsuccessfulJobs = (jobs.data.jobs as JsonObject[] ?? [])
    .filter((job) => !['success', 'skipped'].includes(job.conclusion));
  restoreDrillRunTerminal = true;
  const resourceEvents = restoreDrillResourceEvents(logs.data.logs);
  const unsafeTarget = resourceEvents.find((event) => (
    event.disposition === 'retained'
    || event.disposition === 'cleanup-failed'
    || (
      event.disposition === 'created'
      && !resourceEvents.some((candidate) => (
        candidate.target === event.target
        && candidate.disposition === 'deleted'
      ))
    )
  ));
  if (unsafeTarget) {
    restoreDrillCleanupBlockedReason =
      `Restore-drill target ${unsafeTarget.target} has disposition ${unsafeTarget.disposition}; `
      + 'the workflow and source database must remain available for inspected cleanup.';
  }
  if (run.conclusion !== 'success' || unsuccessfulJobs.length > 0) {
    throw new Error(
      `Restore drill ${run.id} failed: ${JSON.stringify({
        conclusion: run.conclusion,
        jobs: unsuccessfulJobs.map((job) => ({
          id: job.id,
          name: job.name,
          conclusion: job.conclusion,
        })),
        resources: resourceEvents,
        diagnostics: logs.data.diagnostics,
      }).slice(0, 12_000)}`
    );
  }
  return { run, logs: logs.data.logs };
}

async function waitForPublicHealth(): Promise<void> {
  const timeoutMs = positiveDuration(
    'HYPERVIBE_LIVE_HEALTH_TIMEOUT_MS',
    10 * 60_000
  );
  const deadline = Date.now() + timeoutMs;
  let lastCheck: JsonObject | undefined;
  while (Date.now() < deadline) {
    const health = await runHypervibe(['health'], {
      project: projectName,
      url: `https://${loadBalancerHostname}`,
      path: '/health',
      timeoutMs: 30_000,
    });
    lastCheck = health.data.check;
    if (lastCheck?.ok === true) return;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error(
    `Cloudflare load-balancer health did not converge: ${JSON.stringify(lastCheck ?? {})}`
  );
}

async function verifyRecoveryRepository(): Promise<void> {
  const specPath = path.join(workspace, '.hypervibe/spec.json');
  if (!existsSync(specPath)) {
    throw new Error(
      'The recovery live repository must contain a committed .hypervibe/spec.json bootstrap spec.'
    );
  }
  const worktreeSpec = readFileSync(specPath, 'utf8');
  const committedSpec = await runProcess(
    'git',
    ['show', 'HEAD:.hypervibe/spec.json'],
    workspace
  );
  if (worktreeSpec !== committedSpec) {
    throw new Error('.hypervibe/spec.json must be clean and committed before live recovery provisioning.');
  }
  const dirty = await runProcess('git', ['status', '--porcelain'], workspace);
  if (dirty.trim()) {
    throw new Error('The recovery live repository worktree must be clean before the contract starts.');
  }

  const parsed = projectSpecSchema.parse(JSON.parse(worktreeSpec));
  projectName = parsed.project;
  const expected = recoverySpec({
    github: false,
    replica: true,
    restoreDrill: false,
    database: true,
  });
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error(
      'The committed recovery bootstrap spec does not match the canonical fixture documented in docs/provider-conformance.md.'
    );
  }
}

async function safeCleanupDiagnostics(environmentName: string): Promise<string> {
  let outstanding: unknown = 'plan unavailable';
  try {
    outstanding = safeOutstandingActions(await plan(environmentName));
  } catch (error) {
    outstanding = error instanceof Error ? error.message : String(error);
  }
  let binding: unknown = null;
  const bindingsPath = path.join(workspace, '.hypervibe/bindings.json');
  if (existsSync(bindingsPath)) {
    try {
      binding = safeLoadBalancerBinding(
        JSON.parse(readFileSync(bindingsPath, 'utf8')),
        environmentName
      );
    } catch {
      binding = 'repo bindings unreadable';
    }
  }
  return JSON.stringify({
    outstanding,
    ...(binding ? { loadBalancerBinding: binding } : {}),
    workspace,
    dataDirectory,
  });
}

async function cleanupRecovery(assertExpectedLifecycle = false): Promise<void> {
  if (restoreDrillRunStarted && !restoreDrillRunTerminal) {
    throw new Error(
      'The dispatched restore-drill run has not been proven terminal; refusing to remove its workflow or source database.'
    );
  }
  if (restoreDrillCleanupBlockedReason) {
    throw new Error(restoreDrillCleanupBlockedReason);
  }
  const github = workflowReviewStarted || workflowInstalled;
  if (github) {
    await setSpec(recoverySpec({
      github: true,
      replica: true,
      restoreDrill: false,
      database: true,
    }));
    await convergeReviewedInfrastructure(RECOVERY_ENVIRONMENT, true);
    if (await workflowIsActive()) {
      throw new Error('The restore-drill workflow remains active after reviewed removal.');
    }
    workflowInstalled = false;
    workflowReviewStarted = false;
  }

  const currentPlan = await plan(RECOVERY_ENVIRONMENT);
  assertPlanCanApply(currentPlan);
  const primaryAction = (currentPlan.data.actions as JsonObject[] ?? [])
    .find((action) => action.id === 'database:cloudsql');
  const primaryBound = primaryAction?.type === 'noop'
    && primaryAction.verified === true;
  if (primaryAction?.type === 'noop' && primaryAction.verified !== true) {
    throw new Error('The Cloud SQL primary binding cannot be verified; refusing cleanup mutations.');
  }
  const replicaBound = (currentPlan.data.actions as JsonObject[] ?? []).some(
    (action) => (
      action.metadata?.operation === 'databaseReplicaDestroy'
      || (
        action.metadata?.operation === 'databaseReplicaProvision'
        && action.type === 'noop'
        && action.verified === true
      )
    )
  );

  if (primaryBound && replicaBound) {
    await setSpec(recoverySpec({
      github,
      replica: false,
      restoreDrill: false,
      database: true,
    }));
    const replicaTeardownPlan = await plan(RECOVERY_ENVIRONMENT);
    assertPlanCanApply(replicaTeardownPlan);
    if (assertExpectedLifecycle) {
      expect(nonNoopActions(replicaTeardownPlan)).toContainEqual(
        expect.objectContaining({
          type: 'destroy',
          metadata: expect.objectContaining({ operation: 'databaseReplicaDestroy' }),
        })
      );
    }
    await convergeDirect(RECOVERY_ENVIRONMENT, { cleanupOnly: true });
    const replicaPlan = await plan(RECOVERY_ENVIRONMENT);
    expect(nonNoopActions(replicaPlan).filter((action) => (
      action.metadata?.operation === 'databaseReplicaProvision'
      || action.metadata?.operation === 'databaseReplicaDestroy'
    ))).toEqual([]);
  } else if (assertExpectedLifecycle) {
    throw new Error('The successful recovery contract did not retain a bound replica for teardown verification.');
  }

  await setSpec(recoverySpec({
    github,
    replica: false,
    restoreDrill: false,
    database: false,
  }));
  const primaryTeardownPlan = await plan(RECOVERY_ENVIRONMENT);
  assertPlanCanApply(primaryTeardownPlan);
  if (assertExpectedLifecycle && primaryBound) {
    expect(nonNoopActions(primaryTeardownPlan)).toContainEqual(
      expect.objectContaining({
        type: 'destroy',
        resource: expect.objectContaining({ kind: 'database', provider: 'cloudsql' }),
      })
    );
  }
  expect(nonNoopActions(primaryTeardownPlan).filter((action) => (
    action.metadata?.operation === 'databaseReplicaDestroy'
  ))).toEqual([]);
  await convergeDirect(RECOVERY_ENVIRONMENT, { cleanupOnly: true });
  const verified = await plan(RECOVERY_ENVIRONMENT);
  expect(nonNoopActions(verified).filter((action) => (
    action.resource?.kind === 'database'
    || action.metadata?.operation === 'databaseRestoreDrillSchedule'
  ))).toEqual([]);
  resourcesMayExist = false;
}

async function cleanupLoadBalancer(assertExpectedLifecycle = false): Promise<void> {
  if (loadBalancerPhaseStarted) {
    await setSpec(loadBalancerSpec({ services: true, loadBalancer: false }));
    const teardownPlan = await plan(LOAD_BALANCER_ENVIRONMENT);
    assertPlanCanApply(teardownPlan);
    const teardownActions = nonNoopActions(teardownPlan).filter(
      (action) => action.resource?.kind === 'load-balancer'
    );
    if (assertExpectedLifecycle) {
      expect(teardownActions.map((action) => action.metadata?.operation)).toEqual([
        'loadBalancerDestroy',
        'loadBalancerPoolDestroy',
        'loadBalancerMonitorDestroy',
      ]);
      expect(teardownActions[1]?.dependsOn).toContain(teardownActions[0]?.id);
      expect(teardownActions[2]?.dependsOn).toContain(teardownActions[1]?.id);
    }
    await convergeDirect(LOAD_BALANCER_ENVIRONMENT, { cleanupOnly: true });
    const withoutLoadBalancer = await plan(LOAD_BALANCER_ENVIRONMENT);
    expect(nonNoopActions(withoutLoadBalancer).filter(
      (action) => action.resource?.kind === 'load-balancer'
    )).toEqual([]);
    expect((withoutLoadBalancer.data.unmanaged as JsonObject[] ?? []).filter(
      (item) => item.kind === 'load-balancer'
    )).toEqual([]);
    loadBalancerPhaseStarted = false;
  }

  await setSpec(loadBalancerSpec({ services: false, loadBalancer: false }));
  await convergeDirect(LOAD_BALANCER_ENVIRONMENT, { cleanupOnly: true });
  const verified = await plan(LOAD_BALANCER_ENVIRONMENT);
  expect(nonNoopActions(verified).filter((action) => (
    action.resource?.kind === 'load-balancer'
    || action.resource?.kind === 'service'
  ))).toEqual([]);
  resourcesMayExist = false;
}

async function runRecoveryContract(): Promise<void> {
  resourcesMayExist = true;
  await setSpec(recoverySpec({
    github: false,
    replica: true,
    restoreDrill: false,
    database: true,
  }));
  await convergeDirect(RECOVERY_ENVIRONMENT);
  const resilienceNoop = await plan(RECOVERY_ENVIRONMENT);
  expect(nonNoopActions(resilienceNoop).filter((action) => (
    action.metadata?.operation === 'databaseBackupPolicyConfigure'
    || action.metadata?.operation === 'databaseReplicaProvision'
  ))).toEqual([]);

  await setSpec(recoverySpec({
    github: true,
    replica: true,
    restoreDrill: true,
    database: true,
  }));
  await convergeReviewedInfrastructure(RECOVERY_ENVIRONMENT);
  workflowInstalled = await workflowIsActive();
  expect(workflowInstalled).toBe(true);

  const existingRuns = await runHypervibe(['ci', 'status'], {
    project: projectName,
    repo: repository,
    include: ['runs'],
    workflow: RESTORE_DRILL_WORKFLOW,
  });
  if (existingRuns.data.runs?.error) {
    throw new Error(
      `hv_ci_status could not inspect existing restore-drill runs: ${existingRuns.data.runs.error}`
    );
  }
  const existingRunIds = new Set<number>(
    (existingRuns.data.runs as JsonObject[] ?? [])
      .map((run) => run.id)
      .filter((id): id is number => typeof id === 'number')
  );
  const triggeredAfterMs = Date.now();
  await runHypervibe(['ci', 'trigger'], {
    project: projectName,
    repo: repository,
    workflow: RESTORE_DRILL_WORKFLOW,
    ref: 'main',
  });
  restoreDrillRunStarted = true;
  const result = await waitForRestoreDrillRun(triggeredAfterMs, existingRunIds);
  expect(result.run).toMatchObject({
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
  });
  const evidence = successfulRestoreDrillEvidence(result.logs);
  if (!evidence.ok) {
    restoreDrillCleanupBlockedReason = evidence.reason;
    throw new Error(evidence.reason);
  }

  const noop = await plan(RECOVERY_ENVIRONMENT);
  expect(nonNoopActions(noop).filter((action) => (
    action.resource?.kind === 'database'
    || action.metadata?.operation === 'githubInfrastructurePullRequest'
  ))).toEqual([]);
  await cleanupRecovery(true);
}

async function runLoadBalancerContract(): Promise<void> {
  if (resumedWorkspace) {
    resourcesMayExist = true;
    await cleanupLoadBalancer();
    resumedWorkspace = false;
  }
  resourcesMayExist = true;
  await setSpec(loadBalancerSpec({ services: true, loadBalancer: false }));
  await convergeDirect(LOAD_BALANCER_ENVIRONMENT);

  await setSpec(loadBalancerSpec({ services: true, loadBalancer: true }));
  loadBalancerPhaseStarted = true;
  const createPlan = await plan(LOAD_BALANCER_ENVIRONMENT);
  assertPlanCanApply(createPlan);
  const loadBalancerCreates = nonNoopActions(createPlan).filter(
    (action) => action.resource?.kind === 'load-balancer'
  );
  expect(loadBalancerCreates.map((action) => action.metadata?.operation)).toEqual([
    'loadBalancerMonitorEnsure',
    'loadBalancerPoolEnsure',
    'loadBalancerEnsure',
  ]);
  await convergeDirect(LOAD_BALANCER_ENVIRONMENT);
  await waitForPublicHealth();

  const noop = await plan(LOAD_BALANCER_ENVIRONMENT);
  expect(nonNoopActions(noop).filter(
    (action) => action.resource?.kind === 'load-balancer'
  )).toEqual([]);

  await setSpec(loadBalancerSpec({
    services: true,
    loadBalancer: true,
    healthCheckPath: '/',
  }));
  const updatePlan = await plan(LOAD_BALANCER_ENVIRONMENT);
  expect(nonNoopActions(updatePlan).filter(
    (action) => action.resource?.kind === 'load-balancer'
  )).not.toContainEqual(expect.objectContaining({ type: 'create' }));
  await convergeDirect(LOAD_BALANCER_ENVIRONMENT);

  const verifiedUpdate = await plan(LOAD_BALANCER_ENVIRONMENT);
  expect(nonNoopActions(verifiedUpdate).filter(
    (action) => action.resource?.kind === 'load-balancer'
  )).toEqual([]);
  await cleanupLoadBalancer(true);
}

liveDescribe('live recovery and load-balancer infrastructure contract', () => {
  beforeAll(async () => {
    if (
      selectedInfrastructure !== 'cloudsql-recovery'
      && selectedInfrastructure !== 'cloudflare-load-balancer'
    ) {
      throw new Error(
        `Unknown infrastructure live contract "${selectedInfrastructure}". `
        + 'Use cloudsql-recovery or cloudflare-load-balancer.'
      );
    }
    selection = selectedInfrastructure;
    if (!existsSync(cliPath)) {
      throw new Error('dist/index.js is missing. Run npm run build before the infrastructure live contract.');
    }

    if (selection === 'cloudsql-recovery') {
      const workspaceInput = process.env.HYPERVIBE_LIVE_REPOSITORY_WORKTREE?.trim();
      const dataDirectoryInput = process.env.HYPERVIBE_LIVE_DATA_DIR?.trim();
      repository = process.env.HYPERVIBE_TEST_GITHUB_REPOSITORY?.trim() ?? '';
      if (!workspaceInput || !path.isAbsolute(workspaceInput)) {
        throw new Error('HYPERVIBE_LIVE_REPOSITORY_WORKTREE must be an absolute disposable GitHub checkout.');
      }
      if (!dataDirectoryInput || !path.isAbsolute(dataDirectoryInput)) {
        throw new Error('HYPERVIBE_LIVE_DATA_DIR must be an absolute persistent cleanup-state directory.');
      }
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        throw new Error('HYPERVIBE_TEST_GITHUB_REPOSITORY must be owner/repository.');
      }
      workspace = path.resolve(workspaceInput);
      dataDirectory = path.resolve(dataDirectoryInput);
      mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
      chmodSync(dataDirectory, 0o700);
      await verifyRecoveryRepository();
      await setSpec(recoverySpec({
        github: false,
        replica: true,
        restoreDrill: false,
        database: true,
      }));
      await connectProvider('cloudsql', providerCredentials('database', 'cloudsql'));
      await connectProvider('cloudrun', providerCredentials('hosting', 'cloudrun'));
      await connectProvider('github', managedWorkflowGitHubCredentials, repository);
      return;
    }

    loadBalancerHostname = process.env.HYPERVIBE_TEST_CLOUDFLARE_LOAD_BALANCER_HOSTNAME?.trim().toLowerCase() ?? '';
    if (!/^hv-conformance-[a-z0-9-]+\.[a-z0-9.-]+$/.test(loadBalancerHostname)) {
      throw new Error(
        'HYPERVIBE_TEST_CLOUDFLARE_LOAD_BALANCER_HOSTNAME must be an isolated subdomain beginning with hv-conformance-.'
      );
    }
    const resumeWorkspace = process.env.HYPERVIBE_LIVE_REPOSITORY_WORKTREE?.trim();
    const resumeDataDirectory = process.env.HYPERVIBE_LIVE_DATA_DIR?.trim();
    if (Boolean(resumeWorkspace) !== Boolean(resumeDataDirectory)) {
      throw new Error(
        'Set both HYPERVIBE_LIVE_REPOSITORY_WORKTREE and HYPERVIBE_LIVE_DATA_DIR to resume preserved Cloudflare cleanup state, or omit both for a fresh run.'
      );
    }
    if (resumeWorkspace && resumeDataDirectory) {
      resumedWorkspace = true;
      if (!path.isAbsolute(resumeWorkspace) || !path.isAbsolute(resumeDataDirectory)) {
        throw new Error('Resumed Cloudflare workspace and data-directory paths must be absolute.');
      }
      workspace = path.resolve(resumeWorkspace);
      dataDirectory = path.resolve(resumeDataDirectory);
      const specPath = path.join(workspace, '.hypervibe/spec.json');
      if (!existsSync(specPath)) {
        throw new Error('The resumed Cloudflare workspace has no .hypervibe/spec.json cleanup authority.');
      }
      projectName = projectSpecSchema.parse(
        JSON.parse(readFileSync(specPath, 'utf8'))
      ).project;
      const bindingsPath = path.join(workspace, '.hypervibe/bindings.json');
      if (existsSync(bindingsPath)) {
        loadBalancerPhaseStarted = Boolean(safeLoadBalancerBinding(
          JSON.parse(readFileSync(bindingsPath, 'utf8')),
          LOAD_BALANCER_ENVIRONMENT
        ));
      }
    } else {
      temporaryWorkspace = true;
      workspace = mkdtempSync(path.join(tmpdir(), 'hypervibe-infrastructure-live-'));
      dataDirectory = path.join(workspace, '.hypervibe-data');
      projectName = `hv-conformance-cloudflare-${Date.now().toString(36)}`;
      cpSync(path.join(import.meta.dirname, 'fixture'), workspace, { recursive: true });
      await runProcess('git', ['init', '--initial-branch=main'], workspace);
    }
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
    await connectProvider('railway', providerCredentials('hosting', 'railway'));
    await connectProvider('cloudflare', cloudflareCredentials, loadBalancerHostname);
  }, 2 * 60_000);

  afterAll(async () => {
    if (!resourcesMayExist) {
      if (selection === 'cloudflare-load-balancer' && temporaryWorkspace && workspace) {
        rmSync(workspace, { recursive: true, force: true });
      }
      return;
    }
    try {
      if (selection === 'cloudsql-recovery') await cleanupRecovery();
      else await cleanupLoadBalancer();
    } catch (error) {
      const environmentName = selection === 'cloudsql-recovery'
        ? RECOVERY_ENVIRONMENT
        : LOAD_BALANCER_ENVIRONMENT;
      const diagnostics = await safeCleanupDiagnostics(environmentName);
      throw new Error(
        `Live infrastructure cleanup failed. Hypervibe state was preserved for retry. `
        + `${error instanceof Error ? error.message : String(error)} Diagnostics: ${diagnostics}`
      );
    }
    if (selection === 'cloudflare-load-balancer' && temporaryWorkspace && workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60 * 60_000);

  it('creates, verifies, updates, noops, and cleans up through reviewed desired state', async () => {
    if (selection === 'cloudsql-recovery') await runRecoveryContract();
    else await runLoadBalancerContract();
  }, 90 * 60_000);
});

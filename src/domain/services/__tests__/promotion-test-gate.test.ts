import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { parseDocument } from 'yaml';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { SpecStore } from '../../spec/spec.store.js';
import {
  buildBranchDeployWorkflow,
  githubActionsServerProgramFingerprint,
  githubActionsWorkflowInputHash,
  resolveBranchDeployTargets,
} from '../github-ops.service.js';
import { environmentDeploymentContractHash } from '../deployment-contract.service.js';
import { extractGitHubScript } from './managed-ci-workflow.test-utils.js';

const workflowPath = '.github/workflows/test.yml';
const candidate = 'a'.repeat(40);
const branchHead = 'b'.repeat(40);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

function desiredState(tests = true, packageReadToken?: boolean) {
  const services = {
    web: { workloadKind: 'web', startCommand: 'npm start' },
    worker: { workloadKind: 'worker', startCommand: 'npm run start:worker' },
  };
  return {
    version: 1,
    project: 'promotion-tests',
    gitRemoteUrl: 'https://github.com/acme/promotion-tests.git',
    runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
    devops: { code: { provider: 'github', scope: 'acme/promotion-tests' }, ci: { provider: 'github-actions' } },
    environments: {
      staging: { hosting: { provider: 'railway' }, services, deploy: { strategy: 'branch', trigger: 'ci' } },
      production: {
        hosting: { provider: 'cloudrun', region: 'us-central1' }, services,
        deploy: { strategy: 'branch', trigger: 'ci', promoteFrom: 'staging',
          ...(tests ? { promotionTests: { workflow: workflowPath,
            ...(packageReadToken === undefined ? {} : { packageReadToken }) } } : {}) },
      },
    },
  };
}

function expression(value: string, context: Record<string, unknown>) {
  // The emitted conditions use the shared Actions/JavaScript boolean subset.
  return runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), context, { timeout: 100 });
}

describe('production promotion full-test gate', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-promotion-tests-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(directory, 'test.db'));
  });
  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function compile(tests = true, packageReadToken?: boolean) {
    const project = new ProjectRepository().create({ name: 'promotion-tests', defaultPlatform: 'railway' });
    const environments = new EnvironmentRepository();
    environments.create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'railway', projectId: 'rail-project', environmentId: 'rail-staging',
      services: { web: { serviceId: 'rail-web' }, worker: { serviceId: 'rail-worker' } },
    } });
    environments.create({ projectId: project.id, name: 'production', platformBindings: {
      provider: 'cloudrun', projectId: 'gcp-project',
      providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      services: { web: { serviceId: 'production-web' }, worker: { serviceId: 'production-worker' } },
    } });
    const spec = projectSpecSchema.parse(desiredState(tests, packageReadToken));
    new SpecStore().replace(project, spec);
    const { targets, migration } = resolveBranchDeployTargets(project);
    const target = targets.find((entry) => entry.environmentName === 'production')!;
    const workflow = buildBranchDeployWorkflow('cloudrun', target, migration);
    const document = parseDocument(workflow.content, { uniqueKeys: true });
    expect(document.errors).toEqual([]);
    return { spec, target, migration, workflow, jobs: document.toJS().jobs };
  }

  it.each([undefined, false, true])('passes the exact candidate with only explicitly requested package access (%s)', async (packageReadToken) => {
    const { target, workflow, jobs } = compile(true, packageReadToken);
    expect(target.promotionTests?.packageReadToken === true).toBe(packageReadToken === true);
    expect(target.promotionTests?.workflow).toBe(workflowPath);
    expect(jobs.promotion_tests).toMatchObject({
      uses: `./${workflowPath}`, permissions: { contents: 'read' },
    });
    if (packageReadToken) {
      expect(jobs.promotion_tests.secrets).toEqual({ NODE_AUTH_TOKEN: '${{ secrets.NODE_AUTH_TOKEN }}' });
    } else {
      expect(jobs.promotion_tests.secrets).toBeUndefined();
    }
    expect(jobs.promotion_tests.environment).toBeUndefined();
    expect(jobs.promotion_tests.permissions).toEqual({ contents: 'read' });
    expect(workflow.requiredSecrets.includes('NODE_AUTH_TOKEN')).toBe(packageReadToken === true);

    for (const requested of [candidate, '']) {
      const inputs = { commit_sha: requested, rollback: false };
      const testedSha = expression(jobs.promotion_tests.with.commit_sha, { inputs, github: { sha: branchHead } });
      const outputs: Record<string, unknown> = {};
      await new AsyncFunction('context', 'process', 'core', extractGitHubScript(workflow.content, 'Resolve deploy SHA'))(
        { payload: { inputs } }, { env: { GITHUB_SHA: branchHead } },
        { setOutput: (key: string, value: unknown) => { outputs[key] = value; }, info() {} },
      );
      expect(testedSha).toBe(requested || branchHead);
      expect(outputs.sha).toBe(testedSha);
      const checkout = jobs.deploy.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@'));
      expect(expression(checkout.with.ref, { steps: { deploy: { outputs } } })).toBe(testedSha);
      const promotion = jobs.deploy.steps.find((step: { name?: string }) => step.name === 'Verify promotion release evidence');
      expect(expression(promotion.env.HYPERVIBE_PROMOTION_SHA, { steps: { deploy: { outputs } } })).toBe(testedSha);
    }
  });

  // GitHub's documented needs/if contract is the independent execution rule:
  // https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds
  it('blocks every deploy step after failed, cancelled, missing or skipped full tests', () => {
    const { jobs } = compile();
    expect(jobs.deploy.needs).toEqual('promotion_tests');
    for (const result of ['failure', 'cancelled', 'skipped', undefined, 'success']) {
      expect(expression(jobs.deploy.if, {
        always: () => true, cancelled: () => false,
        inputs: { rollback: false }, needs: { promotion_tests: { result } },
      })).toBe(result === 'success');
    }
    expect(expression(jobs.promotion_tests.if, { inputs: { rollback: false } })).toBe(true);
    expect(expression(jobs.promotion_tests.if, { inputs: { rollback: true } })).toBe(false);
    expect(expression(jobs.deploy.if, {
      always: () => true, cancelled: () => false,
      inputs: { rollback: true }, needs: { promotion_tests: { result: 'skipped' } },
    })).toBe(true);
    expect(expression(jobs.deploy.if, {
      always: () => true, cancelled: () => true,
      inputs: { rollback: false }, needs: { promotion_tests: { result: 'success' } },
    })).toBe(false);
  });

  it('changes workflow and deployment locks without changing the immutable application program', () => {
    const { spec, target, migration } = compile();
    const original = { ...target, promotionTests: undefined };
    expect(githubActionsWorkflowInputHash({ provider: 'cloudrun', target, migration }))
      .not.toBe(githubActionsWorkflowInputHash({ provider: 'cloudrun', target: original, migration }));
    expect(githubActionsServerProgramFingerprint({ provider: 'cloudrun', target, migration }))
      .toBe(githubActionsServerProgramFingerprint({ provider: 'cloudrun', target: original, migration }));
    expect(environmentDeploymentContractHash(spec, 'production'))
      .not.toBe(environmentDeploymentContractHash(projectSpecSchema.parse(desiredState(false)), 'production'));
    expect(environmentDeploymentContractHash(spec, 'staging'))
      .toBe(environmentDeploymentContractHash(projectSpecSchema.parse(desiredState(false)), 'staging'));
    const privateTarget = { ...target, promotionTests: { workflow: workflowPath, packageReadToken: true } };
    expect(githubActionsWorkflowInputHash({ provider: 'cloudrun', target: privateTarget, migration }))
      .not.toBe(githubActionsWorkflowInputHash({ provider: 'cloudrun', target, migration }));
    expect(githubActionsServerProgramFingerprint({ provider: 'cloudrun', target: privateTarget, migration }))
      .toBe(githubActionsServerProgramFingerprint({ provider: 'cloudrun', target, migration }));
    expect(environmentDeploymentContractHash(projectSpecSchema.parse(desiredState(true, true)), 'production'))
      .not.toBe(environmentDeploymentContractHash(spec, 'production'));
  });

  it('leaves production without the opt-in unchanged', () => {
    const { jobs } = compile(false);
    expect(jobs.promotion_tests).toBeUndefined();
    expect(jobs.deploy.needs).toBeUndefined();
  });

  it.each(['../test.yml', '.github/workflows/../test.yml', '.github/workflows/nested/test.yml',
    '.github/workflows/test.yml@main', '.github/workflows/${{ inputs.path }}.yml'])('rejects unsafe workflow path %s', (workflow) => {
    const spec = desiredState();
    spec.environments.production.deploy.promotionTests = { workflow };
    expect(projectSpecSchema.safeParse(spec).success).toBe(false);
  });

  it('requires explicit manual GitHub promotion for the test gate', () => {
    for (const change of ['provider', 'source', 'push']) {
      const spec = desiredState();
      if (change === 'provider') spec.devops.ci.provider = 'gitlab-ci';
      if (change === 'source') delete (spec.environments.production.deploy as { promoteFrom?: string }).promoteFrom;
      if (change === 'push') Object.assign(spec.environments.production.deploy, { autoDeploy: true });
      expect(projectSpecSchema.safeParse(spec).success).toBe(false);
    }
  });
});

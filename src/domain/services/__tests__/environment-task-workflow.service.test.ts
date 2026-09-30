import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { compileManagedGitHubFiles, githubSpecNeedsOpenAI } from '../github-infrastructure.service.js';

function spec(enabled = true) {
  return projectSpecSchema.parse({
    version: 1,
    project: 'example',
    github: {
      repository: 'owner/example',
      actions: {
        'tester-setup': {
          kind: 'environment-task', enabled, environment: 'staging', service: 'web',
          command: ['node', 'scripts/tester-setup.js'],
          inputs: {
            email: { type: 'string', flag: '--email', description: 'Tester email', required: true },
            dry_run: { type: 'boolean', flag: '--dry-run', description: 'Preview changes', default: true },
          },
        },
      },
    },
    environments: { staging: { hosting: { provider: 'railway' }, services: { web: {} } } },
  });
}

function compiled(desired = spec()) {
  const files = compileManagedGitHubFiles(desired.github!, desired.runtime);
  const file = files.find((entry) => entry.path === '.github/workflows/hypervibe-tester-setup.yml')!;
  return { files, file, workflow: parse(file.content) };
}

describe('managed environment-task workflow compiler', () => {
  it('owns a manual-only default-branch workflow in the normal manifest', () => {
    const { files, file, workflow } = compiled();
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs).toEqual({
      dry_run: { description: 'Preview changes', type: 'boolean', required: false, default: true },
      email: { description: 'Tester email', type: 'string', required: true, default: '' },
    });
    const job = workflow.jobs.task;
    expect(job.if).toBe("github.event_name == 'workflow_dispatch' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
    expect(job.environment).toBe('staging');
    expect(workflow.concurrency).toEqual({
      group: 'hypervibe-deploy-staging',
      'cancel-in-progress': false,
    });
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(job.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@')))
      .toMatchObject({ with: { ref: '${{ github.sha }}', 'persist-credentials': false } });
    expect(job.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/setup-node@')))
      .toMatchObject({ with: { 'node-version': '24' } });
    expect(JSON.parse(files.find((entry) => entry.path.endsWith('manifest.json'))!.content).files)
      .toContain(file.path);
    expect(file.review?.summary).toContain('staging');
    expect(githubSpecNeedsOpenAI(spec().github!)).toBe(false);
  });

  it('passes typed inputs only as JSON environment data and pins the public runner', () => {
    const { workflow } = compiled();
    const run = workflow.jobs.task.steps.find((step: { name?: string }) => step.name === 'Run reviewed environment task');
    expect(run.env).toMatchObject({
      HYPERVIBE_TASK_ID: 'tester-setup',
      HYPERVIBE_TASK_ENVIRONMENT: 'staging',
      HYPERVIBE_TASK_INPUTS_JSON: '${{ toJSON(inputs) }}',
      HYPERVIBE_TASK_RUN_ID: '${{ github.run_id }}',
      HYPERVIBE_TASK_RUN_ATTEMPT: '${{ github.run_attempt }}',
      RAILWAY_API_TOKEN: '${{ secrets.RAILWAY_API_TOKEN }}',
      IMAGE_REGISTRY_USERNAME: '${{ secrets.IMAGE_REGISTRY_USERNAME }}',
      IMAGE_REGISTRY_TOKEN: '${{ secrets.IMAGE_REGISTRY_TOKEN }}',
      GITHUB_TOKEN: '${{ github.token }}',
      HYPERVIBE_TASK_RECEIPT_PATH: '${{ runner.temp }}/hypervibe-task-receipt.json',
    });
    const install = workflow.jobs.task.steps.find((step: { name?: string }) => step.name === 'Install pinned Hypervibe runner');
    expect(install.run).toContain('@hypervibe/hypervibe@0.1.35');
    expect(run.run).toContain('@hypervibe/hypervibe/ci/environment-task');
    for (const step of workflow.jobs.task.steps.filter((entry: { run?: string }) => entry.run)) {
      expect(step.run).not.toContain('${{');
    }
    expect(workflow.jobs.task.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@')))
      .toMatchObject({ if: 'always()', with: { path: '${{ runner.temp }}/hypervibe-task-receipt.json' } });
  });

  it.each(['command', 'flag', 'receiptCountKeys'] as const)(
    'makes a reviewed %s change visible in the emitted workflow contract',
    (field) => {
      const baseline = compiled();
      const desired = spec();
      const task = desired.github!.actions['tester-setup'];
      if (task.kind !== 'environment-task') throw new Error('Expected environment task fixture');
      if (field === 'command') task.command = ['node', 'scripts/different-task.js'];
      if (field === 'flag') task.inputs.email.flag = '--tester-email';
      if (field === 'receiptCountKeys') task.receiptCountKeys = ['applied', 'skipped', 'propertyCreated'];
      const changed = compiled(desired);

      // Input names and descriptions stay identical: the full fixed task contract,
      // including argv, mapping and receipt fields, must still require file review.
      expect(changed.file.content).not.toBe(baseline.file.content);
      const runStep = (workflow: ReturnType<typeof compiled>['workflow']) => workflow.jobs.task.steps
        .find((step: { name?: string }) => step.name === 'Run reviewed environment task');
      const originalHash = runStep(baseline.workflow).env.HYPERVIBE_TASK_CONTRACT_HASH;
      const changedHash = runStep(changed.workflow).env.HYPERVIBE_TASK_CONTRACT_HASH;
      expect(originalHash).toMatch(/^[a-f0-9]{64}$/);
      expect(changedHash).toMatch(/^[a-f0-9]{64}$/);
      expect(changedHash).not.toBe(originalHash);
    }
  );

  it('executes the emitted shell and entry import without evaluating hostile input values', () => {
    const { workflow } = compiled();
    const directory = mkdtempSync(join(tmpdir(), 'hypervibe-task-workflow-'));
    try {
      const checkout = join(directory, 'checkout');
      const bin = join(directory, 'bin');
      mkdirSync(join(checkout, '.hypervibe'), { recursive: true });
      mkdirSync(bin);
      writeFileSync(join(checkout, '.hypervibe', 'spec.json'), JSON.stringify(spec()));
      writeFileSync(join(checkout, '.hypervibe', 'bindings.json'), '{}');
      const marker = join(directory, 'boundary.json');
      const injected = join(directory, 'injected');
      const inputs = { email: `$(touch ${injected}); \"quotes\"\nline`, dry_run: true };
      // Replace only the network/package install boundary. The generated shell,
      // Node import, working directory, and environment transfer execute as emitted.
      writeFileSync(join(bin, 'npm'), [
        '#!/usr/bin/env node',
        'const fs = require("node:fs"); const path = require("node:path");',
        'const args = process.argv.slice(2);',
        'if (!args.includes("@hypervibe/hypervibe@0.1.35")) process.exit(2);',
        'const prefix = args[args.indexOf("--prefix") + 1];',
        'const pkg = path.join(prefix, "node_modules", "@hypervibe", "hypervibe");',
        'fs.mkdirSync(pkg, { recursive: true });',
        'fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({type:"module", exports:{"./ci/environment-task":"./task.mjs"}}));',
        'fs.writeFileSync(path.join(pkg, "task.mjs"), ' + JSON.stringify([
          'import {writeFileSync, existsSync} from "node:fs";',
          'export async function runManagedEnvironmentTaskFromProcess() {',
          'if (!existsSync(".hypervibe/spec.json") || !existsSync(".hypervibe/bindings.json")) throw new Error("Wrong checkout");',
          'writeFileSync(process.env.BOUNDARY_MARKER, JSON.stringify({id:process.env.HYPERVIBE_TASK_ID,inputs:JSON.parse(process.env.HYPERVIBE_TASK_INPUTS_JSON),cwd:process.cwd()}));',
          '}',
        ].join('\n')) + ');',
      ].join('\n'), { mode: 0o755 });
      const env = {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory,
        BOUNDARY_MARKER: marker, HYPERVIBE_TASK_ID: 'tester-setup',
        HYPERVIBE_TASK_INPUTS_JSON: JSON.stringify(inputs),
      };
      for (const step of workflow.jobs.task.steps.filter((entry: { run?: string }) => entry.run)) {
        const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
          cwd: checkout, env, encoding: 'utf8', timeout: 10000,
        });
        expect({ name: step.name, status: result.status, stderr: result.stderr })
          .toEqual({ name: step.name, status: 0, stderr: '' });
      }
      expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ id: 'tester-setup', inputs, cwd: realpathSync(checkout) });
      expect(() => readFileSync(injected)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('omits disabled operations from workflow and manifest ownership', () => {
    const desired = spec(false);
    const files = compileManagedGitHubFiles(desired.github!, desired.runtime);
    expect(files.some((entry) => entry.path.endsWith('hypervibe-tester-setup.yml'))).toBe(false);
  });
});

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { parseDocument } from 'yaml';

type WorkflowStep = {
  env?: Record<string, unknown>;
  name?: unknown;
  run?: unknown;
  uses?: unknown;
  with?: Record<string, unknown>;
};

function workflowSteps(workflow: string): WorkflowStep[] {
  const document = parseDocument(workflow, { uniqueKeys: true });
  expect(document.errors, 'generated workflow must be valid YAML with unique keys').toEqual([]);
  const parsed = document.toJS() as {
    jobs?: Record<string, { steps?: unknown[] }>;
  };
  return Object.values(parsed.jobs ?? {})
    .flatMap((job) => Array.isArray(job.steps) ? job.steps : [])
    .filter((step): step is WorkflowStep => Boolean(step) && typeof step === 'object');
}

function exactWorkflowStep(workflow: string, stepName: string): WorkflowStep {
  const matches = workflowSteps(workflow)
    .filter((step) => step.name === stepName);
  expect(matches, `generated workflow must contain exactly one step named ${stepName}`)
    .toHaveLength(1);
  return matches[0]!;
}

export function extractGitHubScript(workflow: string, stepName: string): string {
  const script = exactWorkflowStep(workflow, stepName).with?.script;
  expect(typeof script, `${stepName} must define with.script`).toBe('string');
  return (script as string).trimEnd();
}

export function extractWorkflowShell(workflow: string, stepName: string): string {
  const run = exactWorkflowStep(workflow, stepName).run;
  expect(typeof run, `${stepName} must define run`).toBe('string');
  return (run as string).trimEnd();
}

export function workflowStepIdentifiers(workflow: string): string[] {
  return workflowSteps(workflow).map((step) => {
    if (typeof step.name === 'string') return step.name;
    if (typeof step.uses === 'string') return step.uses;
    return '<unnamed step>';
  });
}

export function installReleaseEvidenceValidator(
  workflow: string,
  directory: string
): { validatorPath: string; validatorSha256: string } {
  const validatorPath = path.join(directory, 'hypervibe-release-evidence.cjs');
  execFileSync('bash', ['-eu', '-c', extractWorkflowShell(workflow, 'Prepare release evidence validator')], {
    env: { ...process.env, HYPERVIBE_RELEASE_VALIDATOR_PATH: validatorPath },
  });
  expect(fs.statSync(validatorPath).mode & 0o777).toBe(0o600);
  const validatorSha256 = createHash('sha256')
    .update(fs.readFileSync(validatorPath))
    .digest('hex');
  const emittedHashes = workflowSteps(workflow)
    .map((step) => step.env?.HYPERVIBE_RELEASE_VALIDATOR_SHA256)
    .filter((value): value is string => typeof value === 'string');
  expect(emittedHashes.length, 'generated evidence consumers must pin the validator digest')
    .toBeGreaterThan(0);
  expect(new Set(emittedHashes), 'every generated evidence consumer must pin the installed validator digest')
    .toEqual(new Set([validatorSha256]));
  return { validatorPath, validatorSha256: emittedHashes[0]! };
}

export function releaseEvidenceValidatorRequire(
  validator: { validatorPath: string },
  fileSystem: {
    readFileSync?: (filename: string, encoding: string) => unknown;
    writeFileSync?: (filename: string, content: string) => unknown;
  } = {}
): (moduleName: string) => unknown {
  return (moduleName: string) => {
    if (moduleName === 'crypto') return { createHash };
    if (moduleName === 'fs') {
      return {
        readFileSync: (filename: string, encoding: BufferEncoding) => (
          filename === validator.validatorPath
            ? fs.readFileSync(filename, encoding)
            : fileSystem.readFileSync?.(filename, encoding) ?? fs.readFileSync(filename, encoding)
        ),
        writeFileSync: fileSystem.writeFileSync ?? fs.writeFileSync,
      };
    }
    throw new Error(`Unexpected module request: ${moduleName}`);
  };
}

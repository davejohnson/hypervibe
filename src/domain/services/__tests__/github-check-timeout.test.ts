import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { compileManagedGitHubFiles } from '../github-infrastructure.service.js';

// GitHub's job-level timeout cancels the entire job; ubuntu-latest jobs have a
// six-hour limit. This is an emitted YAML boundary, not a live Actions test.
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes
// https://docs.github.com/en/actions/reference/limits#actions-limits
const desired = () => ({ version: 1, project: 'check-timeout',
  runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
  github: { actions: {
    acceptance: { kind: 'check', category: 'test', runtime: { kind: 'node' }, commands: ['npm run typecheck', 'npm test'], changeScope: 'all' },
    lint: { kind: 'check', category: 'lint', runtime: { kind: 'node' }, commands: ['npm run lint'] },
    review: { kind: 'pull-request-review' }
  } }, environments: {} });
const compile = (input: unknown) => {
  const spec = projectSpecSchema.parse(input);
  return compileManagedGitHubFiles(spec.github!, spec.runtime);
};

describe('managed check time limits', () => {
  it.each([1, 45, 360])('accepts and renders an explicit %i-minute job limit', timeoutMinutes => {
    const input = desired(); Object.assign(input.github.actions.acceptance, { timeoutMinutes });
    const files = compile(input);
    const workflow = parseYaml(files.find(file => file.path.endsWith('hypervibe-acceptance.yml'))!.content);
    expect(workflow.jobs.check['timeout-minutes']).toBe(timeoutMinutes);
  });

  it.each([0, -1, 1.5, 361, '45', null])('rejects an invalid limit %j', timeoutMinutes => {
    const input = desired(); Object.assign(input.github.actions.acceptance, { timeoutMinutes });
    expect(projectSpecSchema.safeParse(input).success).toBe(false);
  });

  it('renders a changed limit without rewriting another action or check security/commands', () => {
    const spec = projectSpecSchema.parse(desired());
    const before = compileManagedGitHubFiles(spec.github!, spec.runtime);
    Object.assign(spec.github!.actions.acceptance!, { timeoutMinutes: 45 });
    const after = compileManagedGitHubFiles(spec.github!, spec.runtime);
    expect(after.map(file => file.path)).toEqual(before.map(file => file.path));
    for (const original of before) {
      const current = after.find(file => file.path === original.path)!;
      if (original.path.endsWith('hypervibe-acceptance.yml')) {
        expect(parseYaml(original.content).jobs.check['timeout-minutes']).toBe(30);
        expect(current.content).toBe(original.content.replace('    timeout-minutes: 30\n', '    timeout-minutes: 45\n'));
        expect(current.hash).not.toBe(original.hash);
      } else expect(current).toEqual(original);
    }
  });

  it('keeps the option check-only', () => {
    const input = desired(); Object.assign(input.github.actions.review, { timeoutMinutes: 45 });
    expect(projectSpecSchema.safeParse(input).success).toBe(false);
  });

  it('keeps this repository acceptance and every tracked generated file in sync', () => {
    const spec = projectSpecSchema.parse(JSON.parse(fs.readFileSync('.hypervibe/spec.json', 'utf8')));
    expect(spec.github?.actions.acceptance).toMatchObject({ kind: 'check', timeoutMinutes: 45,
      changeScope: 'all', commands: ['npm run typecheck', 'npm test'] });
    expect(spec.github?.collaboration.pullRequests.statusChecks).toContain('Hypervibe / acceptance');
    for (const file of compileManagedGitHubFiles(spec.github!, spec.runtime)) {
      expect(fs.readFileSync(file.path, 'utf8'), file.path).toBe(file.content);
    }
  });
});

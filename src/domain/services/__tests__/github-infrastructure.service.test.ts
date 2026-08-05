import { describe, expect, it, vi } from 'vitest';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import {
  buildGitHubInfrastructurePullRequestBody,
  compileManagedGitHubFiles,
  githubSpecNeedsOpenAI,
} from '../github-infrastructure.service.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

function extractGitHubScript(workflow: string, stepName: string): string {
  const stepStart = workflow.indexOf(`      - name: ${stepName}\n`);
  expect(stepStart).toBeGreaterThan(-1);
  const marker = '          script: |\n';
  const scriptStart = workflow.indexOf(marker, stepStart) + marker.length;
  const nextStep = workflow.indexOf('\n      - ', scriptStart);
  const scriptEnd = nextStep === -1 ? workflow.length : nextStep;
  return workflow
    .slice(scriptStart, scriptEnd)
    .split('\n')
    .map((line) => line.startsWith('            ') ? line.slice(12) : line)
    .join('\n')
    .trimEnd();
}

function githubSpec() {
  return projectSpecSchema.parse({
    version: 1,
    project: 'example',
    github: {
      actions: {
        tests: {
          kind: 'check',
          category: 'test',
          runtime: { kind: 'node' },
          commands: ['npm test'],
          failureArtifacts: ['test-results/**'],
          triggers: { pullRequest: true, schedule: { cron: '15 4 * * *', timezone: 'America/Vancouver' } },
        },
        'fix-tests': { kind: 'autofix', sources: ['tests'] },
        review: { kind: 'pull-request-review' },
        audit: { kind: 'code-audit', schedule: { cron: '0 5 * * 1' } },
      },
      dependencies: { versionUpdates: [{ ecosystem: 'npm', directory: '/', interval: 'weekly' }] },
    },
    environments: { production: { hosting: { provider: 'railway' }, services: { web: {} } } },
  }).github!;
}

describe('GitHub infrastructure compiler', () => {
  it('writes generated pull request copy for non-technical reviewers', () => {
    const body = buildGitHubInfrastructurePullRequestBody([
      {
        operation: 'updated',
        path: '.github/workflows/deploy-railway-staging.yml',
        review: {
          title: 'staging deployment',
          summary: 'Updates the GitHub workflow that deploys the web and cron services to Railway.',
          details: [
            'Requires one exact commit ID.',
            'Retries short-lived Railway errors.',
            'Saves proof of the successful deployment.',
          ],
          mergeEffect: 'Merging this PR may start a staging deployment.',
        },
      },
      {
        operation: 'updated',
        path: '.github/hypervibe/manifest.json',
        review: {
          title: 'Hypervibe tracking file',
          summary: 'Updates Hypervibe’s internal file list.',
        },
      },
    ]);

    expect(body).toContain('## What this PR changes');
    expect(body).toContain('### Updates: staging deployment');
    expect(body).toContain('Retries short-lived Railway errors.');
    expect(body).toContain('## What happens after you merge');
    expect(body).toContain('Merging this PR may start a staging deployment.');
    expect(body).toContain('No passwords, API keys, or other secret values are included');
    expect(body).toContain('<summary>Files changed</summary>');
    expect(body).toContain('`.github/hypervibe/manifest.json`');
    expect(body).not.toContain('repository-file portion');
    expect(body).not.toContain('converge dependent');
  });

  it('compiles stable owned files and a manifest', () => {
    const files = compileManagedGitHubFiles(githubSpec());
    expect(files.map((file) => file.path)).toEqual([
      '.github/dependabot.yml',
      '.github/hypervibe/manifest.json',
      '.github/ISSUE_TEMPLATE/task.yml',
      '.github/pull_request_template.md',
      '.github/workflows/hypervibe-audit.yml',
      '.github/workflows/hypervibe-fix-tests.yml',
      '.github/workflows/hypervibe-review.yml',
      '.github/workflows/hypervibe-tests.yml',
    ]);
    expect(JSON.parse(files.find((file) => file.path.endsWith('manifest.json'))!.content)).toMatchObject({
      version: 1,
      managedBy: 'hypervibe',
    });
    expect(files.every((file) => file.hash.length === 64)).toBe(true);
    expect(files.find((file) => file.path.endsWith('hypervibe-fix-tests.yml'))?.review)
      .toMatchObject({
        title: 'Fix Tests automatic fix',
        summary: expect.stringContaining('Tests'),
      });
  });

  it('uses project runtime as the check default while preserving explicit overrides', () => {
    const spec = projectSpecSchema.parse({
      version: 1,
      project: 'runtime-checks',
      runtime: { kind: 'node', version: '24' },
      github: {
        actions: {
          inherited: {
            kind: 'check', category: 'test', runtime: { kind: 'node' }, commands: ['npm test'],
          },
          overridden: {
            kind: 'check', category: 'test', runtime: { kind: 'node', version: '22' }, commands: ['npm test'],
          },
        },
      },
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
    });
    const files = compileManagedGitHubFiles(spec.github!, spec.runtime);

    expect(files.find((file) => file.path.endsWith('hypervibe-inherited.yml'))?.content)
      .toContain('node-version: "24"');
    expect(files.find((file) => file.path.endsWith('hypervibe-overridden.yml'))?.content)
      .toContain('node-version: "22"');
  });

  it('skips expensive application steps only for narrow Hypervibe-only pull requests', async () => {
    const workflow = compileManagedGitHubFiles(githubSpec())
      .find((file) => file.path.endsWith('hypervibe-tests.yml'))!.content;
    const condition = "github.event_name != 'pull_request' || steps.hypervibe_changes.outputs.run_expensive == 'true'";

    expect(workflow).toContain('Classify pull request changes');
    expect(workflow).toContain('pull-requests: read');
    expect(workflow).toContain(`if: ${condition}`);
    expect(workflow).toContain(`      - name: Install dependencies\n        if: ${condition}`);
    expect(workflow).not.toContain('paths-ignore:');
    expect(workflow).not.toContain('[skip ci]');

    const script = extractGitHubScript(workflow, 'Classify pull request changes');
    const execute = new AsyncFunction('github', 'context', 'core', script);
    const runFor = async (files: Array<{ filename: string; previous_filename?: string }>) => {
      const core = { notice: vi.fn(), setOutput: vi.fn() };
      const listFiles = vi.fn();
      const github = {
        rest: { pulls: { listFiles } },
        paginate: vi.fn(async () => files),
      };
      await execute(github, {
        repo: { owner: 'davejohnson', repo: 'hls-property-care' },
        issue: { number: 72 },
      }, core);
      return { core, github };
    };

    const infrastructure = await runFor([
      { filename: '.hypervibe/spec.json' },
      { filename: '.github/hypervibe/cloudsql-restore-drill.mjs' },
      { filename: '.github/workflows/deploy-railway-staging.yml' },
    ]);
    expect(infrastructure.core.setOutput).toHaveBeenCalledWith('run_expensive', 'false');
    expect(infrastructure.core.notice).toHaveBeenCalledWith(expect.stringContaining('Skipping expensive application steps'));

    const mixed = await runFor([
      { filename: '.hypervibe/spec.json' },
      { filename: 'services/chatService.js' },
    ]);
    expect(mixed.core.setOutput).toHaveBeenCalledWith('run_expensive', 'true');
    expect(mixed.core.notice).not.toHaveBeenCalled();

    const renamedApplicationFile = await runFor([{
      filename: '.github/workflows/hypervibe-tests.yml',
      previous_filename: 'services/chatService.js',
    }]);
    expect(renamedApplicationFile.core.setOutput).toHaveBeenCalledWith('run_expensive', 'true');

    const unknown = await runFor([]);
    expect(unknown.core.setOutput).toHaveBeenCalledWith('run_expensive', 'true');
  });

  it('runs all steps when a check opts into all changes', () => {
    const spec = projectSpecSchema.parse({
      version: 1,
      project: 'infrastructure-validator',
      github: {
        actions: {
          infrastructure: {
            kind: 'check',
            category: 'lint',
            changeScope: 'all',
            runtime: { kind: 'node' },
            commands: ['npm run validate:infrastructure'],
            triggers: { pullRequest: true },
          },
        },
      },
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
    });
    const workflow = compileManagedGitHubFiles(spec.github!, spec.runtime)
      .find((file) => file.path.endsWith('hypervibe-infrastructure.yml'))!.content;

    expect(workflow).not.toContain('Classify pull request changes');
    expect(workflow).not.toContain('hypervibe_changes.outputs.run_expensive');
    expect(workflow).not.toContain('pull-requests: read');
  });

  it('owns a canonical pull-request template whenever pull requests are required', () => {
    const github = projectSpecSchema.parse({
      version: 1,
      project: 'template-owner',
      github: {
        collaboration: {
          issues: {
            enabled: false,
            templates: false,
          },
          pullRequests: {
            requirePr: true,
          },
        },
      },
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
    }).github!;

    const files = compileManagedGitHubFiles(github);
    const template = files.find((file) => file.path === '.github/pull_request_template.md');

    expect(template?.content).toContain('## Related issue');
    expect(template?.content).toContain('## Deployment and infrastructure impact');
    expect(template?.content).toContain('## Existing behavior or tests changed');
    expect(template?.content).toContain('## Risks and follow-up');
    expect(JSON.parse(files.find((file) => file.path === '.github/hypervibe/manifest.json')!.content))
      .toMatchObject({ files: ['.github/pull_request_template.md'] });
  });

  it('does not manage a pull-request template when pull requests are disabled', () => {
    const github = projectSpecSchema.parse({
      version: 1,
      project: 'direct-change-repository',
      github: {
        collaboration: {
          issues: { enabled: false, templates: false },
          pullRequests: { requirePr: false },
        },
      },
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
    }).github!;

    const files = compileManagedGitHubFiles(github);

    expect(files.map((file) => file.path)).not.toContain('.github/pull_request_template.md');
  });

  it('keeps the model key out of the generated patch-running job and separates PR writes', () => {
    const files = compileManagedGitHubFiles(githubSpec());
    const workflow = files.find((file) => file.path.endsWith('hypervibe-fix-tests.yml'))!.content;
    expect(workflow).toContain('uses: openai/codex-action@v1');
    expect(workflow).toContain('model: gpt-5.6-sol');
    expect(workflow).toContain('Ask the configured AI agent for a focused fix');
    expect(workflow).toContain('AGENT_MODEL: "gpt-5.6-sol"');
    expect(workflow).not.toContain('GPT-5.6 Sol');
    expect(workflow).toContain('permission-profile: ":workspace"');
    expect(workflow).toContain('safety-strategy: drop-sudo');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('open_pr:');
    expect(workflow).toContain('validate_fix:');
    expect(workflow).toContain('Validate test 1.1');
    expect(workflow).toContain('Inspect required failure evidence');
    expect(workflow).toContain('hypervibe-failure-evidence/**');
    expect(workflow).toContain('pattern: ${{ needs.check_existing.outputs.evidence_pattern }}');
    expect(workflow).toContain('"artifactPattern":"tests-failure-evidence"');
    expect(workflow).not.toContain('continue-on-error: true');
    expect(workflow).toContain("if: steps.evidence.outputs.actionable == 'true'");
    expect(workflow).toContain('output-file: ${{ runner.temp }}/hypervibe-autofix-summary.md');
    expect(workflow).toContain('AUTOFIX_PATCH_PATH: ${{ runner.temp }}/codex.patch');
    expect(workflow).toContain('git diff --binary --full-index HEAD > "$AUTOFIX_PATCH_PATH"');
    expect(workflow).not.toContain('output-file: hypervibe-autofix-summary.md');
    expect(workflow).toContain('git diff --cached --check');
    expect(workflow).toContain('AUTOFIX_SUMMARY_PATH: hypervibe-autofix-summary.md');
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('Avoid duplicate autofix pull requests');
    expect(workflow).toContain('head_repository?.full_name !== repository');
    expect(workflow).toContain('^\\.github/');
    expect(workflow).toContain('^\\.hypervibe/');
    expect(workflow).toContain('(AGENTS|CLAUDE|CODEX)\\.md$');
    expect(workflow).not.toContain('ANTHROPIC');
  });

  it('runs only with declared external evidence and treats missing evidence as non-actionable', async () => {
    const github = projectSpecSchema.parse({
      version: 1,
      project: 'external-check',
      github: {
        actions: {
          'fix-deploy': { kind: 'autofix', sources: ['staging-deploy'] },
        },
        externalWorkflows: {
          'staging-deploy': {
            workflowName: 'Deploy Railway (staging)',
            failureArtifactPattern: 'deploy-staging-failure-evidence',
            failureArtifacts: ['hypervibe-deploy-failure.log'],
          },
        },
      },
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
    }).github!;

    const workflow = compileManagedGitHubFiles(github)
      .find((file) => file.path.endsWith('hypervibe-fix-deploy.yml'))!.content;

    expect(workflow).toContain('Inspect required failure evidence');
    expect(workflow).toContain('"artifactPattern":"deploy-staging-failure-evidence"');
    expect(workflow).toContain('hypervibe-deploy-failure.log');
    expect(workflow).toContain('Required failure evidence is missing');
    expect(workflow).not.toContain('continue-on-error: true');

    const script = extractGitHubScript(workflow, 'Inspect required failure evidence');
    const execute = new AsyncFunction('require', 'context', 'core', script);
    const context = { payload: { workflow_run: { name: 'Deploy Railway (staging)' } } };
    const fileEntry = {
      name: 'hypervibe-deploy-failure.log',
      isDirectory: () => false,
    };

    const presentCore = { notice: vi.fn(), setOutput: vi.fn() };
    await expect(execute(
      () => ({ existsSync: () => true, readdirSync: () => [fileEntry] }),
      context,
      presentCore
    )).resolves.toBeUndefined();
    expect(presentCore.setOutput).toHaveBeenCalledWith('actionable', 'true');

    const missingCore = { notice: vi.fn(), setOutput: vi.fn() };
    await expect(execute(
      () => ({ existsSync: () => true, readdirSync: () => [] }),
      context,
      missingCore
    )).resolves.toBeUndefined();
    expect(missingCore.notice).toHaveBeenCalledWith(expect.stringContaining('Required failure evidence is missing'));
    expect(missingCore.setOutput).toHaveBeenCalledWith('actionable', 'false');
  });

  it('uses stable code-audit identities without line numbers and closes only after a clean completed job', () => {
    const workflow = compileManagedGitHubFiles(githubSpec())
      .find((file) => file.path.endsWith('hypervibe-audit.yml'))!.content;
    expect(workflow).toContain('normalize(finding.path)');
    expect(workflow).toContain('normalize(finding.symbol)');
    expect(workflow).not.toContain('finding.line');
    expect(workflow).toContain('state: "closed"');
    expect(workflow).toContain('needs: audit');
    expect(workflow).toContain('permission-profile: ":read-only"');
    expect(workflow).toContain('output-file: hypervibe-findings.json');
  });

  it('reports whether any enabled automation needs an OpenAI connection', () => {
    expect(githubSpecNeedsOpenAI(githubSpec())).toBe(true);
    const checksOnly = projectSpecSchema.parse({
      version: 1,
      project: 'checks',
      github: {
        actions: {
          tests: { kind: 'check', category: 'test', runtime: { kind: 'node' }, commands: ['npm test'] },
        },
      },
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
    }).github!;
    expect(githubSpecNeedsOpenAI(checksOnly)).toBe(false);
  });
});

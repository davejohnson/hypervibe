import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import {
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
    expect(workflow).toContain('Verify required failure evidence');
    expect(workflow).toContain('hypervibe-failure-evidence/**');
    expect(workflow).not.toContain('continue-on-error: true');
    expect(workflow).toContain('output-file: hypervibe-autofix-summary.md');
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

  it('fails closed unless an external workflow supplies its declared evidence', async () => {
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
            failureArtifacts: ['hypervibe-deploy-failure.log'],
          },
        },
      },
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
    }).github!;

    const workflow = compileManagedGitHubFiles(github)
      .find((file) => file.path.endsWith('hypervibe-fix-deploy.yml'))!.content;

    expect(workflow).toContain('Verify required failure evidence');
    expect(workflow).toContain('hypervibe-deploy-failure.log');
    expect(workflow).toContain('Required failure evidence is missing');
    expect(workflow).not.toContain('continue-on-error: true');

    const script = extractGitHubScript(workflow, 'Verify required failure evidence');
    const execute = new AsyncFunction('require', 'context', script);
    const context = { payload: { workflow_run: { name: 'Deploy Railway (staging)' } } };
    const fileEntry = {
      name: 'hypervibe-deploy-failure.log',
      isDirectory: () => false,
    };

    await expect(execute(
      () => ({ existsSync: () => true, readdirSync: () => [fileEntry] }),
      context
    )).resolves.toBeUndefined();
    await expect(execute(
      () => ({ existsSync: () => true, readdirSync: () => [] }),
      context
    )).rejects.toThrow('Required failure evidence is missing');
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

import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import {
  compileManagedGitHubFiles,
  githubSpecNeedsOpenAI,
} from '../github-infrastructure.service.js';

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
      '.github/PULL_REQUEST_TEMPLATE.md',
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

  it('leaves a repository-owned pull-request template unmanaged when requested', () => {
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
            manageTemplate: false,
          },
        },
      },
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
    }).github!;

    const files = compileManagedGitHubFiles(github);

    expect(files.map((file) => file.path)).not.toContain('.github/PULL_REQUEST_TEMPLATE.md');
    expect(JSON.parse(files.find((file) => file.path === '.github/hypervibe/manifest.json')!.content))
      .toMatchObject({ files: [] });
  });

  it('keeps the model key out of the generated patch-running job and separates PR writes', () => {
    const files = compileManagedGitHubFiles(githubSpec());
    const workflow = files.find((file) => file.path.endsWith('hypervibe-fix-tests.yml'))!.content;
    expect(workflow).toContain('uses: openai/codex-action@v1');
    expect(workflow).toContain('model: gpt-5.6-sol');
    expect(workflow).toContain('permission-profile: ":workspace"');
    expect(workflow).toContain('safety-strategy: drop-sudo');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('open_pr:');
    expect(workflow).toContain('validate_fix:');
    expect(workflow).toContain('Validate test 1.1');
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('Avoid duplicate autofix pull requests');
    expect(workflow).toContain('head_repository?.full_name !== repository');
    expect(workflow).toContain('^\\.github/');
    expect(workflow).toContain('^\\.hypervibe/');
    expect(workflow).toContain('(AGENTS|CLAUDE|CODEX)\\.md$');
    expect(workflow).not.toContain('ANTHROPIC');
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

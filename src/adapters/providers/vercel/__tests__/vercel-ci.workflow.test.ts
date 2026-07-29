import { describe, expect, it } from 'vitest';
import type { BranchDeployTarget } from '../../../../domain/ports/ci-deploy.port.js';
import { buildBranchDeployWorkflow } from '../../../../domain/services/github-ops.service.js';
import {
  VERCEL_CI_REQUIRED_SECRETS,
  buildVercelGitHubActionsSteps,
} from '../vercel-ci.workflow.js';
import '../vercel.adapter.js';

const TEAM_SCOPE = 'team:team_1234567890';
const WEB_ID = 'prj_1234567890';
const ADMIN_ID = 'prj_abcdefghij';
const WEB_BINDING = `${TEAM_SCOPE}:${WEB_ID}`;
const ADMIN_BINDING = `${TEAM_SCOPE}:${ADMIN_ID}`;

function target(
  overrides: Partial<BranchDeployTarget> = {}
): BranchDeployTarget {
  return {
    environmentName: 'production',
    kind: 'production',
    branch: 'main',
    autoDeployOnPush: false,
    serviceNames: ['web', 'admin'],
    providerProjectId: TEAM_SCOPE,
    providerServiceIds: [WEB_BINDING, ADMIN_BINDING],
    needsServiceNames: true,
    needsJobNames: false,
    ...overrides,
  };
}

describe('Vercel GitHub Actions workflow', () => {
  it('uploads exact tracked files and deploys only durable source-less project bindings', () => {
    const result = buildVercelGitHubActionsSteps(target());

    expect(result.requiredSecrets).toEqual(VERCEL_CI_REQUIRED_SECRETS);
    expect(result.requiredVariables).toEqual([]);
    expect(result.permissions).toContain('contents: read');
    expect(result.steps).toContain(
      `VERCEL_SCOPE_BINDING: '${TEAM_SCOPE}'`
    );
    expect(result.steps).toContain(
      `VERCEL_PROJECT_IDS_JSON: '${JSON.stringify([WEB_ID, ADMIN_ID])}'`
    );
    expect(result.steps).toContain("['ls-files', '-z', '--cached']");
    expect(result.steps).toContain('stat.isSymbolicLink()');
    expect(result.steps).toContain("crypto.createHash('sha1')");
    expect(result.steps).toContain("requestUrl('/v2/files')");
    expect(result.steps).toContain("'/v13/deployments'");
    expect(result.steps).toContain("target: 'production'");
    expect(result.steps).toContain('hypervibeGitSha: deploySha');
    expect(result.steps).toContain('findExactDeployment(projectId)');
    expect(result.steps).toContain('retry: false');
    expect(result.steps).toContain('safeErrorCode(payload)');
    expect(result.steps).toContain('if (project.link)');
    expect(result.steps).toContain("observed.readyState === 'READY'");
    expect(result.steps).toContain(
      'observed.meta?.hypervibeGitSha !== deploySha'
    );
    expect(result.steps).not.toMatch(/\bvercel\s+(?:build|deploy|pull|env)\b/);
    expect(result.steps).not.toContain('/v11/projects');
    expect(result.steps).not.toContain('/env');
  });

  it('falls back to explicit non-secret durable variables before apply has bindings', () => {
    const result = buildVercelGitHubActionsSteps(target({
      providerProjectId: undefined,
      providerServiceIds: [],
    }));

    expect(result.requiredVariables).toEqual([
      'VERCEL_PROJECT_IDS_JSON',
      'VERCEL_SCOPE_BINDING',
    ]);
    expect(result.steps).toContain(
      'VERCEL_PROJECT_IDS_JSON: ${{ vars.VERCEL_PROJECT_IDS_JSON }}'
    );
    expect(result.steps).toContain(
      'VERCEL_SCOPE_BINDING: ${{ vars.VERCEL_SCOPE_BINDING }}'
    );
  });

  it('refuses a service binding from a different account scope', () => {
    expect(() => buildVercelGitHubActionsSteps(target({
      providerServiceIds: [
        `team:team_other:${WEB_ID}`,
      ],
    }))).toThrow(/does not belong to the target account scope/);
  });

  it('emits syntactically valid github-script JavaScript', () => {
    const steps = buildVercelGitHubActionsSteps(target()).steps;
    const marker = '          script: |\n';
    const start = steps.lastIndexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const script = steps
      .slice(start + marker.length)
      .split('\n')
      .map((line) => line.startsWith('            ') ? line.slice(12) : line)
      .join('\n');

    expect(() => new Function(
      'require',
      'exec',
      'fetch',
      'process',
      'URL',
      'setTimeout',
      `return (async () => {\n${script}\n})();`
    )).not.toThrow();
  });

  it('is embedded behind the shared exact-SHA and applied-spec gates', () => {
    const workflow = buildBranchDeployWorkflow(
      'vercel',
      target(),
      { includeStep: false }
    );

    expect(workflow.path).toBe(
      '.github/workflows/deploy-vercel-production.yml'
    );
    expect(workflow.requiredSecrets).toEqual(
      VERCEL_CI_REQUIRED_SECRETS
    );
    expect(workflow.content).toContain(
      'ref: ${{ steps.deploy.outputs.sha }}'
    );
    expect(workflow.content).toContain('HYPERVIBE_APPLIED_SPEC_HASH');
    expect(workflow.content).toContain(
      'Upload and deploy exact-SHA source to existing Vercel Projects'
    );
  });
});

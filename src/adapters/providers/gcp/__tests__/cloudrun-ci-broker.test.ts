import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gcpBrokerTarget } from '../../../../domain/services/__tests__/cloud-deployment-ci.fixture.js';
import { buildCloudRunGitHubActionsSteps } from '../cloudrun-ci.workflow.js';
import { buildCloudRunPortableRecipe } from '../cloudrun-ci.recipe.js';
import '../cloudrun.adapter.js';

describe('Cloud Run reviewed broker CI', () => {
  it.each([false, true])('executes emitted registry authentication and blocks lifetime replacement=%s before Docker', async replaced => {
    const target = gcpBrokerTarget(), result = buildCloudRunGitHubActionsSteps(target), steps = parse('steps:\n' + result.steps).steps;
    const script = steps.find((step: any) => step.name === 'Verify GCP Artifact Registry').with.script;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor, require = createRequire(import.meta.url);
    const docker: any[] = [], outputs: unknown[] = [], requests: any[] = [], runner = mkdtempSync(join(tmpdir(), 'hv-gcp-ci-'));
    const env: Record<string, string> = { RUNNER_TEMP: runner, GCP_PROJECT_ID: 'customer-project', GCP_BOUND_PROJECT_ID: 'customer-project', GCP_REGION: 'us-west2', GCP_ARTIFACT_REPOSITORY: 'hypervibe-production' };
    const dependencies = (name: string) => name === 'node:child_process' ? { execFileSync: (...args: any[]) => docker.push(args) } : require(name);
    const core = { getIDToken: async () => 'synthetic-oidc', setSecret: () => {}, setOutput: (...args: any[]) => outputs.push(args), exportVariable: (key: string, value: string) => { env[key] = value; } };
    const github = { rest: { repos: { getContent: async () => ({ data: { type: 'file', encoding: 'base64', content: 'e30=', size: 2 } }) } } };
    const context = { repo: { owner: 'example', repo: 'app' }, sha: 'c'.repeat(40), ref: 'refs/heads/main' };
    const fetch = async (url: string, options: RequestInit) => { requests.push({ url, options }); return url.startsWith('https://hypervibe.dev/') ? Response.json({
      kind: 'gcp-impersonation', principal: target.deploymentAccess!.connection.principals.release, token: 'synthetic-bearer', expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }) : Response.json({ name: 'projects/customer-project/locations/us-west2/repositories/hypervibe-production', format: 'DOCKER', createTime: replaced ? '2026-10-25T00:00:00Z' : '2026-10-24T00:00:00Z' }); };
    try {
      const operation = new AsyncFunction('require', 'core', 'github', 'context', 'fetch', 'process', script)(dependencies, core, github, context, fetch, { env });
      if (replaced) { await expect(operation).rejects.toThrow('GCP registry access could not be verified.'); expect(docker).toEqual([]); }
      else { await operation; expect(docker[0][2]).toMatchObject({ input: 'synthetic-bearer', stdio: ['pipe', 'ignore', 'ignore'] }); }
      expect(outputs).toEqual([]); expect(requests[1].options).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer synthetic-bearer' } });
      expect(requests.every(item => !item.url.includes('synthetic'))).toBe(true);
    } finally { rmSync(runner, { recursive: true, force: true }); }
  });
  it('uses refreshable release access and ephemeral Docker stdin without JSON keys or token outputs', () => {
    const target = gcpBrokerTarget(), result = buildCloudRunGitHubActionsSteps(target);
    expect(result.requiredSecrets).toEqual([]); expect(result.permissions).toContain('id-token: write');
    expect(result.steps).not.toMatch(/GCP_SERVICE_ACCOUNT_JSON|secrets\.GCP_PROJECT_ID|outputs\.access_token|setOutput\('access_token'/);
    const steps = parse('steps:\n' + result.steps).steps, AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    for (const step of steps) if (step.with?.script) expect(() => new AsyncFunction('require', 'core', 'github', 'context', 'fetch', 'process', step.with.script)).not.toThrow();
    expect(steps.some((step: any) => step.name === 'Remove temporary registry access' && step.if === 'always()')).toBe(true);
    expect(() => buildCloudRunPortableRecipe(target)).toThrow(/GitHub/);
  });
});

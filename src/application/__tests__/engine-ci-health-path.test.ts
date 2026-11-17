import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { serviceSpecSchema } from '../../domain/spec/spec.schema.js';
import { renderReleaseWorkflow, type ReleaseWorkflowInput } from '../infrastructure-engine-ci.js';

const input: ReleaseWorkflowInput = {
  environmentName: 'test', branch: 'main', gcpProjectId: 'demo-project', region: 'us-central1',
  provider: 'projects/123/locations/global/workloadIdentityPools/hypervibe-github/providers/github',
  releaseIdentity: 'hypervibe-release@demo-project.iam.gserviceaccount.com',
  services: [{ name: 'web', resource: 'web-abc', image: 'registry.example/app', startCommand: 'npm start' }],
};
const invalidPaths = ['https://outside.example/health', '//outside.example/health', '/\\outside.example/health', '/health\\check', 'health', '/health#fragment', '/health\ncheck', '/health\rcheck', '/health\tcheck', '/health\u0000check', '/health\u007fcheck', '/health\nprintf "%s" "$GCP_TOKEN" > sentinel\n#'];
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function releaseStep(healthPath: string) {
  const workflow = YAML.parse(renderReleaseWorkflow({ ...input, services: [{ ...input.services[0]!, healthPath }] }));
  return { workflow, step: workflow.jobs.release.steps.find((step: { name?: string }) => step.name === 'Release web') };
}

// Run the actual emitted shell and JavaScript. The preload replaces all fetches
// in the child, so even a wrong URL is captured locally and cannot use a network.
function executeStep(run: string, extraEnv: Record<string, string> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hv-health-path-'));
  directories.push(directory);
  const preload = path.join(directory, 'transport.mjs');
  writeFileSync(preload, `
import { appendFileSync } from 'node:fs';
let image = 'old';
globalThis.fetch = async (target, init = {}) => {
  const url = String(target);
  appendFileSync('calls.jsonl', JSON.stringify({ url, method: init.method ?? 'GET', body: init.body, redirect: init.redirect, argv: process.argv.slice(2) }) + '\\n');
  if (url.startsWith('https://run.googleapis.com/')) {
    if (init.method === 'PATCH') { image = JSON.parse(init.body).template.containers[0].image; return Response.json({ done: true }); }
    return Response.json({ etag: 'etag', uri: 'https://app.example', latestReadyRevision: 'rev', latestCreatedRevision: 'rev', template: { containers: [{ image }] } });
  }
  return new Response('ok');
};
`);
  const child = spawnSync('/bin/bash', ['-e', '-c', run.replace(/\$\{\{ steps\.build_web\.outputs\.digest \}\}/g, 'sha256:abc')], {
    cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, NODE_OPTIONS: `--import=${preload}`,
      GCP_TOKEN: 'synthetic-release-token', GCP_PROJECT: 'demo-project', GCP_REGION: 'us-central1', ...extraEnv },
  });
  const calls = existsSync(path.join(directory, 'calls.jsonl'))
    ? readFileSync(path.join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { child, calls, sentinel: existsSync(path.join(directory, 'sentinel')) };
}

describe('generated CI health paths remain data', () => {
  it.each(['/health?ready=1&mode=full', '/$(printf \'%s\' "$GCP_TOKEN" > sentinel)', '/health?value=`printf sentinel > sentinel`'])('passes the literal path through the emitted shell: %s', (healthPath) => {
    const { step } = releaseStep(healthPath);
    const result = executeStep(step.run);
    expect(result.sentinel).toBe(false);
    expect(result.child.status, result.child.stderr).toBe(0);
    expect(Buffer.from(result.calls[0].argv[2], 'base64').toString('utf8')).toBe(healthPath);
    expect(result.calls.filter((call) => !call.url.startsWith('https://run.googleapis.com/')).map((call) => call.url))
      .toEqual([new URL(healthPath, 'https://app.example').href]);
    expect(result.calls.at(-1).redirect).toBe('manual');
    const patch = result.calls.find((call) => call.method === 'PATCH');
    expect(JSON.parse(patch.body).template.containers[0]).toEqual({ image: 'registry.example/app@sha256:abc', command: ['/bin/sh'], args: ['-lc', 'npm start'] });
  });

  it.each(invalidPaths)('rejects unsafe paths in specs and at rendering: %j', (healthPath) => {
    expect(serviceSpecSchema.safeParse({ healthCheckPath: healthPath }).success).toBe(false);
    expect(() => releaseStep(healthPath)).toThrow(/health.*path/i);
  });

  it('rejects an explicitly empty path while allowing omission', () => {
    expect(serviceSpecSchema.safeParse({ healthCheckPath: '' }).success).toBe(false);
    expect(() => releaseStep('')).toThrow(/health.*path/i);
    expect(() => renderReleaseWorkflow(input)).not.toThrow();
  });

  it.each(invalidPaths)('validates already rendered path data before provider calls: %j', (healthPath) => {
    const { step } = releaseStep('/health');
    const encoded = Buffer.from(healthPath).toString('base64');
    const run = step.run.replace(/\$\{\{ steps\.build_web\.outputs\.digest \}\}/g, 'sha256:abc')
      .replace(/(node release\.mjs \S+ \S+) \S+/, `$1 "${encoded}"`);
    const result = executeStep(run);
    expect(result.child.status).not.toBe(0);
    expect(result.child.stderr).toMatch(/health.*path/i);
    expect(result.calls).toEqual([]);
    expect(result.sentinel).toBe(false);
  });
});

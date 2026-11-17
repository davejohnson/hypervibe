import { describe, expect, it } from 'vitest';
import { ciReleaseCommand } from '../launch.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';

// #546: a generated release workflow must run the configured release command, or not be generated.
const spec = (migrations?: unknown) => projectSpecSchema.parse({ version: 1, project: 'studio', environments: { staging: {
  hosting: { provider: 'cloudrun' }, ...(migrations ? { migrations } : {}), services: { web: {}, worker: { workloadKind: 'worker', startCommand: 'npm run worker' } },
} } }).environments.staging!;
const services = [{ name: 'worker', kind: 'workerPools' as const }, { name: 'web', kind: 'services' as const }];

describe('release command in a generated workflow', () => {
  it('runs on the web service image in the bound job', () => {
    expect(ciReleaseCommand(spec({ mode: 'releaseCommand', command: 'npm run migrate' }), 'release-command-abc', services)).toEqual({ job: 'release-command-abc', service: 'web' });
  });
  it('is absent when the spec declares none', () => {
    expect(ciReleaseCommand(spec(), undefined, services)).toBeUndefined();
  });
  it('refuses to generate a workflow that would skip a declared command', () => {
    expect(ciReleaseCommand(spec({ mode: 'releaseCommand', command: 'npm run migrate' }), undefined, services)).toMatchObject({ blocked: expect.stringMatching(/release-command job does not exist yet/) });
    expect(ciReleaseCommand(spec({ mode: 'releaseCommand', command: 'npm run migrate' }), 'release-command-abc', [])).toMatchObject({ blocked: expect.any(String) });
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GcpBootstrapClient } from '../../src/adapters/providers/gcp/gcp-bootstrap.client.js';

const source = JSON.parse(readFileSync(new URL('./gcp/source.json', import.meta.url), 'utf8'));
const proto = readFileSync(new URL('./gcp/projects.proto', import.meta.url), 'utf8');
const projectType = 'type.googleapis.com/google.cloud.resourcemanager.v3.Project';
const operationName = 'operations/pc.synthetic';
const projectId = 'contract-project';
// Reconstructed serialized response, not a captured cloud resource. The Any
// discriminator comes from the pinned official proto and the separate sanitized
// observation in source.json; synthetic identities are not copied from requests.
const project = { name: 'projects/123456789012', projectId, state: 'ACTIVE',
  createTime: '2026-10-25T12:00:00.123456Z', labels: {} };
function transport(response: unknown) {
  const requests: Array<{ method: string; url: string }> = [];
  const api = new GcpBootstrapClient({ accessToken: 'synthetic-operation-token', maxAttempts: 1, delayMs: 0,
    sleep: async () => {}, fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({ method: request.method, url: request.url });
      expect(request.headers.get('authorization')).toBe('Bearer synthetic-operation-token');
      expect(request.method).toBe('GET');
      expect(await request.text()).toBe('');
      expect(request.url).toBe(`https://cloudresourcemanager.googleapis.com/v3/${operationName}`);
      return new Response(JSON.stringify({ name: operationName, done: true, response }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    } });
  return { api, requests };
}

describe('GCP CreateProject operation ProtoJSON type contract', () => {
  it('pins the official package and declared Project operation response independently of the client', () => {
    expect(createHash('sha256').update(proto).digest('hex')).toBe(source.sha256);
    expect(source.sha256).toBe(source.sourceContentSha256);
    const packageName = proto.match(/^package ([\w.]+);$/m)?.[1];
    expect(proto).toMatch(/message Project \{/);
    expect(proto).toMatch(/rpc CreateProject\(CreateProjectRequest\)[\s\S]*?response_type: "Project"/);
    expect(projectType).toBe(`type.googleapis.com/${packageName}.Project`);
    expect(source.observedOperation.responseType).toBe(projectType);
  });

  it('accepts the independently observed typed Project through one serialized read', async () => {
    const f = transport({ '@type': projectType, ...project });
    await expect(f.api.getProjectCreateOperation(operationName, projectId, { requireProjectType: true }))
      .resolves.toEqual({ state: 'succeeded', name: operationName, project });
    expect(f.requests).toEqual([{ method: 'GET', url: `https://cloudresourcemanager.googleapis.com/v3/${operationName}` }]);
  });

  it.each([
    ['missing', undefined], ['null', null], ['number', 42],
    ['old misspelled package', 'type.googleapis.com/google.cloudresourcemanager.v3.Project'],
    ['different resource', 'type.googleapis.com/google.cloud.resourcemanager.v3.Folder'],
    ['different version', 'type.googleapis.com/google.cloud.resourcemanager.v1.Project'],
    ['different type host', 'other.example/google.cloud.resourcemanager.v3.Project'],
  ])('rejects %s Any type without treating the operation as completed', async (_name, type) => {
    const f = transport({ ...project, ...(type === undefined ? {} : { '@type': type }) });
    await expect(f.api.getProjectCreateOperation(operationName, projectId, { requireProjectType: true }))
      .rejects.toThrow('wrong resource type');
    expect(f.requests).toHaveLength(1);
  });

  it.each([null, [], 'malformed'])('rejects malformed terminal response %j', async response => {
    const f = transport(response);
    await expect(f.api.getProjectCreateOperation(operationName, projectId, { requireProjectType: true })).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  });
});

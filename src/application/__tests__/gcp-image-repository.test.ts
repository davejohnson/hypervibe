import { describe, expect, it } from 'vitest';
import { imageRepositoryConfiguration, imageRepositoryState, observeImageRepository } from '../gcp-image-repository.js';

const name = 'projects/demo-project/locations/us-west1/repositories/hypervibe';
const reply = (status: number, body?: unknown) => (async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('image repository for the environment region', () => {
  it('treats only a confirmed 404 as absent', async () => {
    expect(await observeImageRepository('t', 'demo-project', 'us-west1', reply(404))).toEqual({ state: 'absent' });
    expect((await observeImageRepository('t', 'demo-project', 'us-west1', reply(403))).state).toBe('unknown');
    expect((await observeImageRepository('t', 'demo-project', 'us-west1', reply(500))).state).toBe('unknown');
    const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect((await observeImageRepository('t', 'demo-project', 'us-west1', offline)).state).toBe('unknown');
  });

  it('accepts only the exact Docker repository', async () => {
    expect(await observeImageRepository('t', 'demo-project', 'us-west1', reply(200, { name, format: 'DOCKER' }))).toEqual({ state: 'present' });
    expect((await observeImageRepository('t', 'demo-project', 'us-west1', reply(200, { name, format: 'NPM' }))).state).toBe('unknown');
    expect((await observeImageRepository('t', 'demo-project', 'us-west1', reply(200, { name: 'other', format: 'DOCKER' }))).state).toBe('unknown');
  });

  it('keeps each region in its own project-shared state, never an environment state', () => {
    expect(imageRepositoryState('p1', 'us-west1')).toEqual({ provider: 'gcp', projectId: 'p1', environmentId: 'image-repository-us-west1', partition: 'project-shared' });
    const files = JSON.stringify(imageRepositoryConfiguration('demo-project', 'us-west1').files);
    expect(files).toContain('"location":"us-west1"');
    expect(files).toContain('prevent_destroy');
  });
});

import { describe, expect, it } from 'vitest';
import { presentBuildTokenKey } from '../engine-secrets.js';
import type { ProjectSpec } from '../../domain/spec/spec.schema.js';

const spec = { secrets: {
  NODE_AUTH_TOKEN: { ownership: 'delegated', environments: ['test'], required: false },
  NPM_TOKEN: { ownership: 'delegated', environments: ['test'] },
  API_KEY: { ownership: 'delegated', environments: ['test'] },
} } as unknown as ProjectSpec;
describe('declared package token selection', () => {
  it('uses a populated token after an absent optional alias and never reads values', async () => {
    const reads: string[] = [];
    expect(await presentBuildTokenKey(spec, 'test', async (key) => { reads.push(key); return key === 'NODE_AUTH_TOKEN' ? 'absent' : 'present'; })).toEqual({ key: 'NPM_TOKEN' });
    expect(reads).toEqual(['NODE_AUTH_TOKEN', 'NPM_TOKEN']);
  });
  it('omits undeclared tokens and blocks required absence or unknown observation', async () => {
    expect(await presentBuildTokenKey(spec, 'other', async () => { throw new Error('Do not read another environment'); })).toEqual({});
    expect(await presentBuildTokenKey(spec, 'test', async () => 'absent')).toMatchObject({ error: expect.stringContaining('NPM_TOKEN') });
    expect(await presentBuildTokenKey(spec, 'test', async () => ({ unknown: 'metadata denied' }))).toEqual({ error: 'metadata denied' });
    const optional = { ...spec, secrets: { NODE_AUTH_TOKEN: spec.secrets!.NODE_AUTH_TOKEN! } };
    expect(await presentBuildTokenKey(optional, 'test', async () => 'absent')).toEqual({});
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter } from '../github.adapter.js';

// Reconstructed GitHub transport, not a live recording. The official API
// returns a 302 Location for a ZIP; Actions' uploader uses archiver ZIP/deflate:
// https://docs.github.com/en/rest/actions/artifacts#download-an-artifact
// https://github.com/actions/toolkit/blob/main/packages/artifact/src/internal/upload/zip.ts
// Independent ZIP fixture generated with Python's standard-library zipfile.
const ZIP = 'UEsDBBQAAAAIAACWOl2nCACwHgAAACEAAAAMAAAAcmVsZWFzZS5qc29uq1YqSy0qzszPU7Iy0lFKKs3MSfFMUbKCsHQNlWoBUEsBAhQDFAAAAAgAAJY6XacIALAeAAAAIQAAAAwAAAAAAAAAAAAAAIABAAAAAHJlbGVhc2UuanNvblBLBQYAAAAAAQABADoAAABIAAAAAAA=';
const TRAVERSAL_ZIP = 'UEsDBBQAAAAIAACWOl1Dv6ajBAAAAAIAAAAPAAAALi4vcmVsZWFzZS5qc29uq64FAFBLAQIUAxQAAAAIAACWOl1Dv6ajBAAAAAIAAAAPAAAAAAAAAAAAAACAAQAAAAAuLi9yZWxlYXNlLmpzb25QSwUGAAAAAAEAAQA9AAAAMQAAAAAA';
const SIGNED_URL = 'https://productionresultssa.blob.core.windows.net/artifacts/release.zip?sig=private-download-value';
const API_ZIP = 'UEsDBBQAAAAIADGYOl0fV3aNEAAAAA4AAAAaAAAAaHlwZXJ2aWJlLWFwaS1yZWxlYXNlLmpzb26rVipLLSrOzM9TsjKs5QIAUEsDBBQAAAAIADGYOl1cmUq+FgAAABQAAAARAAAAY29udHJhY3RzL3YxLmpzb26rVsovSM1LLMhUslIy1jPUM1Cq5QIAUEsBAhQDFAAAAAgAMZg6XR9Xdo0QAAAADgAAABoAAAAAAAAAAAAAAIABAAAAAGh5cGVydmliZS1hcGktcmVsZWFzZS5qc29uUEsBAhQDFAAAAAgAMZg6XVyZSr4WAAAAFAAAABEAAAAAAAAAAAAAAIABSAAAAGNvbnRyYWN0cy92MS5qc29uUEsFBgAAAAACAAIAhwAAAI0AAAAAAA==';
function adapter() {
  const value = new GitHubAdapter();
  value.connect({ apiToken: 'private-github-value' });
  return value;
}
function fixture(zip = ZIP) {
  return vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: SIGNED_URL } }))
    .mockResolvedValueOnce(new Response(Buffer.from(zip, 'base64')));
}
afterEach(() => vi.restoreAllMocks());
describe('GitHub release artifact transport', () => {
  it('serializes explicit workflow run pages for complete retry-aware deployment observation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ total_count: 101, workflow_runs: [] }));
    await adapter().listWorkflowRuns('owner', 'repo', 'deploy.yml', { per_page: 100, page: 2 });
    expect(fetch.mock.calls[0][0]).toBe('https://api.github.com/repos/owner/repo/actions/workflows/deploy.yml/runs?per_page=100&page=2');
  });
  it('retains exact UTF-8 bytes of a manifest and its versioned API contract snapshots', async () => {
    fixture(API_ZIP);
    await expect(adapter().readArtifactFiles('owner', 'repo', 12)).resolves.toEqual({
      'hypervibe-api-release.json': '{"version":1}\n', 'contracts/v1.json': '{"openapi":"3.1.0"}\n',
    });
  });
  it('reads exact JSON inside the documented ZIP without forwarding the API token to blob storage', async () => {
    const fetch = fixture();
    await expect(adapter().readJsonArtifact('owner', 'repo', 12, 'release.json')).resolves.toEqual({ version: 2, buildId: 'build-1' });
    expect(fetch.mock.calls[0]).toEqual([
      'https://api.github.com/repos/owner/repo/actions/artifacts/12/zip',
      expect.objectContaining({ redirect: 'manual', headers: expect.objectContaining({ Authorization: 'Bearer private-github-value' }) }),
    ]);
    expect(fetch.mock.calls[1]).toEqual([SIGNED_URL, expect.objectContaining({ redirect: 'error' })]);
    expect(fetch.mock.calls[1][1]?.headers).toBeUndefined();
  });
  it('rejects an expired artifact with no body fetch or provider body echo', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private-github-value', { status: 410 }));
    await expect(adapter().readJsonArtifact('owner', 'repo', 12, 'release.json')).rejects.toThrow('Artifact download unavailable (410)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects ZIP traversal and never extracts to disk', async () => {
    fixture(TRAVERSAL_ZIP);
    await expect(adapter().readJsonArtifact('owner', 'repo', 12, 'release.json')).rejects.toThrow('Invalid release artifact');
  });
  it('rejects a mismatched filename', async () => {
    fixture();
    await expect(adapter().readJsonArtifact('owner', 'repo', 12, 'different.json')).rejects.toThrow('Invalid release artifact');
  });
  it('rejects corrupted compressed contents', async () => {
    const bytes = Buffer.from(ZIP, 'base64');
    bytes[45] ^= 0xff;
    fixture(bytes.toString('base64'));
    await expect(adapter().readJsonArtifact('owner', 'repo', 12, 'release.json')).rejects.toThrow('Invalid release artifact');
  });
  it('bounds streamed archive size even without a content length', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: SIGNED_URL } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(1_114_113)));
    await expect(adapter().readJsonArtifact('owner', 'repo', 12, 'release.json')).rejects.toThrow('Release artifact exceeds');
  });
});

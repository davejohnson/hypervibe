import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter } from '../github.adapter.js';
import { SOURCE_ARCHIVE_LIMIT, sourceArchiveDirectory } from '../github-source.js';

// Reconstructed API/redirect fixtures, not recorded cloud evidence:
// https://docs.github.com/en/rest/commits/commits#get-a-commit
// https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar
// Archive entries use the POSIX ustar format; only transport is replaced.
const token = 'private-source-token-never-forwarded';
const sha = 'a'.repeat(40);
const api = 'https://api.github.com/repos/owner/app';
const location = `https://codeload.github.com/owner/app/legacy.tar.gz/${sha}?token=private-location-token`;
const root = 'owner-app-aaaaaaa';

function tarball(entries: Array<{ name: string; content?: string; type?: string; link?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const archive = tarball([{ name: `${root}/`, type: '5' }, { name: `${root}/package.json`, content: '{"name":"exact-commit"}' }]);
function subject() { const adapter = new GitHubAdapter(); adapter.connect({ apiToken: token }); return adapter; }
function transport(overrides: { commit?: unknown; commitStatus?: number; receiptStatus?: number; location?: string; body?: () => Response } = {}) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.startsWith(`${api}/commits/`)) return Response.json(Object.hasOwn(overrides, 'commit') ? overrides.commit : { sha, url: `${api}/commits/${sha}` }, { status: overrides.commitStatus ?? 200 });
    if (url === `${api}/tarball/${sha}`) return new Response(null, { status: overrides.receiptStatus ?? 302, headers: { location: overrides.location ?? location } });
    return overrides.body?.() ?? new Response(new Uint8Array(archive));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('GitHub authenticated source archive contract', () => {
  it('pins a moving branch once and downloads only that SHA without forwarding API credentials', async () => {
    const fetch = transport();
    expect(await subject().readSourceArchive('owner/app', 'release/next')).toEqual({ archive, commitSha: sha, sourceDirectory: root });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${api}/commits/release%2Fnext`, `${api}/tarball/${sha}`, location]);
    for (const [, init] of fetch.mock.calls.slice(0, 2)) {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      expect(init?.redirect).toBe('manual');
    }
    expect(fetch.mock.calls[2]![1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(new Headers(fetch.mock.calls[2]![1]?.headers).has('authorization')).toBe(false);
  });

  it.each([
    null, {}, { sha: 'not-a-sha', url: `${api}/commits/${sha}` },
    { sha, url: `https://api.github.com/repos/other/app/commits/${sha}` },
    { sha: 'b'.repeat(40), url: `${api}/commits/${'b'.repeat(40)}` },
  ])('rejects incomplete, cross-repository, or contradictory commit evidence', async commit => {
    const fetch = transport({ commit });
    await expect(subject().readSourceArchive('owner/app', sha)).rejects.toThrow(/source commit/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404, 503])('reports HTTP %s without echoing provider content', async commitStatus => {
    const fetch = transport({ commitStatus, commit: { message: `denied ${token} ${location}` } });
    await expect(subject().readSourceArchive('owner/app', 'main')).rejects.toThrow(`HTTP ${commitStatus}`);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    location.replace('https:', 'http:'), location.replace('codeload.github.com', 'attacker.example'),
    location.replace('codeload.github.com', 'user:password@codeload.github.com'),
    location.replace('/owner/app/', '/other/app/'), location.replace(sha, 'b'.repeat(40)), `${location}#fragment`,
  ])('rejects an unverified redirect before any credential-free request', async badLocation => {
    const fetch = transport({ location: badLocation });
    await expect(subject().readSourceArchive('owner/app', sha)).rejects.toThrow('unverified source archive location');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses a second redirect instead of following it', async () => {
    const fetch = transport({ body: () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } }) });
    await expect(subject().readSourceArchive('owner/app', sha)).rejects.toThrow('HTTP 302');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('scrubs transport and streaming failures containing repository credentials or signed URLs', async () => {
    transport({ body: () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(`${token} ${location}`)); } })) });
    let message = '';
    try { await subject().readSourceArchive('owner/app', sha); } catch (error) { message = String(error); }
    expect(message).toContain('could not be read');
    expect(message).not.toContain(token);
    expect(message).not.toContain('private-location-token');
  });

  it('bounds advertised and streamed archive sizes', async () => {
    transport({ body: () => new Response(null, { headers: { 'content-length': String(SOURCE_ARCHIVE_LIMIT + 1) } }) });
    await expect(subject().readSourceArchive('owner/app', sha)).rejects.toThrow('128 MiB');
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    transport({ body: () => new Response(new ReadableStream({ pull(controller) {
      controller.enqueue(chunk); sent += chunk.length;
      if (sent > SOURCE_ARCHIVE_LIMIT) controller.close();
    } })) });
    await expect(subject().readSourceArchive('owner/app', sha)).rejects.toThrow('size and time limits');
  });

  it('keeps the body read within the download deadline', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    transport({ body: () => {
      setTimeout(() => controller.abort(), 0);
      return new Response(new ReadableStream({ start() {} }));
    } });
    await expect(subject().readSourceArchive('owner/app', sha)).rejects.toThrow('size and time limits');
  });

  it.each([
    { entries: [{ name: '../outside', content: 'unsafe' }] },
    { entries: [{ name: `${root}/file`, content: 'one' }, { name: 'other-root/file', content: 'two' }] },
    { entries: [{ name: `${root}/escape`, type: '2', link: '../../outside' }, { name: `${root}/file`, content: 'one' }] },
    { entries: [{ name: `${root}/a/b`, type: '2', link: '../c' },
      { name: `${root}/link`, type: '2', link: 'a/b/../../outside' }, { name: `${root}/c/file`, content: 'one' }] },
  ])('rejects unsafe or inconsistent archive roots without extracting files', ({ entries }) => {
    expect(() => sourceArchiveDirectory(tarball(entries))).toThrow('invalid, unsafe, or oversized');
  });

  it('handles Git-style global PAX metadata, long paths, and internal symlinks', () => {
    const pax = (key: string, value: string) => {
      const field = ` ${key}=${value}\n`;
      let length = Buffer.byteLength(field) + 1;
      while (length !== Buffer.byteLength(field) + String(length).length) length = Buffer.byteLength(field) + String(length).length;
      return `${length}${field}`;
    };
    expect(sourceArchiveDirectory(tarball([
      { name: 'pax_global_header', type: 'g', content: pax('comment', sha) },
      { name: `${root}/`, type: '5' },
      { name: 'pax_long_path', type: 'x', content: pax('path', `${root}/${'nested/'.repeat(20)}app.js`) },
      { name: `${root}/short`, content: 'exact source' },
      { name: `${root}/link`, type: '2', link: 'package.json' },
      { name: `${root}/package.json`, content: '{}' },
    ]))).toBe(root);
  });
});

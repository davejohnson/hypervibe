import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { RepositorySourceError, type RepositorySourceArchive } from '../../../domain/ports/repository-source.port.js';
import { readBoundedArtifactBody } from './github-artifact.js';

export const SOURCE_ARCHIVE_LIMIT = 128 * 1024 * 1024;
const EXPANDED_SOURCE_LIMIT = 512 * 1024 * 1024;
const API = 'https://api.github.com';
const API_VERSION = '2026-03-10';

/** Inspect tar headers without extracting repository-controlled files locally. */
export function sourceArchiveDirectory(archive: Buffer): string {
  try {
    const tar = gunzipSync(archive, { maxOutputLength: EXPANDED_SOURCE_LIMIT });
    let root: string | undefined;
    let nextPath: string | undefined;
    let nextLink: string | undefined;
    let files = 0;
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) {
        if (!tar.subarray(offset).every(byte => byte === 0)) throw new Error();
        break;
      }
      const field = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').split('\0')[0]!;
      const octal = (start: number, length: number) => {
        const value = field(start, length).trim();
        if (!/^[0-7]+$/.test(value)) throw new Error();
        return parseInt(value, 8);
      };
      const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (octal(148, 8) !== checksum) throw new Error();
      const size = octal(124, 12);
      if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length) throw new Error();
      const type = field(156, 1);
      const data = tar.subarray(offset + 512, offset + 512 + size);
      offset += 512 + Math.ceil(size / 512) * 512;
      if (type === 'x' || type === 'g') {
        for (let position = 0; position < data.length;) {
          const space = data.indexOf(32, position);
          const lengthText = data.subarray(position, space).toString();
          if (space < position || !/^[0-9]+$/.test(lengthText)) throw new Error();
          const length = Number(lengthText);
          if (length <= space - position + 1 || position + length > data.length || data[position + length - 1] !== 10) throw new Error();
          const entry = data.subarray(space + 1, position + length - 1).toString('utf8');
          const separator = entry.indexOf('=');
          const key = entry.slice(0, separator);
          const value = entry.slice(separator + 1);
          if (key === 'path' || key === 'linkpath') {
            if (type === 'g') throw new Error();
            if (key === 'path') nextPath = value;
            else nextLink = value;
          }
          position += length;
        }
        continue;
      }
      if (!['', '0', '1', '2', '5'].includes(type)) throw new Error();
      const prefix = field(345, 155);
      const name = (nextPath ?? `${prefix ? `${prefix}/` : ''}${field(0, 100)}`).replace(/\/$/, '');
      nextPath = undefined;
      const parts = name.split('/');
      if (parts.some(part => !part || part === '.' || part === '..') || /[\x00-\x1f\x7f\\]/.test(name)) throw new Error();
      if (!root) root = parts[0];
      if (!root || !/^[A-Za-z0-9_.-]+$/.test(root) || parts[0] !== root || (parts.length === 1 && type !== '5')) throw new Error();
      if (type === '1' || type === '2') {
        const link = nextLink ?? field(157, 100);
        // A chain of symlinks can escape even when each target looks safe after
        // lexical normalization. Reject parent traversal instead of resolving
        // repository-controlled links or extracting the archive on this machine.
        if (link.split('/').includes('..') || /[\x00-\x1f\x7f\\]/.test(link)) throw new Error();
        const resolved = type === '1' ? path.posix.normalize(link) : path.posix.normalize(path.posix.join(path.posix.dirname(name), link));
        if (path.posix.isAbsolute(link) || !resolved.startsWith(`${root}/`)) throw new Error();
      }
      nextLink = undefined;
      if (type === '' || type === '0') files++;
    }
    if (!root || !files || nextPath || nextLink) throw new Error();
    return root;
  } catch { throw new RepositorySourceError('GitHub returned an invalid, unsafe, or oversized source archive.'); }
}

/** GitHub owns ref resolution, authentication, redirects and archive layout. */
export async function readGitHubSourceArchive(token: string, repository: string, revision: string): Promise<RepositorySourceArchive> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')
    || !revision || revision.length > 255 || /[\x00-\x1f\x7f]/.test(revision)) {
    throw new RepositorySourceError('The GitHub repository or source revision is invalid.');
  }
  const signal = AbortSignal.timeout(60_000);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION };
  const get = async (url: string, authenticated: boolean): Promise<Response> => {
    try { return await fetch(url, { method: 'GET', redirect: 'manual', signal, ...(authenticated ? { headers } : {}) }); }
    catch { throw new RepositorySourceError('GitHub source retrieval failed or timed out. Check the repository connection and retry.'); }
  };
  const prefix = `${API}/repos/${repository}`;
  const commitResponse = await get(`${prefix}/commits/${encodeURIComponent(revision)}`, true);
  if (commitResponse.status !== 200) throw new RepositorySourceError(`GitHub could not resolve the requested source commit (HTTP ${commitResponse.status}). Check the branch or tag and repository access.`);
  let commit: { sha?: unknown; url?: unknown };
  try { commit = JSON.parse((await readBoundedArtifactBody(commitResponse, signal, { maxBytes: 1024 * 1024, name: 'GitHub commit response' })).toString('utf8')); }
  catch { throw new RepositorySourceError('GitHub returned an unreadable source commit.'); }
  if (typeof commit?.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(commit.sha)
    || typeof commit.url !== 'string' || commit.url.toLowerCase() !== `${prefix}/commits/${commit.sha}`.toLowerCase()
    || (/^[a-f0-9]{40}$/i.test(revision) && revision.toLowerCase() !== commit.sha.toLowerCase())) {
    throw new RepositorySourceError('GitHub did not verify the exact repository and source commit.');
  }
  const commitSha = commit.sha.toLowerCase();
  const receipt = await get(`${prefix}/tarball/${commitSha}`, true);
  if (receipt.status !== 302) throw new RepositorySourceError(`GitHub could not prepare the source archive (HTTP ${receipt.status}). Check repository contents access.`);
  let location: URL;
  try {
    location = new URL(receipt.headers.get('location') ?? '');
    const expectedPath = `/${repository}/legacy.tar.gz/${commitSha}`;
    if (location.origin !== 'https://codeload.github.com' || location.username || location.password || location.hash
      || location.pathname.toLowerCase() !== expectedPath.toLowerCase()) throw new Error();
  } catch { throw new RepositorySourceError('GitHub returned an unverified source archive location.'); }
  // A short-lived provider URL may carry its own authorization. Never forward
  // the API token, follow another redirect, or include this URL in diagnostics.
  const downloaded = await get(location.toString(), false);
  if (downloaded.status !== 200) throw new RepositorySourceError(`GitHub source archive download failed (HTTP ${downloaded.status}). Retry source retrieval.`);
  if (Number(downloaded.headers.get('content-length')) > SOURCE_ARCHIVE_LIMIT) throw new RepositorySourceError('The repository source archive exceeds the 128 MiB download limit.');
  let archive: Buffer;
  try { archive = await readBoundedArtifactBody(downloaded, signal, { maxBytes: SOURCE_ARCHIVE_LIMIT, name: 'Repository source archive' }); }
  catch { throw new RepositorySourceError('The repository source archive could not be read within the size and time limits.'); }
  return { archive, commitSha, sourceDirectory: sourceArchiveDirectory(archive) };
}

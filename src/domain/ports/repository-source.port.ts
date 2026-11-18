/** Credential-free, immutable source bytes ready for a managed image build. */
export interface RepositorySourceArchive {
  archive: Buffer;
  commitSha: string;
  /** Validated single wrapper directory inside the source archive. */
  sourceDirectory: string;
}

export interface RepositorySourceAdapter {
  readSourceArchive(repository: string, revision: string): Promise<RepositorySourceArchive>;
}

/** Provider-classified, value-free guidance that is safe to show to the caller. */
export class RepositorySourceError extends Error {}

export function isRepositorySourceAdapter(adapter: unknown): adapter is RepositorySourceAdapter {
  return typeof adapter === 'object' && adapter !== null
    && typeof (adapter as RepositorySourceAdapter).readSourceArchive === 'function';
}

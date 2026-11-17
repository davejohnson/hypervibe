/** One immutable source commit, packaged for a cloud's managed build service. */
export interface LocalCommitSource {
  commitSha: string;
  archive: Buffer;
  uncommittedChangesExcluded: boolean;
}

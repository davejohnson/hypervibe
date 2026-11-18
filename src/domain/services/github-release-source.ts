import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const url = new URL('../../../templates/managed-ci/release-source.cjs', import.meta.url);
export const releaseSourceRuntimeBase64 = readFileSync(url).toString('base64');
export const releaseSource = createRequire(import.meta.url)(fileURLToPath(url)) as {
  trustedReleaseHead(ref: unknown, branch: string): string;
  matchesReleaseProducer(run: unknown, artifact: unknown, repository: string, branch: string, workflow: string): boolean;
  isCommitOnReleaseBranch(sha: string, head: string, compare: (base: string, head: string) => Promise<unknown>): Promise<boolean>;
};

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const contractUrl = new URL('../../../templates/ios/release-attempt.cjs', import.meta.url);
const contract = createRequire(import.meta.url)(fileURLToPath(contractUrl)) as {
  normalizeWorkflowPath: (value: unknown, allowedRef: string) => string;
  assertCurrentReleaseAttempt: (run: unknown, artifact: unknown, jobs: unknown, jobName: string) => void;
  assertSkippedIosReleaseAttempt: (run: unknown, jobs: unknown) => void;
  assertSameReleaseAttempt: (previous: unknown, current: unknown, allowedRef?: string) => void;
};
export const { normalizeWorkflowPath, assertCurrentReleaseAttempt, assertSkippedIosReleaseAttempt, assertSameReleaseAttempt } = contract;

export function iosReleaseAttemptRuntimeBase64(): string {
  return Buffer.from(readFileSync(contractUrl, 'utf8')).toString('base64');
}

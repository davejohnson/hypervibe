import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { HvError } from './results.js';

export const sourceBranchSchema = z.string().trim().min(1).max(255).refine(value => (
  !/[\uD800-\uDFFF]/u.test(value) && !['@', 'HEAD'].includes(value)
  && !value.startsWith('refs/') && !value.startsWith('-')
  && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..')
  && !value.includes('@{') && !value.endsWith('.')
  && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'))
), 'Use a plain branch name.');

/** Setup hint only. Detached/unreadable HEAD never implies a default branch. */
export function resolveCloudSourceBranch(directory: string, explicit?: string, pending?: { sourceBranch?: string }): string | undefined {
  if (explicit !== undefined) return sourceBranchSchema.parse(explicit);
  // Retrying an expired code preserves even an intentionally absent hint.
  if (pending) return pending.sourceBranch;
  try {
    const value = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
    const parsed = sourceBranchSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

export function assertPendingSourceBranch(explicit: string | undefined, saved: string | undefined): void {
  if (explicit !== undefined && explicit !== saved) {
    throw new HvError('VALIDATION', 'This browser approval already has a different setup branch. Finish the existing approval or let it expire before choosing another branch.');
  }
}

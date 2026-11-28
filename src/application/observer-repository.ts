import type { EngineCiIntent } from '../domain/spec/engine-ci.js';
import { getGitHubAdapter } from '../domain/services/github-ops.service.js';

/** GitHub schedules run only on the default branch. Bind repository IDs for its immutable OIDC subject. */
export async function observeObserverRepository(intent: EngineCiIntent) {
  const github = getGitHubAdapter(intent.repository);
  if ('error' in github) throw new Error(github.error);
  const [owner, repo] = intent.repository.split('/');
  const actual = await github.adapter.getRepository(owner!, repo!);
  if (actual.full_name !== intent.repository || actual.default_branch !== intent.branch
    || !Number.isSafeInteger(actual.id) || actual.id! <= 0 || !Number.isSafeInteger(actual.owner?.id) || actual.owner!.id! <= 0) {
    throw new Error('Scheduled runtime observation needs the exact GitHub repository and its current default branch.');
  }
  return { repositoryId: String(actual.id), ownerId: String(actual.owner!.id) };
}

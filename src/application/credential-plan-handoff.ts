import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type { CommandContext } from './context.js';
import { HvError } from './results.js';
import { ProjectSpecRepository } from '../adapters/db/repositories/spec.repository.js';
import { planRunDocumentSchema } from '../domain/plan/converge.executor.js';
import type { DelegatedSecretInputRequirement } from '../domain/services/delegated-secret.service.js';
import { projectSpecSchema, type ProjectSpec } from '../domain/spec/spec.schema.js';
import { readRepoSpecFile } from '../domain/spec/repo-spec-file.js';
import { detectGitRemoteUrl, normalizeGitRemoteIdentity, resolveGitHeadCommitSha } from '../lib/git-remote.js';

/** Input-required is an explicit-input policy, not evidence of live absence. */
export function eligibleCredentialRequirements(
  spec: ProjectSpec,
  env: string,
  inputRequired: readonly DelegatedSecretInputRequirement[],
  suppliedKeys: readonly string[] = [],
): DelegatedSecretInputRequirement[] {
  const excluded = new Set(suppliedKeys);
  return inputRequired.filter(requirement => {
    const slot = spec.secrets[requirement.key];
    if (excluded.has(requirement.key) || !slot || slot.ownership !== 'delegated'
      || slot.required === false || !slot.environments.includes(env)
      || slot.principal !== requirement.principal) return false;
    excluded.add(requirement.key);
    return true;
  }).map(({ key, principal, reason }) => ({ key, principal, reason }));
}

/**
 * Read only the persisted plan's value-free input requirements. This does not
 * plan, adopt desired state, inspect dotenv values, decrypt overrides, or grant
 * apply authority. Request confirmation separately pins the current committed
 * source; older manual plans may not have pinned an application commit.
 * Freshness applies to new invitations, not tracking an existing request.
 */
export function resolveCredentialPlanHandoff(context: CommandContext, input: {
  planId: string;
  root: string;
  repository: string;
  env: string;
  spec: ProjectSpec;
}) {
  function invalid(message: string): never {
    throw new HvError('VALIDATION', `${message} Run hv_plan for the intended checkout and environment before preparing a new invitation.`, { next: ['hv_plan'] });
  }
  const run = context.repos.runs.findById(input.planId);
  if (!run || run.type !== 'plan') invalid('Select an existing persisted hv_plan.');
  const parsed = planRunDocumentSchema.safeParse(run.plan);
  if (!parsed.success) invalid('The persisted plan is unreadable.');
  if (run.status !== 'succeeded') invalid('The plan must have completed successfully.');
  const age = Date.now() - run.createdAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) invalid('A fresh plan no older than 24 hours is required.');
  const document = parsed.data;
  const project = context.repos.projects.findById(run.projectId);
  const environment = context.repos.environments.findById(run.environmentId);
  const expectedRemote = `github.com/${input.repository}`;
  if (!project || project.name !== input.spec.project
    || normalizeGitRemoteIdentity(project.gitRemoteUrl ?? undefined) !== expectedRemote
    || normalizeGitRemoteIdentity(detectGitRemoteUrl(input.root) ?? undefined) !== expectedRemote
    || (input.spec.gitRemoteUrl && normalizeGitRemoteIdentity(input.spec.gitRemoteUrl) !== expectedRemote)) {
    invalid('The plan project and current repository do not match.');
  }
  if (!environment || environment.projectId !== run.projectId || environment.name !== input.env
    || document.environmentName !== input.env || !input.spec.environments[input.env]) {
    invalid('The plan belongs to a different environment.');
  }
  const latest = new ProjectSpecRepository().findLatest(run.projectId);
  const recordedSpec = projectSpecSchema.safeParse(latest?.document);
  const checkoutSpec = readRepoSpecFile(input.root);
  if (!latest || latest.revision !== document.specRevision || !recordedSpec.success
    || !isDeepStrictEqual(recordedSpec.data, input.spec)
    || !checkoutSpec || !isDeepStrictEqual(checkoutSpec.spec, input.spec)) {
    invalid('The plan spec is no longer the current reviewed revision.');
  }
  const revision = resolveGitHeadCommitSha(input.root, path.join(input.root, '.hypervibe/spec.json'));
  if (!revision || (document.sourceCommitSha && document.sourceCommitSha !== revision)) {
    invalid('Commit the reviewed spec and keep the plan source checkout unchanged.');
  }
  const requirements = eligibleCredentialRequirements(input.spec, input.env,
    document.inputRequired ?? [], document.overrides?.delegatedSecretKeys);
  return { planId: input.planId, environment: input.env, requirements,
    keys: requirements.map(({ key }) => key), sourceCommitPinned: Boolean(document.sourceCommitSha) };
}

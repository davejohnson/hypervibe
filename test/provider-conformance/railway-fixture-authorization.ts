import type { JsonObject } from './managed-workflow-harness.js';
import { assertFixtureContinuation, type FixturePreview } from './fixture-authorization.js';

export interface RailwayFixtureScope {
  repository: string;
  environment: string;
  service: string;
  storage: string[];
  queues: string[];
}
export type RailwayFixtureStage = 'create' | 'update' | 'absent';

/** Load the originally reviewed record, never manufacture a replacement plan. */
export function loadRailwayFixturePreview(params: {
  preview: FixturePreview;
  target: Pick<FixturePreview, 'profile' | 'project' | 'environment'>;
  approvedPlanId: string | undefined;
  load(planId: string): unknown;
}): JsonObject {
  assertFixtureContinuation(params.preview, params.target, params.approvedPlanId);
  const document = params.load(params.preview.planId) as JsonObject | undefined;
  if (document?.kind !== 'hv_plan' || document.environmentName !== params.target.environment || !Array.isArray(document.actions)) {
    throw new Error('The exact saved Railway preview plan is unavailable.');
  }
  return { data: { ...document, planId: params.preview.planId } };
}

export function assertRailwayFixturePlan(plan: JsonObject, scope: RailwayFixtureScope, stage: RailwayFixtureStage): void {
  const blocked = () => { throw new Error('The plan exceeds the reviewed Railway fixture lifecycle; no apply is authorized.'); };
  if (!Array.isArray(plan.data?.actions) || plan.data.blocked?.length || plan.data.inputRequired?.length) blocked();
  const allowed = new Set([`service:${scope.service}`, 'database:postgres', 'cache:redis',
    ...scope.storage.map(name => `storage:${name}`), ...scope.queues.map(name => `queue:${name}`)]);
  for (const action of plan.data.actions as JsonObject[]) {
    if (action.type === 'noop') continue;
    const resource = action.resource ?? {};
    const metadata = action.metadata ?? {};
    if (resource.provider === 'railway') {
      if (!allowed.has(`${resource.kind}:${resource.name}`)) blocked();
      const types = stage === 'create' ? ['create', 'update'] : stage === 'update' ? ['update'] : ['destroy', 'update'];
      if (!types.includes(action.type)) blocked();
      if (/credential|password|bootstrap|migration|restore|backup|import/i.test(String(metadata.operation ?? ''))) blocked();
    } else if (resource.provider === 'github') {
      if (action.type !== 'update' || metadata.repository !== scope.repository) blocked();
      if (resource.kind === 'repo' && resource.name === scope.repository
        && metadata.operation === 'githubInfrastructurePullRequest') continue;
      if (resource.kind !== 'ci') blocked();
      if (resource.name === `deploy-branch:${scope.environment}` && metadata.operation === 'githubActionsDeployBranch'
        && metadata.workflow?.path === `.github/workflows/deploy-railway-${scope.environment}.yml`
        && metadata.workflow.branch === 'main') continue;
      if (resource.name === `applied-spec-hash:${scope.environment}` && metadata.operation === 'githubActionsAppliedSpecHash'
        && metadata.environmentName === scope.environment) continue;
      blocked();
    } else blocked();
  }
}

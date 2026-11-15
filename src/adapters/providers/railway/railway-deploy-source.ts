export interface RailwayDeploySourceObservation {
  state: 'connected' | 'disconnected' | 'unknown';
  source?: { repo: string; branch?: string };
}

export function normalizeRailwayGitRepo(repo?: string): string | undefined {
  return repo?.trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase() || undefined;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Shared by live observation and import: parent triggers never imply child scope. */
export function railwayDeploySource(params: {
  projectId: string; serviceId: string; environmentId: string;
  triggers: unknown; instanceSourceObserved: boolean; instanceRepo?: unknown;
  cachedSource?: { repo?: string; branch?: string };
}): RailwayDeploySourceObservation {
  const unknown: RailwayDeploySourceObservation = { state: 'unknown' };
  const { triggers, instanceRepo } = params;
  if (!record(triggers) || !Array.isArray(triggers.edges)
    || !record(triggers.pageInfo) || triggers.pageInfo.hasNextPage !== false
    || (instanceRepo != null && !nonempty(instanceRepo))) return unknown;
  const ids = new Set<string>();
  const target: Array<{ repo: string; branch: string }> = [];
  for (const edge of triggers.edges) {
    if (!record(edge) || !record(edge.node)) return unknown;
    const trigger = edge.node;
    if (!nonempty(trigger.id) || ids.has(trigger.id)
      || trigger.projectId !== params.projectId || trigger.serviceId !== params.serviceId
      || !nonempty(trigger.environmentId) || !nonempty(trigger.repository) || !nonempty(trigger.branch)) return unknown;
    ids.add(trigger.id);
    if (trigger.environmentId === params.environmentId) target.push({ repo: trigger.repository, branch: trigger.branch });
  }
  if (target.length > 1) return unknown;
  const trigger = target[0];
  if (typeof instanceRepo === 'string' && trigger
    && normalizeRailwayGitRepo(instanceRepo) !== normalizeRailwayGitRepo(trigger.repo)) return unknown;
  const repo = typeof instanceRepo === 'string' ? instanceRepo : trigger?.repo;
  if (!repo) return { state: params.instanceSourceObserved ? 'disconnected' : 'unknown' };
  const branch = trigger?.branch ?? (
    normalizeRailwayGitRepo(params.cachedSource?.repo) === normalizeRailwayGitRepo(repo)
      ? params.cachedSource?.branch : undefined
  );
  return { state: 'connected', source: { repo, ...(branch ? { branch } : {}) } };
}

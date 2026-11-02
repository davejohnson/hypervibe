/** Native parent fields may be short IDs. They are only meaningful beside a
 * full child resource path in the independently selected project and region.
 * Recorded Execution/Task responses, 2026-11-01; official REST contracts:
 * https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions
 * https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions.tasks
 */
function parentReferenceMatches(value: unknown, parent: string): boolean {
  return value === parent || value === parent.slice(parent.lastIndexOf('/') + 1);
}
function childNameMatches(value: unknown, parent: string, collection: string): boolean {
  const prefix = `${parent}/${collection}/`;
  return typeof value === 'string' && value.startsWith(prefix)
    && /^[a-zA-Z0-9-]+$/.test(value.slice(prefix.length));
}
export function cloudRunExecutionBelongsToJob(execution: { name?: unknown; job?: unknown }, job: string): boolean {
  return /^projects\/[^/]+\/locations\/[^/]+\/jobs\/[a-zA-Z0-9-]+$/.test(job)
    && childNameMatches(execution.name, job, 'executions') && parentReferenceMatches(execution.job, job);
}
export function cloudRunTaskBelongsToExecution(task: { name?: unknown; job?: unknown; execution?: unknown }, execution: string, job: string): boolean {
  return cloudRunExecutionBelongsToJob({ name: execution, job }, job)
    && childNameMatches(task.name, execution, 'tasks')
    && parentReferenceMatches(task.execution, execution) && parentReferenceMatches(task.job, job);
}

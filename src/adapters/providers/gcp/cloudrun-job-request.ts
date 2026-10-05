/**
 * Jobs.patch has no updateMask. Preserve writable configuration without
 * replaying output-only fields or
 * startExecutionToken/runExecutionToken, which can start another execution.
 * https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/patch
 * https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs
 * Self-contained so the same projection runs in both generated CI programs.
 */
export function cloudRunJobUpdateBody(
  currentValue: unknown,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  function record(value: unknown): Record<string, unknown> {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Cloud Run Job update requires observable writable configuration.');
    }
    return value as Record<string, unknown>;
  }
  const current = record(currentValue);
  const result: Record<string, unknown> = {};
  for (const key of ['name', 'labels', 'annotations', 'client', 'clientVersion', 'launchStage', 'binaryAuthorization', 'etag']) {
    if (current[key] !== undefined) result[key] = current[key];
    if (changes[key] !== undefined) result[key] = changes[key];
  }
  for (const key of ['labels', 'annotations']) {
    if (current[key] !== undefined || changes[key] !== undefined) {
      result[key] = { ...record(current[key]), ...record(changes[key]) };
    }
  }
  const previousTemplate = record(current.template);
  const changedTemplate = record(changes.template);
  const template = { ...previousTemplate, ...changedTemplate };
  for (const key of ['labels', 'annotations']) {
    if (previousTemplate[key] !== undefined || changedTemplate[key] !== undefined) {
      template[key] = { ...record(previousTemplate[key]), ...record(changedTemplate[key]) };
    }
  }
  template.template = { ...record(previousTemplate.template), ...record(changedTemplate.template) };
  result.template = template;
  return result;
}

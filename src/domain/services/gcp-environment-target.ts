/** Keep repository-default Google credentials separate from an explicitly selected project. */
export function gcpConnectionScope(repository: string, gcpProjectId?: string): string {
  return gcpProjectId ? `${repository}#gcp:${gcpProjectId}` : repository;
}

export const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Verify both the connection's target and the native identity carried by a service-account key. */
export function gcpCredentialsMatchProject(credentials: Record<string, unknown>, projectId: string): boolean {
  if (credentials?.projectId !== projectId || !GCP_PROJECT_ID_PATTERN.test(projectId)) return false;
  const emailPattern = new RegExp(`^[a-z][a-z0-9-]{4,28}[a-z0-9]@${projectId}\\.iam\\.gserviceaccount\\.com$`);
  if (credentials.project_id !== undefined && credentials.project_id !== projectId) return false;
  if (credentials.client_email !== undefined && (typeof credentials.client_email !== 'string' || !emailPattern.test(credentials.client_email))) return false;
  if (credentials.credentials === undefined) return true;
  if (typeof credentials.credentials !== 'string') return false;
  try {
    const account = JSON.parse(credentials.credentials);
    return account?.type === 'service_account' && account.project_id === projectId
      && typeof account.client_email === 'string' && emailPattern.test(account.client_email);
  } catch {
    return false;
  }
}

/** A recorded provider, project, or region cannot move as part of Google project setup. */
export function gcpEnvironmentBindingConflict(
  bindings: Record<string, unknown> | undefined,
  projectId: string | undefined,
  region: string,
): string | undefined {
  if (!bindings) return undefined;
  if (bindings.provider !== undefined && bindings.provider !== 'cloudrun') {
    return 'This environment is already bound to a different hosting provider.';
  }
  if (projectId !== undefined && bindings.projectId !== undefined && bindings.projectId !== projectId) {
    const boundProject = typeof bindings.projectId === 'string' && GCP_PROJECT_ID_PATTERN.test(bindings.projectId)
      ? `Google Cloud project ${bindings.projectId}` : 'a different Google Cloud project';
    return `This environment is already bound to ${boundProject}. Choose a separate migration target to change projects.`;
  }
  if ([bindings.environmentId, bindings.region].some(value => value !== undefined && value !== region)) {
    return 'This environment is already bound to a different Google Cloud region.';
  }
  return undefined;
}

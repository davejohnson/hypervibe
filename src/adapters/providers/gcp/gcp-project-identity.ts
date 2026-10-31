import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';

/** CRM v3 binds a numeric native parent to the reviewed project ID, not token reach. */
export async function assertGcpProjectIdentity(input: {
  request: typeof fetch; budget: DestinationBudget; token: string;
  projectId: string; projectNumber: string;
}): Promise<void> {
  let project: Record<string, unknown>;
  try {
    project = await destinationJson(input.request, input.budget,
      `https://cloudresourcemanager.googleapis.com/v3/projects/${input.projectNumber}`, input.token, { method: 'GET' });
  } catch (error) {
    // Missing project metadata is not evidence that just a child secret is absent.
    if (error instanceof DestinationBoundaryError && error.status === 404) throw new DestinationBoundaryError('provider_unavailable');
    throw error;
  }
  if (typeof project.name !== 'string' || typeof project.projectId !== 'string') throw new DestinationBoundaryError('invalid_response');
  if (project.name !== `projects/${input.projectNumber}` || project.projectId !== input.projectId)
    throw new DestinationBoundaryError('scope_mismatch');
  if (project.state !== 'ACTIVE') throw new DestinationBoundaryError('invalid_response');
}

import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { gcpRuntimeOwner } from '../cloudrun-runtime-identities.js';

/** Reconstructed IAM evidence for a previously reviewed, independently owned
 * account. This changes only test state and HTTP transport, never adapter methods. */
export function preparedRuntimeFixture(environment: Environment, serviceName: string, transport: {
  getMockImplementation(): ((...args: any[]) => Promise<Response>) | undefined;
  mockImplementation(value: (...args: any[]) => Promise<Response>): unknown;
}): Environment {
  const projectId = String(environment.platformBindings.projectId);
  const email = `runtime@${projectId}.iam.gserviceaccount.com`;
  const uniqueId = '123456789012345678901';
  const result = { ...environment, platformBindings: { ...environment.platformBindings,
    runtimeIdentities: { [serviceName]: { provider: 'cloudrun', evidence: { projectId, region: 'us-central1', accountId: 'runtime',
      email, name: `projects/${projectId}/serviceAccounts/${email}`, uniqueId, attemptId: 'create-1', environmentId: environment.id, serviceName } } },
  } };
  const original = transport.getMockImplementation()!;
  transport.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'iam.googleapis.com') {
      if (url.pathname.endsWith(':getIamPolicy')) return Response.json({ etag: 'sa-etag', bindings: [{
        role: 'roles/iam.serviceAccountUser', members: [`serviceAccount:deploy@${projectId}.iam.gserviceaccount.com`],
      }] });
      return Response.json({ name: `projects/${projectId}/serviceAccounts/${email}`, projectId, email, uniqueId,
        description: gcpRuntimeOwner(projectId, environment, serviceName) + 'create-1' });
    }
    if (url.hostname === 'cloudresourcemanager.googleapis.com' && url.pathname.endsWith(':getIamPolicy')) return Response.json({ etag: 'project-etag', bindings: [] });
    return original(input, init);
  });
  return result;
}

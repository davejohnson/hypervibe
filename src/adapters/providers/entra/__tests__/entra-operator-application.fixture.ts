// Reconstructed Graph v1.0 JSON: official application-post-applications,
// application-list and federatedIdentityCredential-post contracts in source.json.
// Only HTTP transport is replaced; these are not live tenant observations.
// Optional timestamp forms reconstruct the independently recorded native pair.
export function entraNativeFixture(options: { lost?: 'application' | 'federation'; denied?: boolean; deniedWrites?: boolean; origin?: string; subject?: string; createStatus?: number; nextLink?: string;
  applicationCreatedDateTime?: string; applicationReadCreatedDateTime?: string; denyApplicationReadAfterCreate?: boolean; missingApplicationRead?: boolean; observedTenantId?: string } = {}) {
  const tenantId = '11111111-1111-4111-8111-111111111111', applicationId = '22222222-2222-4222-8222-222222222222';
  const appId = '33333333-3333-4333-8333-333333333333', ficId = '44444444-4444-4444-8444-444444444444';
  let application: any, federation: any;
  const observedApplication = () => application && { ...application,
    createdDateTime: options.applicationReadCreatedDateTime ?? application.createdDateTime };
  const writes: Array<{ path: string; body: any }> = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    if (url.origin !== 'https://graph.microsoft.com') throw new Error('Unexpected Graph endpoint');
    if (new Headers(init?.headers).get('authorization') !== 'Bearer synthetic-transient-graph-token') throw new Error('Wrong native token');
    if (options.denied || options.deniedWrites && method === 'POST') return Response.json({ error: { message: 'synthetic-transient-graph-token' } }, { status: 403 });
    if (method === 'GET' && url.pathname === '/v1.0/organization') return Response.json({ value: [{ id: options.observedTenantId ?? tenantId }] });
    if (method === 'GET' && application && options.denyApplicationReadAfterCreate && ['/v1.0/applications', `/v1.0/applications/${applicationId}`].includes(url.pathname)) return Response.json({}, { status: 503 });
    if (method === 'GET' && options.missingApplicationRead && url.pathname === `/v1.0/applications/${applicationId}`) return Response.json({}, { status: 404 });
    if (method === 'GET' && url.pathname === '/v1.0/applications') return Response.json({ value: application ? [observedApplication()] : [], ...(options.nextLink ? { '@odata.nextLink': options.nextLink } : {}) });
    if (method === 'GET' && url.pathname === `/v1.0/applications/${applicationId}`) return application ? Response.json(observedApplication()) : Response.json({}, { status: 404 });
    if (method === 'GET' && url.pathname === `/v1.0/applications/${applicationId}/federatedIdentityCredentials`) return Response.json({ value: federation ? [federation] : [] });
    if (method === 'POST' && url.pathname === '/v1.0/applications') {
      const body = JSON.parse(String(init?.body)); writes.push({ path: url.pathname, body });
      application = { id: applicationId, appId, createdDateTime: options.applicationCreatedDateTime ?? new Date().toISOString(), displayName: body.displayName,
        signInAudience: 'AzureADMultipleOrgs', web: { redirectUris: [`${options.origin ?? 'https://operator.example.test'}/cloud-authorizations/azure`],
          implicitGrantSettings: { enableAccessTokenIssuance: false, enableIdTokenIssuance: false } },
        tags: body.tags, passwordCredentials: [], keyCredentials: [], requiredResourceAccess: [] };
      if (options.lost === 'application') throw new Error('Lost acknowledgment');
      return Response.json(application, { status: options.createStatus ?? 201 });
    }
    if (method === 'POST' && url.pathname === `/v1.0/applications/${applicationId}/federatedIdentityCredentials`) {
      const body = JSON.parse(String(init?.body)); writes.push({ path: url.pathname, body });
      federation = { id: ficId, name: body.name, description: body.description, issuer: 'https://accounts.google.com',
        subject: options.subject ?? '123456789012345678901', audiences: ['api://AzureADTokenExchange'] };
      if (options.lost === 'federation') throw new Error('Lost acknowledgment');
      return Response.json(federation, { status: 201 });
    }
    throw new Error(`Unexpected synthetic endpoint ${method} ${url.pathname}`);
  };
  return { request, writes, tenantId, applicationId, appId, ficId, corrupt: () => { application.web.redirectUris = ['https://unrelated.example.test']; },
    changeApplication: (patch: Record<string, unknown>) => { Object.assign(application, patch); } };
}

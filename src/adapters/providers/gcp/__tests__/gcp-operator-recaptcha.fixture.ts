// Reconstructed REST/proto JSON from Google's Key/CreateKey/Service Usage contracts.
// Static output fields deliberately do not copy the submitted configuration.
// Labels are the documented opaque client metadata; runtime-generated correlation
// values are copied so the actual journal's identity checks can execute.
export function recaptchaNativeFixture(options: { enabled?: boolean; lost?: 'api' | 'key'; denied?: boolean; deniedCreate?: boolean;
  omitDefaults?: boolean; invisible?: boolean; partial?: boolean; wrongProject?: boolean; secretFailure?: boolean; createStatus?: number; wrongKeyConfig?: boolean;
  projectId?: string; hostname?: string; legacySecret?: string } = {}) {
  const projectId = options.projectId ?? 'owned-project', projectNumber = '123456789012', keyName = `projects/${projectNumber}/keys/reconstructed-new-site-key`,
    apiName = `projects/${projectNumber}/services/recaptchaenterprise.googleapis.com`;
  let enabled = options.enabled ?? true, key: any;
  const prior = { name: `projects/${projectNumber}/keys/existing-production-key`, displayName: 'Hypercloud captcha',
    labels: {}, createTime: '2025-01-01T00:00:00Z', webSettings: { integrationType: 'SCORE', allowedDomains: ['production.example.test'] } };
  const writes: Array<{ path: string; body: any }> = [], reads: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const u = new URL(String(input)), method = init?.method ?? 'GET';
    if (new Headers(init?.headers).get('authorization') !== 'Bearer synthetic-transient-google-token') throw new Error('Wrong token');
    if (options.denied) return Response.json({ error: { message: 'synthetic-transient-google-token' } }, { status: 403 });
    if (method === 'GET') reads.push(u.pathname);
    if (u.hostname === 'cloudresourcemanager.googleapis.com' && u.pathname === `/v3/projects/${projectNumber}`)
      return Response.json({ name: `projects/${options.wrongProject ? '999999999999' : projectNumber}`, projectId, state: 'ACTIVE' });
    if (u.hostname === 'cloudresourcemanager.googleapis.com' && u.pathname.endsWith(':testIamPermissions'))
      return Response.json({ permissions: ['serviceusage.services.get', 'serviceusage.services.enable', 'recaptchaenterprise.keys.create',
        'recaptchaenterprise.keys.list', 'recaptchaenterprise.keys.get', 'recaptchaenterprise.keys.retrievelegacysecretkey'] });
    if (u.hostname === 'serviceusage.googleapis.com' && u.pathname === `/v1/${apiName}`) return Response.json({ name: apiName, state: enabled ? 'ENABLED' : 'DISABLED' });
    if (u.hostname === 'serviceusage.googleapis.com' && u.pathname === `/v1/${apiName}:enable` && method === 'POST') {
      writes.push({ path: u.pathname, body: JSON.parse(String(init?.body)) }); enabled = true;
      if (options.lost === 'api') throw new Error('Synthetic lost API acknowledgment');
      return Response.json({ name: 'operations/reconstructed-enable', done: true });
    }
    if (u.hostname !== 'recaptchaenterprise.googleapis.com' || !enabled) throw new Error('Outside reconstructed enabled API');
    if (u.pathname === `/v1/projects/${projectNumber}/keys` && method === 'GET') return Response.json({ keys: [prior, ...(!options.invisible && key ? [key] : [])], ...(options.partial ? { nextPageToken: 'repeated-page' } : {}) });
    if (u.pathname === `/v1/projects/${projectNumber}/keys` && method === 'POST') {
      if (options.deniedCreate) return Response.json({ error: { message: 'synthetic-transient-google-token' } }, { status: 403 });
      const body = JSON.parse(String(init?.body)); writes.push({ path: u.pathname, body });
      key = { name: keyName, displayName: 'Hypercloud captcha', labels: body.labels, createTime: new Date().toISOString(),
        webSettings: { integrationType: 'SCORE', allowedDomains: [options.wrongKeyConfig ? 'unrelated.example.test' : options.hostname ?? 'operator.example.test'],
          ...(!options.omitDefaults ? { allowAllDomains: false, allowAmpTraffic: false, challengeSecurityPreference: 'CHALLENGE_SECURITY_PREFERENCE_UNSPECIFIED' } : {}) } };
      if (options.lost === 'key') throw new Error('Synthetic lost key acknowledgment');
      return Response.json(key, { status: options.createStatus ?? 200 });
    }
    if (u.pathname === `/v1/${keyName}` && method === 'GET') return key && !options.invisible ? Response.json(key) : Response.json({}, { status: 404 });
    if (u.pathname === `/v1/${keyName}:retrieveLegacySecretKey` && method === 'GET') {
      if (options.secretFailure) return Response.json({ legacySecretKey: 'synthetic-private-captcha-secret' }, { status: 503 });
      return Response.json({ legacySecretKey: options.legacySecret ?? 'synthetic-private-captcha-secret' });
    }
    throw new Error(`Unexpected test transport ${method} ${u.pathname}`);
  };
  return { projectId, projectNumber, keyName, request, writes, reads, prior,
    key: () => key, corrupt: (change: (value: any) => void) => change(key) };
}

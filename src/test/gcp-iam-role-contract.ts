/** Reconstructed from IAM v1 projects.roles.get, checked 2026-11-02.
 * https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.roles/get
 * GET accepts an exact role name and empty body. The endpoint has no `view`
 * parameter; that option belongs to projects.roles.list. Rejecting it here
 * prevents pathname-only synthetic transports from hiding malformed requests.
 * The error body below is synthetic, not a captured Google response.
 */
export function gcpRoleGetContractResponse(url: URL, method: string, body?: unknown): Response | undefined {
  if (url.hostname !== 'iam.googleapis.com' || method !== 'GET' || !/^\/v1\/projects\/[^/]+\/roles\/[^/]+$/.test(url.pathname)) return;
  if (url.search || body !== undefined) return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT' } }, { status: 400 });
}

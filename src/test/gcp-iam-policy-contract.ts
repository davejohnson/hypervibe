/** Reconstructed from the serviceAccounts.getIamPolicy REST contract, checked
 * 2026-11-02: POST, options in the query, empty body. CRM projects.getIamPolicy
 * instead takes options in its JSON body. Synthetic errors are not recordings.
 * https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/getIamPolicy
 */
export function gcpAccountPolicyGetContractResponse(url: URL, method: string, body?: unknown): Response | undefined {
  if (url.hostname !== 'iam.googleapis.com' || !/^\/v1\/projects\/[^/]+\/serviceAccounts\/[^/]+:getIamPolicy$/.test(url.pathname)) return;
  if (method !== 'POST' || body !== undefined || url.search !== '?options.requestedPolicyVersion=3') return new Response(null, { status: 400 });
}

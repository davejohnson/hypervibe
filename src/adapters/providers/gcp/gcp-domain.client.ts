import { fetchWithRetry } from '../../../utils/fetch-retry.js';

/**
 * Google calls for custom domains: Site Verification (who owns a domain) and
 * Cloud Run domain mappings. Each request is attempted once with a 15-second
 * limit; parsing, identity checks and DNS planning stay in the application layer.
 */
export function siteVerificationRequest(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(`https://www.googleapis.com/siteVerification/v1/${path}`, {
    ...init, signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }, 1);
}

/** Reads one Cloud Run domain mapping by hostname. */
export function readDomainMapping(token: string, target: { gcpProjectId: string; region: string }, domain: string): Promise<Response> {
  return fetchWithRetry(`https://${target.region}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${encodeURIComponent(target.gcpProjectId)}/domainmappings/${encodeURIComponent(domain)}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }, 1);
}

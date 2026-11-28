import type { GitHubOidcContext } from '../../../domain/ports/engine-ci.port.js';

/** Github's HTTPS endpoint supplies the assertion; the cloud verifies its signature. */
export async function githubOidcToken(context: GitHubOidcContext, audience: string, fetchImpl: typeof fetch = fetch, observation?: { environmentName: string }): Promise<string> {
  let url: URL;
  try { url = new URL(context.requestUrl); } catch { throw new Error('GitHub did not provide a valid OIDC request endpoint.'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.actions.githubusercontent.com') || url.username || url.password || url.port
    || !context.requestToken || !(observation ? ['schedule', 'workflow_dispatch'] : ['push', 'workflow_dispatch']).includes(context.eventName)
    || !/^\d+$/.test(context.runId) || !/^\d+$/.test(context.runAttempt)) throw new Error('The GitHub OIDC execution context is not valid for a branch release.');
  url.searchParams.set('audience', audience);
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${context.requestToken}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('GitHub did not issue an OIDC assertion.');
  const body = await response.json() as { value?: unknown };
  if (typeof body.value !== 'string' || body.value.length > 32_768) throw new Error('GitHub returned an invalid OIDC assertion.');
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(Buffer.from(body.value.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>; } catch { throw new Error('GitHub returned an unreadable OIDC assertion.'); }
  if (claims.iss !== 'https://token.actions.githubusercontent.com' || claims.aud !== audience
    || claims.repository !== context.repository || claims.ref !== context.ref || claims.sha !== context.sha
    || (!observation && claims.sub !== `repo:${context.repository}:ref:${context.ref}`)
    || (observation && (claims.workflow_ref !== `${context.repository}/.github/workflows/hypervibe-observe-${observation.environmentName}.yml@${context.ref}`
      || claims.runner_environment !== 'github-hosted'))
    || claims.event_name !== context.eventName
    || String(claims.run_id) !== context.runId || String(claims.run_attempt) !== context.runAttempt
    || typeof claims.exp !== 'number' || claims.exp <= Date.now() / 1000) throw new Error('The GitHub assertion does not match the admitted repository, branch, commit and run.');
  return body.value;
}

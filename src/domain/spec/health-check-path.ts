/**
 * A health check path is joined to the service's own URL and handed to release
 * tooling, so it must stay on that host ("//host" and "/\\host" resolve elsewhere)
 * and contain nothing a shell, workflow expression or URL parser would reinterpret.
 */
export const HEALTH_CHECK_PATH_PATTERN = /^\/(?!\/)[A-Za-z0-9._~\-/%?=&+:@,]*$/;
export const HEALTH_CHECK_PATH_ERROR = 'Health check path must be a path on the service itself: start with one / and use only letters, digits and . _ ~ - / % ? = & + : @ , (for example /health).';
export function assertHealthCheckPath(path: string): void {
  if (!HEALTH_CHECK_PATH_PATTERN.test(path)) throw new Error(HEALTH_CHECK_PATH_ERROR);
}

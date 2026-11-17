/**
 * When a release counts as unhealthy from its HTTP health check, on every cloud.
 *
 * A path the app declared must answer below 400. Without one the check falls back
 * to "/", which many APIs answer with 404, so only a server error fails. A private
 * service answers 401/403 to an unauthenticated check by design, so it also keeps
 * the lenient rule: its health is not verified beyond "no server error".
 */
export function strictHealthCheck(service: { healthCheckPath?: string; public?: boolean }): boolean {
  return service.healthCheckPath !== undefined && service.public !== false;
}

export function healthCheckFailed(status: number, strict: boolean): boolean {
  return status >= (strict ? 400 : 500);
}

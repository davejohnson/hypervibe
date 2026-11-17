export const HEALTH_CHECK_PATH_PATTERN = /^\/(?!\/)[^\\\u0000-\u001f\u007f#]*$/;
export const HEALTH_CHECK_PATH_ERROR = 'Health check path must start with one / (for example /health) and omit backslashes, control characters and # fragments.';
export function assertHealthCheckPath(path: string): void {
  if (!HEALTH_CHECK_PATH_PATTERN.test(path)) throw new Error(HEALTH_CHECK_PATH_ERROR);
}

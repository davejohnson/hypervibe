import { isIP } from 'node:net';

/** Only a provider-observed public HTTPS origin, never an arbitrary URL/path. */
export function normalizedTrafficOrigin(hostname: string, value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || url.pathname !== '/' || url.search || url.hash
    || host === hostname.toLowerCase().replace(/\.$/, '')
    || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.')
    || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)) {
    throw new Error('Traffic target must be the independently observed public HTTPS origin of a different service.');
  }
  return url.origin;
}

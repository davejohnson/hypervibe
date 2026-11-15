import { isIP } from 'node:net';
import { secretValueLooksPresent } from './committed-spec-inspection.js';

export const MAX_PUBLIC_ENDPOINTS = 100;
export interface HostedPublicEndpointV1 {
  url: string;
  services: string[];
  /** Hosting attachment type; this does not identify the authoritative DNS provider. */
  kind: 'custom' | 'provider';
}

/** Safe public origins only. Reachability and DNS resolution belong to the host's HTTP checker. */
export function publicOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/u.test(value) || secretValueLooksPresent(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') return undefined;
    const host = url.hostname;
    if (host.length > 253 || isIP(host) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host) ||
      /\.(?:localhost|local|internal|test|invalid|example)$/i.test(host)) return undefined;
    return url.toString();
  } catch { return undefined; }
}

export function customDomainOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[/?:#@]/u.test(value)) return undefined;
  return publicOrigin(`https://${value}`);
}

export function endpointProjection<T extends HostedPublicEndpointV1>(keyFor: (endpoint: T) => string = endpoint => endpoint.url) {
  const endpoints = new Map<string, T>();
  let truncated = false;
  return {
    add(endpoint: T) {
      const key = keyFor(endpoint);
      const existing = endpoints.get(key);
      if (existing) {
        existing.services = [...new Set([...existing.services, ...endpoint.services])].sort();
        if (endpoint.kind === 'custom') existing.kind = 'custom';
      } else if (endpoints.size < MAX_PUBLIC_ENDPOINTS) {
        endpoints.set(key, { ...endpoint, services: [...endpoint.services].sort() });
      } else { truncated = true; }
    },
    result: () => ({ publicEndpoints: [...endpoints.values()], ...(truncated ? { publicEndpointsTruncated: true } : {}) }),
  };
}

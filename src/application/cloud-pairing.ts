import { z } from 'zod';
import { HvError } from './results.js';
import { createCloudJsonClient } from './cloud-http.js';

export const DEFAULT_HYPERVIBE_CLOUD_BASE_URL = 'https://hypervibe.dev';
export const HYPERVIBE_CLOUD_CONNECTION_PROVIDER = 'hypervibe-cloud';

const DEFAULT_TIMEOUT_MS = 10_000;

const environmentSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
}).strict();

const pairingStartSchema = z.object({
  deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.string().datetime(),
  intervalSeconds: z.number().int().min(1).max(60),
  repository: z.string().min(3),
  userCode: z.string().regex(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/),
  verificationUrl: z.string().url(),
  purpose: z.literal('provider-connections').optional(),
}).strict();

const pairingPendingSchema = z.object({
  applied: z.literal(0),
  retryAfterSeconds: z.number().int().min(1).max(60),
  skipped: z.number().int().min(0),
  status: z.literal('pending'),
}).strict();

const pairingCompleteSchema = z.object({
  applied: z.number().int().min(0),
  credentials: z.array(z.object({
    environment: environmentSchema,
    token: z.string().regex(/^hvc_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/),
    expiresAt: z.string().datetime().optional(),
  }).strict()),
  project: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
  skipped: z.number().int().min(0),
  status: z.literal('completed'),
  purpose: z.literal('provider-connections').optional(),
}).strict().superRefine((value, context) => {
  if (value.applied !== value.credentials.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'applied must match the credential count',
    });
  }
  const environmentIds = value.credentials.map(({ environment }) => environment.id);
  const environmentKeys = value.credentials.map(({ environment }) => environment.key);
  if (new Set(environmentIds).size !== environmentIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'environment ids must be unique' });
  }
  if (new Set(environmentKeys).size !== environmentKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'environment keys must be unique' });
  }
});

export type HypervibeCloudPairingStart = z.infer<typeof pairingStartSchema>;
export type HypervibeCloudPairingExchange =
  | z.infer<typeof pairingPendingSchema>
  | z.infer<typeof pairingCompleteSchema>;

export interface PendingHypervibeCloudConnection {
  version: 1;
  status: 'pending';
  baseUrl: string;
  repository: string;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
}

export interface VerifiedHypervibeCloudConnection {
  version: 1;
  status: 'verified';
  baseUrl: string;
  repository: string;
  project: { id: string; name: string };
  environments: Array<{
    id: string;
    key: string;
    name: string;
    token: string;
  }>;
  pairedAt: string;
}

export type HypervibeCloudConnection =
  | PendingHypervibeCloudConnection
  | VerifiedHypervibeCloudConnection;

export function normalizeHypervibeCloudBaseUrl(
  value = DEFAULT_HYPERVIBE_CLOUD_BASE_URL
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HvError('VALIDATION', 'Hypervibe cloud URL must be a valid absolute URL.');
  }

  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new HvError(
      'VALIDATION',
      'Hypervibe cloud pairing requires HTTPS, except for a loopback local-development URL.'
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new HvError(
      'VALIDATION',
      'Hypervibe cloud URL cannot contain credentials, query parameters, or a fragment.'
    );
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new HvError('VALIDATION', 'Hypervibe cloud URL must not contain a path.');
  }
  return url.origin;
}

export interface HypervibeCloudPairingClient {
  start(repository: string): Promise<HypervibeCloudPairingStart>;
  exchange(deviceCode: string): Promise<HypervibeCloudPairingExchange>;
}

export function createHypervibeCloudPairingClient(options: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  purpose?: 'provider-connections';
} = {}): HypervibeCloudPairingClient {
  const baseUrl = normalizeHypervibeCloudBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const request = createCloudJsonClient(baseUrl, fetchImpl, timeoutMs);

  return {
    async start(repository) {
      const payload = await request('/api/v1/pairings', { body: {
        repositoryFullName: repository, ...(options.purpose ? { purpose: options.purpose } : {}),
      } });
      const parsed = pairingStartSchema.safeParse(payload);
      if (!parsed.success || parsed.data.repository.toLowerCase() !== repository.toLowerCase() || parsed.data.purpose !== options.purpose) {
        throw new HvError('PROVIDER_ERROR', 'Hypervibe cloud returned an invalid pairing response.');
      }
      const verificationUrl = new URL(parsed.data.verificationUrl);
      if (verificationUrl.origin !== baseUrl || verificationUrl.pathname !== '/pair' || verificationUrl.username || verificationUrl.password || verificationUrl.hash || verificationUrl.searchParams.get('code') !== parsed.data.userCode) {
        throw new HvError('PROVIDER_ERROR', 'Hypervibe cloud returned an unsafe pairing URL.');
      }
      return parsed.data;
    },

    async exchange(deviceCode) {
      const payload = await request('/api/v1/pairing-exchanges', { body: { deviceCode } });
      const pending = pairingPendingSchema.safeParse(payload);
      if (pending.success) return pending.data;
      const completed = pairingCompleteSchema.safeParse(payload);
      if (completed.success && completed.data.purpose === options.purpose
        && (!options.purpose || (completed.data.credentials.length === 1 && completed.data.credentials[0]?.expiresAt))) return completed.data;
      throw new HvError('PROVIDER_ERROR', 'Hypervibe cloud returned an invalid pairing response.');
    },
  };
}

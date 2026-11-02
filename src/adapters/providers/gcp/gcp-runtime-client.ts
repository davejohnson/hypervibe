import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import { redactExactValues } from '../../../utils/redact-exact-values.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';

export class GcpRuntimeError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
export async function getGcpNativeAdminToken(): Promise<string> {
  try {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const response = await client.getAccessToken();
    const token = typeof response === 'string' ? response : response.token;
    if (!token) throw new Error('missing');
    return token;
  } catch {
    throw new GcpRuntimeError('Native Google administrator access is unavailable. Resume the reviewed Google local sign-in and permission preparation through Hypervibe.');
  }
}

/** All diagnostics are local: a provider can echo authorization or request values. */
export function gcpRuntimeError(error: unknown): string {
  return error instanceof GcpRuntimeError ? error.message : 'Google runtime access could not be verified; no additional work was authorized.';
}

export async function gcpRuntimeRequest(url: string, token: string, init: RequestInit = {}, request: typeof fetch = fetch): Promise<unknown | null> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['iam.googleapis.com', 'cloudresourcemanager.googleapis.com', 'run.googleapis.com', 'storage.googleapis.com', 'sqladmin.googleapis.com', 'secretmanager.googleapis.com', 'artifactregistry.googleapis.com', 'compute.googleapis.com', 'pubsub.googleapis.com'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.hash) throw new GcpRuntimeError('Invalid Google runtime API destination.');
  const budget = new DestinationBudget({ signal: init.signal ?? undefined, deadlineMs: 15_000 });
  try {
    const result = await destinationJson(request, budget, url, token, init);
    if (JSON.stringify(redactExactValues(result, [token])) !== JSON.stringify(result)) throw new DestinationBoundaryError('invalid_response');
    return result;
  } catch (error) {
    if (error instanceof DestinationBoundaryError && error.status) {
      if (error.status === 404 && (init.method === undefined || init.method === 'GET' || init.method === 'DELETE')) return null;
      throw new GcpRuntimeError(`Google runtime API returned HTTP ${error.status}; the selected resource remains unverified.`, error.status);
    }
    throw new GcpRuntimeError('Google runtime API request did not return verifiable evidence; reconcile this exact attempt before retrying a write.');
  } finally { budget.close(); }
}

const policySchema = z.object({ etag: z.string().min(1), version: z.number().int().optional(),
  bindings: z.array(z.object({ role: z.string().min(1), members: z.array(z.string().min(1)),
    condition: z.object({ expression: z.string().min(1), title: z.string().optional(), description: z.string().optional() }).passthrough().optional(),
  }).passthrough()).optional(),
}).passthrough();
export type GcpRuntimePolicy = z.infer<typeof policySchema> & { bindings: NonNullable<z.infer<typeof policySchema>['bindings']> };
export function parseGcpRuntimePolicy(value: unknown): GcpRuntimePolicy {
  const result = policySchema.safeParse(value);
  if (!result.success || (result.data.bindings?.some(binding => binding.condition) && result.data.version !== 3)) {
    throw new GcpRuntimeError('Google IAM policy evidence is incomplete or has an unsupported condition version.');
  }
  return { ...result.data, bindings: result.data.bindings ?? [] };
}

export function hasGcpRuntimeRole(policy: GcpRuntimePolicy, role: string, member: string): boolean {
  return policy.bindings.some(binding => binding.role === role && !binding.condition && binding.members.includes(member));
}

export function withGcpRuntimeRole(policy: GcpRuntimePolicy, role: string, member: string, remove = false): GcpRuntimePolicy {
  const bindings = policy.bindings.map(binding => ({ ...binding, members: [...binding.members] }));
  if (remove) return { ...policy, version: 3, bindings: bindings.map(binding => binding.role === role && !binding.condition
    ? { ...binding, members: binding.members.filter(value => value !== member) } : binding).filter(binding => binding.members.length > 0) };
  const existing = bindings.find(binding => binding.role === role && !binding.condition);
  if (existing) existing.members = [...new Set([...existing.members, member])];
  else bindings.push({ role, members: [member] });
  return { ...policy, version: 3, bindings };
}

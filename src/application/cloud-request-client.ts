import { z } from 'zod';
import { HvError } from './results.js';

const uuid = z.string().uuid();
const shortText = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/);
const key = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const fieldSchema = z.object({ key, label: shortText, inputType: z.enum(['password', 'text', 'textarea']) });
const field = fieldSchema;
export const requestSchema = z.object({
  id: uuid, projectId: uuid, environmentId: uuid,
  recipient: z.string().max(320), authentication: z.enum(['email', 'github']),
  title: shortText, fields: z.array(field).min(1).max(16),
  delivery: z.array(z.object({ id: uuid, kind: z.enum(['invitation', 'ready']), status: z.string().max(80), failureCode: z.string().max(120).nullable() })),
  sourceBranch: z.string().max(255).nullable(), sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  environment: z.object({ id: uuid, key: z.string().max(80), name: z.string().max(200) }).nullable(),
  status: z.enum(['pending', 'ready', 'consumed', 'revoked', 'expired']),
  keys: z.array(key).min(1).max(16), suppliedKeys: z.array(key).max(16),
  expiresAt: z.string().datetime(), submittedAt: z.string().datetime().nullable(), consumedAt: z.string().datetime().nullable(),
  verification: z.literal('presence_only'), deployment: z.literal('not_authorized'),
});
const listSchema = z.object({
  requests: z.array(requestSchema).max(20),
  pagination: z.object({ page: z.number().int().min(1), pageSize: z.literal(20), total: z.number().int().nonnegative(), pageCount: z.number().int().nonnegative(), hasNext: z.boolean(), hasPrevious: z.boolean() }),
});
const mutationSchema = z.object({ applied: z.number().int().min(0).max(1), skipped: z.number().int().min(0).max(1), request: requestSchema, delivery: z.literal('queued').optional() });
const discoverySchema = z.object({
  source: z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/), digest: z.string().regex(/^[a-f0-9]{64}$/) }).nullable().optional(),
  // Discovery labels are derived from keys by the server, before the owner
  // chooses the shorter editable label enforced by requestFields.
  availableFields: z.array(field.extend({ label: z.string().min(1).max(128) })),
  sourceError: z.object({ code: z.string().max(80) }).nullable(),
  selectedEnvironmentId: uuid.nullable(), sourceBranch: z.string().max(255),
  environments: z.array(z.object({ id: uuid, name: z.string().max(200), preferred: z.boolean() })).max(100),
});

export type CredentialRequest = z.infer<typeof requestSchema>;
export function createCloudRequestClient(scope: { baseUrl: string; token: string; projectId: string; environmentId: string }) {
  const collection = `/api/v1/projects/${scope.projectId}/credential-requests`;
  async function call<T>(schema: z.ZodType<T>, pathname: string, method = 'GET', body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(pathname, scope.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let status: number | undefined;
    try {
      const response = await fetch(url, {
        method, redirect: 'error', signal: controller.signal,
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${scope.token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      status = response.status;
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 256 * 1024) throw new Error();
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      // Remove exact authentication material even from otherwise-safe strings.
      const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const scrub = (value: unknown): unknown => typeof value === 'string'
        ? value.split(scope.token).join('[redacted]')
        : Array.isArray(value) ? value.map(scrub)
          : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) : value;
      return schema.parse(scrub(raw));
    } catch {
      throw new HvError(status === 401 || status === 403 ? 'MISSING_CONNECTION' : 'PROVIDER_ERROR',
        status === 401 || status === 403 ? 'Browser access expired or was revoked. Approve credential-request access again.'
          : method === 'GET' ? 'Could not verify credential-request state. No empty or ready state has been inferred.'
            : 'The request outcome is unknown or was rejected. Inspect request status before trying again; no automatic retry was made.',
        { details: { httpStatus: status, outcome: status && [400, 401, 403, 404, 409, 422, 429].includes(status) ? 'rejected' : 'unknown' } });
    } finally { clearTimeout(timeout); }
  }
  function check(request: CredentialRequest) {
    if (request.projectId !== scope.projectId || request.environmentId !== scope.environmentId
      || (request.environment && request.environment.id !== scope.environmentId)) throw new HvError('PROVIDER_ERROR', 'The server returned a request outside the approved environment.');
    return request;
  }
  return {
    async fields(branch: string) {
      const result = await call(discoverySchema, `/api/v1/projects/${scope.projectId}/credential-request-fields`, 'GET', undefined, { environmentId: scope.environmentId, sourceBranch: branch });
      if (result.sourceError || result.selectedEnvironmentId !== scope.environmentId || !result.source)
        throw new HvError('PROVIDER_ERROR', 'The hosted service could not verify this source. Check the committed branch and update the server if it does not support reviewed credential requests.');
      return result;
    },
    async list(page = 1, sort = 'newest') {
      const result = await call(listSchema, collection, 'GET', undefined, { page: String(page), sort });
      result.requests.forEach(check);
      if (result.pagination.page !== page) throw new HvError('PROVIDER_ERROR', 'The server returned an unexpected request page.');
      return result;
    },
    async show(id: string) {
      const result = await call(z.object({ request: requestSchema }), `${collection}/${id}`);
      if (check(result.request).id !== id) throw new HvError('PROVIDER_ERROR', 'The server returned a different request.');
      return result.request;
    },
    async create(body: { recipientEmail: string; title: string; fields: z.infer<typeof fieldSchema>[]; sourceBranch: string; expectedSourceRevision: string; expectedSourceDigest: string }) {
      const result = await call(mutationSchema, collection, 'POST', { environmentId: scope.environmentId, ...body });
      const request = check(result.request);
      if (result.applied !== 1 || result.skipped !== 0 || result.delivery !== 'queued'
        || request.authentication !== 'email' || request.recipient !== body.recipientEmail || request.title !== body.title
        || request.sourceRevision !== body.expectedSourceRevision || request.sourceBranch !== body.sourceBranch
        || request.status !== 'pending' || JSON.stringify(request.fields) !== JSON.stringify(body.fields)
        || request.keys.slice().sort().join(',') !== body.fields.map(f => f.key).sort().join(','))
        throw new HvError('PROVIDER_ERROR', 'The invitation receipt did not match the reviewed request. Inspect status before retrying.');
      return result;
    },
    async revoke(id: string) {
      const result = await call(mutationSchema, `${collection}/${id}`, 'DELETE');
      if (check(result.request).id !== id || !['revoked', 'consumed'].includes(result.request.status) || result.applied + result.skipped !== 1)
        throw new HvError('PROVIDER_ERROR', 'The revocation receipt could not be verified. Inspect status before retrying.');
      return result;
    },
  };
}

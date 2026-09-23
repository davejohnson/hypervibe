import { z } from 'zod';
import { repoBindingsFileSchema } from '../../domain/spec/repo-bindings.schema.js';
import {
  readCommittedJsonSourceV1, requireSafeReceiptLabel,
  type CommittedSpecInspectionInputV1,
} from './committed-spec-inspection.js';

export const COMMITTED_BINDINGS_PATH = '.hypervibe/bindings.json' as const;
export type CommittedBindingsInspectionInputV1 = CommittedSpecInspectionInputV1;
export interface HostedEnvironmentBindingsV1 {
  provider?: string;
  projectId?: string;
  environmentId?: string;
  services: Record<string, { serviceId: string }>;
}
export interface CommittedBindingsInspectionReceiptV1 {
  schemaVersion: 1;
  source: {
    provider: string;
    repository: { id: string; path: string };
    revision: string;
    path: typeof COMMITTED_BINDINGS_PATH;
    sha256: string;
    byteLength: number;
  };
  project: string;
  environments: Record<string, HostedEnvironmentBindingsV1>;
}

export class HostedInspectionError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'INVALID_BINDINGS' | 'SOURCE_MISMATCH', message: string) {
    super(message);
    this.name = 'HostedInspectionError';
  }
}

// Provider ids are opaque identities, never URLs, command text or credential material.
const identity = z.string().min(1).max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/);
const projection = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9-]*$/).max(128).optional(),
  projectId: identity.optional(),
  environmentId: identity.optional(),
  services: z.record(z.object({ serviceId: identity.optional() })).optional(),
});

/** No checkout access and no full binding values: only scoped hosting identities. */
export function inspectCommittedBindingsV1(input: CommittedBindingsInspectionInputV1): CommittedBindingsInspectionReceiptV1 {
  const { source, document, actualSha256 } = readCommittedJsonSourceV1(input);
  const parsed = repoBindingsFileSchema.safeParse(document);
  if (!parsed.success) throw new HostedInspectionError('INVALID_BINDINGS', 'Committed bindings have an invalid envelope.');
  const environments: Record<string, HostedEnvironmentBindingsV1> = Object.create(null);
  for (const [name, environment] of Object.entries(parsed.data.environments)) {
    requireSafeReceiptLabel(name, 'environment');
    const projected = projection.safeParse(environment.platformBindings);
    if (!projected.success) throw new HostedInspectionError('INVALID_BINDINGS', 'Committed hosting identities are invalid.');
    const { services: rawServices, ...scope } = projected.data;
    const services: HostedEnvironmentBindingsV1['services'] = Object.create(null);
    for (const [service, binding] of Object.entries(rawServices ?? {})) {
      requireSafeReceiptLabel(service, 'service');
      if (binding.serviceId) services[service] = { serviceId: binding.serviceId };
    }
    environments[name] = { ...scope, services };
  }
  return {
    schemaVersion: 1,
    source: { provider: source.provider, repository: { id: source.repositoryId, path: source.repositoryPath },
      revision: source.revision, path: COMMITTED_BINDINGS_PATH, sha256: actualSha256, byteLength: input.content.byteLength },
    project: requireSafeReceiptLabel(parsed.data.project, 'project'), environments,
  };
}

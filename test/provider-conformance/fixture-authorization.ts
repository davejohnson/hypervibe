import { readFileSync } from 'node:fs';

/** Operator-owned marker for a prepared, dedicated test platform. Never inferred from a project name. */
export interface FixtureTarget {
  profile: string;
  project: string;
  internalProjectId: string;
  nativeProjectId: string;
  repository: string;
  region?: string;
  runtimeServiceAccountEmail?: string;
  nativeEnvironmentId?: string;
}

/** Only an exact, verified saved repository connection may supply GCP fixture access. */
export function verifiedGcpFixtureCredentials(connection: unknown, expected: { repository: string; nativeProjectId: string; runtimeServiceAccountEmail: string }, decrypt: (encrypted: string) => unknown): { projectId: string; credentials: string; runtimeServiceAccountEmail: string } {
  const value = connection as Record<string, unknown> | null;
  if (!value || value.provider !== 'cloudrun' || value.scope !== expected.repository || value.status !== 'verified' || typeof value.credentials_encrypted !== 'string') {
    throw new Error('Prepare a verified repository-scoped Google Cloud connection through Hypervibe before the fixture. Global credentials cannot authorize this target.');
  }
  let decoded: Record<string, unknown>;
  try { decoded = decrypt(value.credentials_encrypted) as Record<string, unknown>; }
  catch { throw new Error('The prepared fixture connection is unreadable; preserve its encrypted state.'); }
  if (!decoded || decoded.projectId !== expected.nativeProjectId || decoded.runtimeServiceAccountEmail !== expected.runtimeServiceAccountEmail
    || typeof decoded.credentials !== 'string' || !decoded.credentials) throw new Error('The saved connection does not match the fixture native project and runtime identity.');
  return { projectId: expected.nativeProjectId, credentials: decoded.credentials, runtimeServiceAccountEmail: expected.runtimeServiceAccountEmail };
}

export function assertFixtureTarget(marker: unknown, expected: FixtureTarget): void {
  const value = marker as Record<string, unknown> | null;
  if (!value || value.version !== 1 || value.purpose !== 'disposable-provider-conformance'
    || Object.entries(expected).some(([key, item]) => !item || value[key] !== item)) {
    throw new Error('The dedicated fixture marker does not match the exact internal project, native scope and repository. No provider mutation is authorized.');
  }
}

export function readFixtureTarget(file: string, expected: FixtureTarget): void {
  assertFixtureTarget(JSON.parse(readFileSync(file, 'utf8')), expected);
}

export interface FixturePreview {
  version: 1;
  profile: string;
  project: string;
  environment: string;
  planId: string;
  actions: Array<{ id: string; type: string; resource: unknown; billable: boolean; dataBearing: boolean; requiresConfirm: boolean }>;
  engineResources?: Array<{ address: string; identity: string }>;
}

export function assertFixtureLifecycleConsent(value: string | undefined): void {
  if (value !== '1') throw new Error('The selected fixture requires explicit approval of its bounded create, release, update and teardown lifecycle (HYPERVIBE_LIVE_AUTHORIZE_LIFECYCLE=1).');
}

/** Persist safe action metadata only; raw plans may contain secrets. */
export function fixturePreview(envelope: Record<string, any>, target: Pick<FixturePreview, 'profile' | 'project' | 'environment'>): FixturePreview {
  if (!envelope.data?.planId || !Array.isArray(envelope.data.actions) || envelope.data.blocked?.length || envelope.data.inputRequired?.length) {
    throw new Error('An incomplete or blocked plan cannot authorize a fixture run.');
  }
  return { version: 1, ...target, planId: envelope.data.planId, actions: envelope.data.actions.map((action: Record<string, any>) => ({
    id: action.id, type: action.type,
    resource: { kind: action.resource?.kind, name: action.resource?.name, provider: action.resource?.provider },
    billable: action.billable === true, dataBearing: action.dataBearing === true, requiresConfirm: action.requiresConfirm === true,
  })) };
}

export function assertFixtureContinuation(preview: FixturePreview, target: Pick<FixturePreview, 'profile' | 'project' | 'environment'>, approvedPlanId: string | undefined): void {
  if (preview.version !== 1 || !approvedPlanId || preview.planId !== approvedPlanId
    || Object.entries(target).some(([key, value]) => preview[key as keyof FixturePreview] !== value)) {
    throw new Error('Live continuation requires approval of this fixture’s exact saved preview plan ID. Preview the fixture first.');
  }
}

export function assertFixtureActionScope(actions: Array<Record<string, any>>, allowedKinds: readonly string[]): void {
  if (actions.some((action) => action.type !== 'noop' && !allowedKinds.includes(action.resource?.kind))) {
    throw new Error('The fixture plan would mutate retained test-platform infrastructure or an undeclared resource. Prepare those dependencies separately through Hypervibe.');
  }
}

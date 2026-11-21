import { createPrivateKey } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { checkProbePermissions, requireProbe } from '../adapters/providers/gcp/gcp-probe-permissions.js';
export { ProbeProblem, requireProbe } from '../adapters/providers/gcp/gcp-probe-permissions.js';
import { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import { enginePluginCacheDir, ensureEngineBinary } from '../adapters/engine/opentofu/install.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { readTransferSlotEvidence } from '../adapters/providers/gcp/gcp-transfer-slot-evidence.js';
import { readTransferIsolationEvidence } from '../adapters/providers/gcp/gcp-transfer-isolation-evidence.js';
import {
  composeGcpProjectConfiguration,
  gcpSetupBackend,
  getGcpProjectSetupContributions,
  getGcpRuntimeIsolation,
} from '../adapters/providers/gcp/tofu/gcp-setup.backend.js';
import {
  assertIsolationReview,
  hasDeposedIsolationGrant,
  isolationGrants,
  matchesIsolationState,
  transferIsolationContribution,
} from '../adapters/providers/gcp/tofu/transfer-isolation.js';
import { transferSlot, type TransferSlotTarget } from '../adapters/providers/gcp/tofu/transfer-slot.js';
import { signedObjectUrl } from '../adapters/providers/gcp/gcp-data.client.js';
import { readDestroyedTransferProbeVersions, probeDigest } from '../adapters/storage/transfer-access-probe.js';
import type { Project } from '../domain/entities/project.entity.js';
import { engineGcpAdapter } from './infrastructure-engine.js';

export interface AccessProbeRequest {
  project: Project;
  target: TransferSlotTarget;
  targetEnvironmentName: string;
  sourceEnvironmentName: string;
  runtimeEmail: string;
  deployEmail: string;
  token: () => Promise<string>;
  fileOnly?: boolean;
  confirm: boolean;
  planId?: string;
}
/** Only these fixed messages may cross the command boundary. Google bodies, signers and URLs stay private. */
export function originalProbeScope(input: AccessProbeRequest) {
  const scope = getGcpRuntimeIsolation(input.project.id, input.target.projectId, input.runtimeEmail);
  requireProbe(
    scope &&
      isDeepStrictEqual(scope.target, input.target) &&
      scope.targetEnvironmentName === input.targetEnvironmentName,
    'Apply the app access restriction for this source and destination before testing it.',
  );
  return scope;
}
export async function inspectProbeReadiness(input: AccessProbeRequest, token: string) {
  const scope = originalProbeScope(input),
    target = scope.target,
    slot = transferSlot(target),
    localId = input.project.id,
    project = target.projectId;
  const destroyed = readDestroyedTransferProbeVersions(localId, project, slot.secretId);
  const slotEvidence = await readTransferSlotEvidence(
    token,
    { projectId: project, accountEmail: slot.accountEmail, secretId: slot.secretId },
    destroyed,
  );
  const evidence = await readTransferIsolationEvidence(token, {
    target,
    targetEnvironmentName: scope.targetEnvironmentName,
    runtimeEmail: scope.runtimeEmail,
    slotEvidence,
  });
  const contributions = getGcpProjectSetupContributions(localId, project);
  assertIsolationReview(contributions, transferIsolationContribution(scope), project, evidence);
  requireProbe(
    isDeepStrictEqual(scope, evidence.scope) &&
      isolationGrants(scope).every((grant) => evidence.grants[grant.role] === 'restricted'),
    'The original app permissions and migration resources must match the applied access plan.',
  );
  const binary = await ensureEngineBinary();
  requireProbe(binary.ok, 'Hypervibe could not open its private infrastructure engine to verify this project.');
  const engine = new OpenTofuEngine({
    binary: binary.binary,
    cipher: getSecretStore(),
    pluginCacheDir: enginePluginCacheDir(),
  });
  const state = await engine.inspectState({
    backend: gcpSetupBackend,
    configuration: composeGcpProjectConfiguration(contributions),
    auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: token, GOOGLE_PROJECT: project }, redact: [token] },
    state: { projectId: localId, environmentId: project, provider: 'gcp', partition: 'project-shared' },
    project: (raw) => !hasDeposedIsolationGrant(raw, scope) && matchesIsolationState(raw, evidence),
  });
  requireProbe(
    state.ok && state.present && state.value,
    'The original transfer resources and narrowed app grants could not be matched to their private infrastructure state.',
  );
  const readiness = {
    scope,
    evidenceDigest: evidence.evidenceDigest,
    inventoryDigest: probeDigest(destroyed),
    softDeleteSeconds: await checkProbePermissions(scope, token, input.fileOnly),
  };
  if (input.fileOnly) return { ...readiness, sign: undefined };
  const adapter = await engineGcpAdapter(input.project, project);
  const connection = adapter?.engineConnection();
  requireProbe(
    connection?.projectId === project && connection.runtimeServiceAccountEmail === scope.runtimeEmail,
    'Restore the verified deployment connection for this exact Google Cloud project.',
  );
  const parsed = z
    .object({
      project_id: z.literal(project),
      client_email: z.literal(input.deployEmail),
      private_key: z.string().min(1),
    })
    .safeParse(JSON.parse(connection.credentials));
  requireProbe(
    parsed.success &&
      input.deployEmail !== scope.runtimeEmail &&
      input.deployEmail !== slot.accountEmail &&
      createPrivateKey(parsed.data.private_key).asymmetricKeyType === 'rsa',
    'The verified deployment identity must be able to sign one download link for the reviewed object.',
  );
  return {
    ...readiness,
    sign: (object: string, generation: string) =>
      signedObjectUrl({
        clientEmail: parsed.data.client_email,
        privateKey: parsed.data.private_key,
        bucket: scope.bucket,
        object,
        generation,
        method: 'GET',
        expiresSeconds: 900,
      }),
  };
}

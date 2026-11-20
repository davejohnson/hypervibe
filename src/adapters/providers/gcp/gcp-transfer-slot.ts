import type { EmptyTransferSlotCapability } from '../../../domain/registry/provider.registry.js';
import { railwayTransferSetupNote } from '../../../domain/plan/gcp-infrastructure-notes.js';
import { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import { readTransferSlotEvidence, TransferEvidenceError } from './gcp-transfer-slot-evidence.js';
import { transferSlot } from './tofu/transfer-slot.js';
import { hasGcpProjectSetup, runGcpProjectSetup } from '../../../domain/services/gcp-project-setup.service.js';

export const gcpEmptyTransferSlot: EmptyTransferSlotCapability = {
  sourceProvider: 'railway',
  prepare: prepareEmptyTransferSlot,
};

async function prepareEmptyTransferSlot(input: Parameters<EmptyTransferSlotCapability['prepare']>[0]) {
  const { project, region, targetProjectId: gcpProjectId } = input;
  const environments = new EnvironmentRepository();
  const source = environments.findByProjectAndName(project.id, input.sourceEnvironment);
  const target = environments.findByProjectAndName(project.id, input.targetEnvironment);
  if (!source || !target) {
    return { success: false, error: 'An existing bound source and target are required to prepare the migration slot.' };
  }
  const railway = source.platformBindings,
    gcp = target.platformBindings;
  if (
    source.projectId !== project.id ||
    target.projectId !== project.id ||
    source.id === target.id ||
    railway.provider !== gcpEmptyTransferSlot.sourceProvider ||
    typeof railway.projectId !== 'string' ||
    !railway.projectId ||
    typeof railway.environmentId !== 'string' ||
    !railway.environmentId ||
    gcp.provider !== 'cloudrun' ||
    gcp.projectId !== gcpProjectId ||
    gcp.environmentId !== region ||
    (gcp.engine as { kind?: string } | undefined)?.kind !== 'opentofu' ||
    !hasGcpProjectSetup(project.id, gcpProjectId)
  ) {
    return {
      success: false,
      error: 'Select the existing bound Railway source and managed Google Cloud target for this project.',
    };
  }
  const scope = {
    projectId: gcpProjectId,
    sourceEnvironmentId: source.id,
    targetEnvironmentId: target.id,
    sourceRailwayProjectId: railway.projectId,
    sourceRailwayEnvironmentId: railway.environmentId,
    targetRegion: region,
  };
  const slot = transferSlot(scope);
  if ([input.runtimeEmail, input.deployEmail].includes(slot.accountEmail))
    return { success: false, error: 'The copy job must use a separate service account.' };
  let token: string;
  try {
    token = await input.token();
  } catch {
    return { success: false, error: 'Google Application Default Credentials are unavailable. Restore your existing Google login and preview the transfer slot again.' };
  }
  try {
    const selected = { projectId: gcpProjectId, accountEmail: slot.accountEmail, secretId: slot.secretId };
    const read = () => readTransferSlotEvidence(token, selected);
    const evidence = await read();
    const matchesOwnership = (observed: typeof evidence) =>
      (!observed.account || observed.account.description === slot.description) &&
      (!observed.secret || Object.entries(slot.labels).every(([key, value]) => observed.secret!.labels[key] === value));
    if (!matchesOwnership(evidence))
      return { success: false, error: 'The existing service account or secret has a different owner.' };
    const result = await runGcpProjectSetup({
      projectId: project.id,
      projectName: project.name,
      gcpProjectId,
      contribution: { id: slot.id, configuration: slot.configuration },
      auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: token, GOOGLE_PROJECT: gcpProjectId }, redact: [token] },
      authenticationScope: 'migration:' + slot.id,
      transferSlotReview: { target: scope, evidence },
      observeTransferAfterApply: read,
      confirm: !!input.planId,
      gcpSetupPlanId: input.planId,
    });
    if (!result.success) return { ...result };
    return {
      ...result,
      source: source.name,
      target: target.name,
      accountEmail: slot.accountEmail,
      secretId: slot.secretId,
      message: railwayTransferSetupNote,
    };
  } catch (error) {
    if (error instanceof TransferEvidenceError) return { success: false, error: error.message };
    return {
      success: false,
      error:
        'Google could not verify the exact empty transfer slot. Check access to the selected project, service account, secret policy and version metadata, then preview again.',
    };
  }
}

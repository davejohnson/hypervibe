import { isDeepStrictEqual } from 'node:util';
import { runGcpTransferAccessProbe } from '../../../application/gcp-transfer-access-probe.js';
import { readDestroyedTransferProbeVersions } from '../../storage/transfer-access-probe.js';
import type { MigrationAccessCapability } from '../../../domain/registry/provider.registry.js';
import { railwayTransferIsolationNote, railwayTransferSetupNote } from '../../../domain/plan/gcp-infrastructure-notes.js';
import { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import { readTransferSlotEvidence, TransferEvidenceError } from './gcp-transfer-slot-evidence.js';
import { readTransferIsolationEvidence } from './gcp-transfer-isolation-evidence.js';
import { transferIsolationContribution } from './tofu/transfer-isolation.js';
import { transferSlot } from './tofu/transfer-slot.js';
import { getGcpProjectSetupContribution, hasGcpProjectSetup, runGcpProjectSetup } from '../../../domain/services/gcp-project-setup.service.js';

export const gcpMigrationAccess: MigrationAccessCapability = {
  sourceProvider: 'railway',
  prepare: prepareMigrationAccess,
};

async function prepareMigrationAccess(input: Parameters<MigrationAccessCapability['prepare']>[0]) {
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
    railway.provider !== gcpMigrationAccess.sourceProvider ||
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
  if (input.mode === 'verify-copy-access') {
    return runGcpTransferAccessProbe({
      project, target: scope, targetEnvironmentName: target.name, sourceEnvironmentName: source.name,
      runtimeEmail: input.runtimeEmail, deployEmail: input.deployEmail, token: input.token,
      confirm: input.planId !== undefined, planId: input.planId,
    });
  }
  const restrictApp = input.mode === 'restrict-app-access';
  if (restrictApp) {
    try {
      const approved = getGcpProjectSetupContribution(project.id, gcpProjectId, slot.id);
      if (!isDeepStrictEqual(approved, slot.configuration)) {
        return { success: false, error: 'App access restrictions require the approved empty transfer slot for this source and target in the original managed project state.' };
      }
    } catch {
      return { success: false, error: 'Restore the private setup record for the approved empty transfer slot before reviewing app access.' };
    }
  }
  let token: string;
  try {
    token = await input.token();
  } catch {
    return { success: false, error: 'Google Application Default Credentials are unavailable. Restore your existing Google login and preview migration access again.' };
  }
  try {
    const selected = { projectId: gcpProjectId, accountEmail: slot.accountEmail, secretId: slot.secretId };
    const read = () => readTransferSlotEvidence(token, selected,
      readDestroyedTransferProbeVersions(project.id, gcpProjectId, slot.secretId));
    const evidence = await read();
    const matchesOwnership = (observed: typeof evidence) =>
      (!observed.account || observed.account.description === slot.description) &&
      (!observed.secret || Object.entries(slot.labels).every(([key, value]) => observed.secret!.labels[key] === value));
    if (!matchesOwnership(evidence))
      return { success: false, error: 'The existing service account or secret has a different owner.' };
    const common = {
      projectId: project.id,
      projectName: project.name,
      gcpProjectId,
      auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: token, GOOGLE_PROJECT: gcpProjectId }, redact: [token] },
      confirm: !!input.planId,
      gcpSetupPlanId: input.planId,
    };
    const readIsolation = (slotEvidence: typeof evidence) => readTransferIsolationEvidence(token, {
      target: scope, targetEnvironmentName: target.name, runtimeEmail: input.runtimeEmail, slotEvidence,
    });
    async function isolationPlan() {
      const isolation = await readIsolation(evidence);
      return runGcpProjectSetup({
        ...common,
        contribution: transferIsolationContribution(isolation.scope),
        authenticationScope: 'migration:restrict-app-access:' + slot.id,
        transferIsolationReview: isolation,
        observeIsolationAfterApply: async () => readIsolation(await read()),
      });
    }
    const result = restrictApp ? await isolationPlan() : await runGcpProjectSetup({
      ...common,
      contribution: { id: slot.id, configuration: slot.configuration },
      authenticationScope: 'migration:' + slot.id,
      transferSlotReview: { target: scope, evidence },
      observeTransferAfterApply: read,
    });
    if (!result.success) return { ...result };
    return {
      ...result,
      source: source.name,
      target: target.name,
      accountEmail: slot.accountEmail,
      secretId: slot.secretId,
      message: restrictApp ? railwayTransferIsolationNote : railwayTransferSetupNote,
    };
  } catch (error) {
    if (error instanceof TransferEvidenceError) return { success: false, error: error.message };
    return {
      success: false,
      error: restrictApp
        ? 'Hypervibe could not verify the approved transfer slot, app identity, dump bucket and project IAM grants. Restore read access to the selected resources and review again.'
        : 'Google could not verify the exact empty transfer slot. Check access to the selected project, service account, secret policy and version metadata, then preview again.',
    };
  }
}

import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { operatorArtifactJournalNames, operatorApplicationJournalNames } from '../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { selectsOperatorImageTarget, verifyOperatorArtifactImages } from './operator-artifact.service.js';
import { assertOperatorApplicationsComplete } from './operator-application.service.js';
import type { PlanAction } from '../plan/plan.types.js';
import { isPreparedHostingAction, preparedHostingActionMetadataSchema } from './hosting-prepared.service.js';
import { preparedHostingMarkerSchema } from '../ports/hosting-prepared.port.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';

const unavailable = () => new Error('The selected existing image update requires immutable verified images, unchanged runtime inputs and complete historical setup effects. Use the full plan to review other changes; no setup or deployment was authorized.');
export async function operatorImageUpdateSelection(project: Project, environment: Environment | null, spec: ProjectSpec,
  options?: { scope?: string; serviceFilter?: string[]; envVarOverrides?: Record<string, string>; envFile?: string; includeEnvFile?: boolean; secretRefs?: Record<string, string> }) {
  const services = options?.serviceFilter;
  if (!environment || !services?.length || options?.scope && options.scope !== 'full') return undefined;
  const desired = spec.environments[environment.name], bindings = environment.platformBindings.services as Record<string, { serviceId?: string }> | undefined;
  // Preserve existing partial-create and branch-build behavior.
  if (!desired || environment.platformBindings.provider !== desired.hosting.provider
    || services.some(name => !desired.services[name] || !bindings?.[name]?.serviceId)) return undefined;
  const scope = { projectId: project.id, environmentId: environment.id, environmentName: environment.name };
  if (!operatorArtifactJournalNames(scope).length && !operatorApplicationJournalNames(scope).length) return undefined;
  const imageKeys = services.map(name => `IMAGE_URI_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`);
  const images = imageKeys.map(key => desired.envVars[key]?.trim() || desired.envVars.IMAGE_URI?.trim());
  if (images.some(image => !image) || !await selectsOperatorImageTarget(project, environment, images as string[])) return undefined;
  if (options?.envFile || options?.envVarOverrides || options?.secretRefs
    || options?.includeEnvFile !== false && desired.envFile?.mode !== 'off' && process.env.HYPERVIBE_DISABLE_IMPLICIT_DEPLOY_ENV_FILE !== '1') throw unavailable();
  const selectors = new Set(['IMAGE_URI', ...imageKeys]);
  if (services.some(name => Object.keys(desired.services[name].databaseEnvAliases ?? {}).some(key => selectors.has(key)))
    || Object.keys(spec.secrets).some(key => selectors.has(key))
    || Object.keys(desired.secretDestinations ?? {}).some(key => selectors.has(key))) throw unavailable();
  if (images.some(image => !image || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image))) throw unavailable();
  return { services, images: images as string[] };
}
export async function verifyOperatorImageUpdate(project: Project, environment: Environment, spec: ProjectSpec, images: string[]) {
  await assertOperatorApplicationsComplete(project, environment, spec);
  await verifyOperatorArtifactImages({ ...project, gitRemoteUrl: spec.gitRemoteUrl ?? project.gitRemoteUrl }, environment, images);
}

/** The caller must first validate the immutable operator image selection.
 * An acknowledged existing rollout can leave only its local image binding stale.
 * Permit that exact metadata frontier without reopening unrelated setup, while
 * preserving the general prohibition on filtered prepared-resource adoption. */
export function isOperatorImageBindingRefresh(environment: Environment, action: PlanAction,
  selection: NonNullable<Awaited<ReturnType<typeof operatorImageUpdateSelection>>>): boolean {
  try {
    if (!isPreparedHostingAction(action) || action.resource.name !== environment.name
      || preparedHostingMarkerSchema.parse(environment.platformBindings.preparedHosting).pendingFirstRelease.length) return false;
    const meta = preparedHostingActionMetadataSchema.parse(action.metadata);
    const expected = structuredClone(environment.platformBindings);
    const services = expected.services as Record<string, Record<string, unknown>>;
    let changed = false;
    for (const [index, name] of selection.services.entries()) {
      const before = services[name], observed = meta.proof.bindings.services[name];
      if (!before || !observed || typeof before.imageUri !== 'string' || !before.resourceUid
        || before.serviceId !== observed.serviceId || before.resourceUid !== observed.resourceUid) return false;
      if (before.imageUri === observed.imageUri) continue;
      if (observed.imageUri !== selection.images[index]) return false;
      before.imageUri = observed.imageUri;
      changed = true;
    }
    return changed && meta.beforeBindingsFingerprint === canonicalJsonSha256(environment.platformBindings)
      && meta.afterBindingsFingerprint === canonicalJsonSha256(expected);
  } catch { return false; }
}

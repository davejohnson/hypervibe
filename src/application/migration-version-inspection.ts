import { isDeepStrictEqual } from 'node:util';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import { ConvergeExecutor, type ActionResult, type PlanRunDocument } from '../domain/plan/converge.executor.js';
import { migrationVersionActionId, migrationVersionActionSchema, migrationVersionReceiptSchema, migrationSourceInventorySchema,
  type MigrationVersionMetadata } from '../domain/plan/migration-version.contract.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { CommandContext } from './context.js';
import type { MigrateResult } from './migrate.js';
import { migrationDatabaseBindingConflict } from './migration-database-binding.js';

type Selection = { project: Project; source: Environment; targetName: string; spec: ProjectSpec };
class MissingTrustedAccess extends Error {}
async function current(ctx: CommandContext, selection: Selection, checkAccess = false) {
  const { project, spec, targetName } = selection;
  const source = ctx.repos.environments.findById(selection.source.id);
  if (!source || source.projectId !== project.id || source.name === targetName || spec.environments[source.name]?.hosting.provider !== 'railway'
    || spec.environments[source.name]?.database?.provider !== 'railway' || spec.environments[targetName] && spec.environments[targetName].database?.provider !== 'cloudsql'
    || migrationDatabaseBindingConflict(ctx, project, spec, source, ctx.repos.environments.findByProjectAndName(project.id, targetName) ?? undefined)) throw new Error();
  const databases = ctx.repos.components.findByEnvironmentId(source.id).filter(item => item.type === 'postgres');
  const database = databases[0], { projectId, environmentId } = source.platformBindings;
  if (databases.length !== 1 || !database?.externalId || database.bindings.provider !== 'railway'
    || typeof projectId !== 'string' || typeof environmentId !== 'string'
    || (database.bindings.providerScope !== undefined && !isDeepStrictEqual(database.bindings.providerScope, { projectId, environmentId }))) throw new Error();
  const provider = spec.environments[source.name]!.hosting.provider;
  if (providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.privateMigrationSourceInspection !== 'railway-postgres-ssh') throw new Error();
  const connected = await adapterFactory.getHostingAdapterByName(provider, project);
  if (!connected.success || connected.adapter?.name !== provider || !connected.adapter.privateMigrationSourceInspection) throw new Error();
  const inspection = connected.adapter.privateMigrationSourceInspection;
  if (checkAccess) {
    const available = await inspection.hasTrustedAccess().catch(() => false);
    if (!available) throw new MissingTrustedAccess();
  }
  const observed = await inspection.observe({ projectId, environmentId, serviceId: database.externalId });
  const metadata: MigrationVersionMetadata = { operation: 'migrationSourceVersion', targetEnvironment: targetName, componentId: database.id,
    source: observed, programHash: inspection.programHash(observed) };
  return { metadata, inspection };
}

type SourceReview = Extract<MigrateResult, { status: 'blocked' | 'needs_confirmation' }>;
type ReviewSelection = Selection & { revision: number; fresh?: boolean };
export function planMigrationSourceVersion(ctx: CommandContext, selection: ReviewSelection & { fresh: true }): Promise<SourceReview>;
export function planMigrationSourceVersion(ctx: CommandContext, selection: ReviewSelection): Promise<SourceReview | { major: number }>;
export async function planMigrationSourceVersion(ctx: CommandContext, selection: ReviewSelection): Promise<SourceReview | { major: number }> {
  try {
    const { metadata, inspection } = await current(ctx, selection, selection.fresh);
    const id = migrationVersionActionId(metadata);
    const run = selection.fresh ? undefined : ctx.repos.runs.findSuccessfulApplyForStep(selection.project.id, selection.source.id, id);
    const receipt = migrationVersionReceiptSchema.safeParse(run?.receipts.find(receipt => receipt.step === id && receipt.status === 'success')?.result?.sourceVersion);
    if (run && receipt.success && isDeepStrictEqual(receipt.data.metadata, metadata)
      && (run.plan as Record<string, unknown>).planRunId === receipt.data.planId) {
      const saved = new ConvergeExecutor().loadPlan(receipt.data.planId);
      if (!('error' in saved) && saved.run.projectId === selection.project.id && saved.run.environmentId === selection.source.id
        && saved.document.scope === 'migration-source-version' && saved.document.actions[0]?.id === id) {
        return { major: Math.floor(receipt.data.inventory.versionNumber / 10000) };
      }
    }
    if (!selection.fresh && !await inspection.hasTrustedAccess().catch(() => false)) throw new MissingTrustedAccess();
    const reason = `Read the PostgreSQL server version, user-table count and estimated live rows in ${selection.source.name} over its existing SSH connection for ${selection.targetName}.`;
    const action = migrationVersionActionSchema.parse({ id, type: 'update', verified: true, requiresConfirm: true, reason, metadata,
      resource: { kind: 'database', provider: 'railway', name: 'postgres' } });
    const document: PlanRunDocument = { kind: 'hv_plan', scope: 'migration-source-version', environmentName: selection.source.name,
      specRevision: selection.revision, observedFingerprint: null, actions: [action] };
    const saved = ctx.repos.runs.create({ type: 'plan', projectId: selection.project.id, environmentId: selection.source.id, plan: document });
    ctx.repos.runs.updateStatus(saved.id, 'succeeded');
    return { status: 'needs_confirmation', planId: saved.id, ...ctx.repos.runs.planReport(saved.id), confirmActions: [id],
      changes: [{ id, change: reason }], estimatedMonthlyCost: [] };
  } catch (error) {
    const requirement = error instanceof MissingTrustedAccess
      ? 'For this SSH inspection, the selected Railway connection needs the absolute paths sshIdentityFile (an already registered private key) and sshKnownHostsFile (independently trusted Railway host keys). Supply both in that connection using a private credentials reference.'
      : 'The exact tracked Railway database, attached volume, running deployment, image digest and replica must be verifiable.';
    return { status: 'blocked', message: `The private source version could not be reviewed. ${requirement} Use hv_launch for ${selection.targetName} to prepare the empty target independently.` };
  }
}

export async function applyMigrationSourceVersion(ctx: CommandContext, selection: Selection, planId: string, action: PlanAction): Promise<ActionResult> {
  try {
    const reviewed = migrationVersionActionSchema.parse(action);
    const { metadata, inspection } = await current(ctx, selection);
    if (!isDeepStrictEqual(reviewed.metadata, metadata)) throw new Error();
    const inventory = migrationSourceInventorySchema.parse(await inspection.inspect(metadata.source));
    if (!isDeepStrictEqual((await current(ctx, selection)).metadata, metadata)) throw new Error();
    return { success: true, message: `The selected running database reported PostgreSQL ${Math.floor(inventory.versionNumber / 10000)}.`,
      data: { sourceVersion: migrationVersionReceiptSchema.parse({ planId, actionId: reviewed.id, metadata, inventory }) } };
  } catch {
    return { success: false, status: 'blocked', message: 'The private source version could not be verified for the reviewed database, image and running replica. Check the existing trusted SSH connection and local PostgreSQL socket, then review the current deployment again.' };
  }
}

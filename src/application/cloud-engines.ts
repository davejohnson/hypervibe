import type { EngineCiBinding } from '../domain/spec/engine-ci-binding.js';
import type { EngineCiReleaseTarget, GitHubOidcContext } from '../domain/ports/engine-ci.port.js';
import type { ConvergeResult } from '../domain/plan/converge.executor.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import { isEngineManaged } from '../domain/services/infrastructure-engine-selection.js';
import type { EnvironmentSpec, ProjectSpec } from '../domain/spec/spec.schema.js';
import type { CommandContext } from './context.js';
import type { EngineSecretStore } from './engine-secrets.js';
import type { EngineReleaseResult, InfrastructurePlanResult } from './infrastructure-engine.js';

export interface EnginePlanParams { project: Project; spec: ProjectSpec; specRevision: number; environmentName: string }
export interface EngineApplyParams { project: Project; spec: ProjectSpec; specRevision: number; planId: string; confirmActions: string[] }
export interface EngineReleaseParams {
  project: Project; spec: ProjectSpec; environmentName: string; specRevision: number;
  services?: string[]; revision?: string; sourceDirectory?: string;
}
export type EnginePlanOutcome = InfrastructurePlanResult | { blocked: string[]; missingOutsideKeys?: string[] };
export type EngineApplyOutcome = { kind: 'executed'; envName: string; result: ConvergeResult; warnings?: string[] } | { kind: 'blocked'; reason: string };
export type EngineReleaseOutcome =
  | { results: EngineReleaseResult[]; applyRunId: string; source?: { kind: string; revision: string; commitSha?: string; uncommittedChangesExcluded?: boolean } }
  | { blocked: string };

/**
 * One step of a cloud's guided connection. The interface shows `result` as it is;
 * anything other than connected, invalid or failed asks the person something and
 * is called again with their answer in `input`.
 */
export interface EngineConnectStep {
  status: 'waiting' | 'needs_choice' | 'needs_approval' | 'connected' | 'invalid' | 'failed';
  result: Record<string, unknown>;
  /** For the agent: what to show and how to call again. */
  hint?: string;
  /** For the agent: the one thing to ask the person. */
  ask?: string;
  /** Commands that follow a finished connection. */
  next?: string[];
  /** Why the step is invalid or failed. */
  message?: string;
}

/**
 * One cloud's implementation of the managed OpenTofu lifecycle. Generic code
 * selects an engine here and calls it; it does not branch on a cloud's name.
 * A capability a cloud lacks is an absent optional method, never a silent no-op.
 */
export interface EngineProjectRemoval {
  success: boolean;
  mode: 'preview' | 'confirm';
  /** `blocked`: nothing was deleted. `pending`: a deletion was sent and its outcome is not confirmed. */
  status?: 'blocked' | 'pending';
  error?: string;
  [detail: string]: unknown;
}

export interface CloudEngine {
  id: 'gcp' | 'aws' | 'azure';
  /** `hosting.provider` value this engine serves. */
  hostingProvider: string;
  /**
   * What hv_migrate can move into this cloud: 'full' copies runtime settings and
   * data; 'settings' copies runtime settings only. Absent: not built yet.
   */
  migration?: 'full' | 'settings';
  /** OIDC-authenticated, exact-bound image-only release; never provisions infrastructure. */
  ciRelease?(binding: EngineCiBinding, context: GitHubOidcContext, spec: ProjectSpec): Promise<EngineCiReleaseTarget>;
  /**
   * Guided one-time access setup: sign in, preview the exact access Hypervibe will
   * create, and create it once approved. `input` carries the person's answers.
   */
  connect?(params: { project: Project; spec?: ProjectSpec; input: Record<string, unknown> }): Promise<EngineConnectStep>;
  plan(ctx: CommandContext, params: EnginePlanParams): Promise<EnginePlanOutcome>;
  planBucketBackups(ctx: CommandContext, params: EnginePlanParams): Promise<EnginePlanOutcome>;
  applyBucketBackups(ctx: CommandContext, params: EngineApplyParams): Promise<EngineApplyOutcome>;
  observeBucketBackup?(project: Project, environment: Environment, spec: EnvironmentSpec, storageName: string): Promise<
    { source: string; archive: string; latestAt: string; startedAt?: string; archiveLocation?: string; recoveryPoints?: Array<{ date: string; manifestKey: string }> } | undefined>;
  /** Removes the app's shared database server, which belongs to no single environment, as a reviewed plan of its own. */
  planSharedDatabaseRemoval?(ctx: CommandContext, params: { project: Project; specRevision: number; environmentName?: string }): Promise<InfrastructurePlanResult | { blocked: string[] }>;
  /** Removes a whole environment as one reviewed plan. */
  planTeardown?(ctx: CommandContext, params: EnginePlanParams & { deleteFinalSnapshot?: boolean }): Promise<InfrastructurePlanResult | { blocked: string[] }>;
  /**
   * Removes what Hypervibe's own setup created in the cloud, once nothing depends on it: the whole
   * project on Google, Hypervibe's account access on AWS. A preview until called again with that
   * preview's id and `confirm`. `cloudProjectId` is the Google project id or the AWS account id.
   */
  removeProject?(params: { project: Project; cloudProjectId: string; previewId?: string; confirm?: boolean }): Promise<EngineProjectRemoval>;
  /** How a command reaches `removeProject`: which input names the target, and the words for it. */
  projectRemoval?: {
    idInput: 'gcpProjectId' | 'awsAccountId' | 'azureSubscriptionId';
    /** The preview finds the target after sign-in, so the id is given only to confirm. */
    idFromPreview?: true;
    /** Removal signs in with the administrator's default Google credentials, so the command must say so. */
    adminAuth?: 'default';
    /** One sentence listing the fields the command takes. */
    usage: string;
    /** What the agent shows and asks the person before confirming. */
    ask: (cloudProjectId: string, projectName: string) => string;
    /** Used when a failed removal gives no reason. */
    failure: string;
  };
  apply(ctx: CommandContext, params: EngineApplyParams): Promise<EngineApplyOutcome>;
  release(ctx: CommandContext, params: EngineReleaseParams): Promise<EngineReleaseOutcome>;
  /** Generates a repository workflow only after the exact applied CI binding exists. */
  ciWorkflow?(repositoryRoot: string, binding: unknown): Promise<{ path: string; changed: boolean; branch: string }>;
  secretStore(ctx: CommandContext, project: Project, spec: ProjectSpec, environmentName: string): Promise<EngineSecretStore | { blocked: string }>;
  /** True when a saved plan document was produced by this engine. */
  ownsPlan(document: { engine?: Record<string, unknown> }): boolean;
}

// Engine modules load on first use: they import shared code from each other's
// neighbours, and most commands touch one cloud.
const gcp: CloudEngine = {
  id: 'gcp', hostingProvider: 'cloudrun', migration: 'full',
  planBucketBackups: async (ctx, params) => (await import('./gcp-bucket-backups.js')).planGcpBucketBackups(ctx, params),
  applyBucketBackups: async (ctx, params) => (await import('./gcp-bucket-backups.js')).applyGcpBucketBackups(ctx, params),
  observeBucketBackup: async (...params) => (await import('./gcp-bucket-backups.js')).observeGcpBucketBackups(...params),
  plan: async (ctx, params) => (await import('./infrastructure-engine.js')).planGcpInfrastructureEngine(ctx, params),
  planTeardown: async (ctx, params) => (await import('./infrastructure-engine.js')).planGcpTeardown(ctx, params),
  planSharedDatabaseRemoval: async (ctx, params) => (await import('./gcp-shared-database-removal.js')).planGcpSharedDatabaseRemoval(ctx, params),
  removeProject: async ({ project, cloudProjectId, previewId, confirm }) => ({ ...await (await import('./gcp-project-removal.js')).runGcpProjectRemoval({ project, gcpProjectId: cloudProjectId, previewId, confirm }) }),
  projectRemoval: {
    idInput: 'gcpProjectId', adminAuth: 'default', failure: 'The Google project was not removed.',
    usage: 'action="remove-project" takes provider="cloudrun", project, the exact gcpProjectId and adminAuth="default"; add previewId and confirm=true only after reviewing its preview.',
    ask: (id) => `Show the user this preview for Google project ${id}: what was checked, what was not checked and every warning. Ask whether to delete the whole Google project. Confirm only after they say yes to deleting this exact project.`,
  },
  apply: async (ctx, params) => (await import('./infrastructure-engine.js')).applyGcpInfrastructureEngine(ctx, params),
  release: async (ctx, params) => (await import('./infrastructure-engine.js')).releaseGcpEngineServices(ctx, params),
  secretStore: async (ctx, project, spec, environmentName) => (await import('./infrastructure-engine.js')).gcpSecretStore(ctx, project, spec, environmentName),
  ownsPlan: (document) => typeof document.engine?.gcpProjectId === 'string',
};

const aws: CloudEngine = {
  id: 'aws', hostingProvider: 'aws', migration: 'settings',
  planBucketBackups: async (ctx, params) => (await import('./aws-azure-bucket-backups.js')).planAwsBucketBackups(ctx, params),
  applyBucketBackups: async (ctx, params) => (await import('./aws-azure-bucket-backups.js')).applyAwsBucketBackups(ctx, params),
  observeBucketBackup: async (...params) => (await import('./aws-azure-bucket-backups.js')).observeAwsAzureBucketBackups(...params),
  ciWorkflow: async (root, binding) => (await import('./engine-ci-workflow.js')).writeEngineCiWorkflow(root, binding),
  ciRelease: async (binding, context, spec) => (await import('../adapters/providers/aws/aws-ci-release.js')).createAwsCiReleaseTarget(binding, context, spec),
  plan: async (ctx, params) => (await import('./infrastructure-engine-aws.js')).planAwsInfrastructureEngine(ctx, params),
  planTeardown: async (ctx, params) => (await import('./infrastructure-engine-aws.js')).planAwsTeardown(ctx, params),
  removeProject: async ({ project, cloudProjectId, previewId, confirm }) => ({ ...await (await import('./aws-setup-removal.js')).runAwsSetupRemoval({ project, awsAccountId: cloudProjectId, previewId, confirm }) }),
  projectRemoval: {
    idInput: 'awsAccountId', failure: 'Hypervibe\'s setup was not removed from the AWS account.',
    usage: 'action="remove-project" takes provider="aws", project and the exact awsAccountId; add previewId and confirm=true only after reviewing its preview.',
    ask: (id) => `Show the user this preview for AWS account ${id}: everything in willDelete, everything left alone or left behind with its link, and every warning. Ask whether to remove Hypervibe's setup from this AWS account. Confirm only after they say yes for this exact account.`,
  },
  apply: async (ctx, params) => (await import('./infrastructure-engine-aws.js')).applyAwsInfrastructureEngine(ctx, params),
  release: async (ctx, params) => (await import('./infrastructure-engine-aws-release.js')).releaseAwsEngineServices(ctx, params),
  secretStore: async (ctx, project, spec, environmentName) => (await import('./infrastructure-engine-aws.js')).awsSecretStore(ctx, project, environmentName, spec),
  connect: async (params) => (await import('./aws-connect.js')).connectAwsStep(params),
  ownsPlan: (document) => Boolean(document.engine?.aws),
};

const azure: CloudEngine = {
  id: 'azure', hostingProvider: 'azure',
  planBucketBackups: async (ctx, params) => (await import('./aws-azure-bucket-backups.js')).planAzureBucketBackups(ctx, params),
  applyBucketBackups: async (ctx, params) => (await import('./aws-azure-bucket-backups.js')).applyAzureBucketBackups(ctx, params),
  observeBucketBackup: async (...params) => (await import('./aws-azure-bucket-backups.js')).observeAwsAzureBucketBackups(...params),
  ciWorkflow: async (root, binding) => (await import('./engine-ci-workflow.js')).writeEngineCiWorkflow(root, binding),
  ciRelease: async (binding, context, spec) => (await import('../adapters/providers/azure/azure-ci-release.js')).createAzureCiReleaseTarget(binding, context, spec),
  plan: async (ctx, params) => (await import('./infrastructure-engine-azure.js')).planAzureInfrastructureEngine(ctx, params),
  planTeardown: async (ctx, params) => (await import('./infrastructure-engine-azure.js')).planAzureTeardown(ctx, params),
  apply: async (ctx, params) => (await import('./infrastructure-engine-azure.js')).applyAzureInfrastructureEngine(ctx, params),
  release: async (ctx, params) => (await import('./infrastructure-engine-azure-release.js')).releaseAzureEngineServices(ctx, params),
  secretStore: async (ctx, project, _spec, environmentName) => (await import('./infrastructure-engine-azure.js')).azureSecretStore(ctx, project, environmentName),
  connect: async (params) => (await import('./azure-connect.js')).connectAzureStep(params),
  // Azure has no project of its own to delete: this removes what one-time setup created. `cloudProjectId` is the subscription id, empty on a first preview.
  removeProject: async ({ project, cloudProjectId, previewId, confirm }) => ({ ...await (await import('./azure-setup-removal.js')).runAzureSetupRemoval({ project, subscriptionId: cloudProjectId, previewId, confirm }) }),
  projectRemoval: {
    idInput: 'azureSubscriptionId', idFromPreview: true, failure: 'Hypervibe\'s Azure setup was not removed.',
    usage: 'action="remove-project" with provider="azure" takes project only; to confirm, add the preview\'s subscriptionId as azureSubscriptionId, its previewId and confirm=true.',
    ask: (_id, name) => `Show the user this preview for ${name}: everything in willDelete, everything in willPurge (permanent), what is left behind and every warning. Ask whether to remove Hypervibe's Azure setup. Confirm only after they say yes to exactly this list.`,
  },
  ownsPlan: (document) => Boolean(document.engine?.azure),
};

export const cloudEngines: readonly CloudEngine[] = [gcp, aws, azure];
export const gcpEngine = gcp;
export const awsEngine = aws;

/** The engine that manages an environment, or undefined when no engine does. */
export function cloudEngineFor(spec: ProjectSpec, environmentName: string): CloudEngine | undefined {
  const environment = spec.environments[environmentName];
  if (!isEngineManaged(environment)) return undefined;
  return cloudEngines.find((engine) => engine.hostingProvider === environment!.hosting.provider);
}

/**
 * The engine that must apply a saved plan. A plan names its own cloud, so a
 * teardown still resolves after its environment has left the spec.
 */
export function cloudEngineForPlan(document: { environmentName: string; engine?: Record<string, unknown> }, spec: ProjectSpec): CloudEngine {
  return [azure, aws].find((engine) => engine.ownsPlan(document)) ?? cloudEngineFor(spec, document.environmentName) ?? gcp;
}

/** Plans removing the app's shared database server on the cloud that has one. */
export async function planSharedDatabaseRemoval(ctx: CommandContext, params: { project: Project; specRevision: number; environmentName?: string }): Promise<InfrastructurePlanResult | { blocked: string[] }> {
  const engine = cloudEngines.find((candidate) => candidate.planSharedDatabaseRemoval);
  return engine?.planSharedDatabaseRemoval ? engine.planSharedDatabaseRemoval(ctx, params) : { blocked: ['No cloud has a shared database server to remove.'] };
}

/** The engine that can remove what this connection provider's setup created in the cloud. */
export function cloudEngineForProjectRemoval(provider: string): CloudEngine | undefined {
  return cloudEngines.find((engine) => engine.removeProject && engine.projectRemoval && engine.hostingProvider === provider);
}

/** The engine whose guided connection serves a connection provider name, if it has one. */
export function cloudEngineForConnection(provider: string): CloudEngine | undefined {
  return cloudEngines.find((engine) => engine.connect && engine.hostingProvider === provider);
}

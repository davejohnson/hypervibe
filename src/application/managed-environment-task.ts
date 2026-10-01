import { createRequire } from 'node:module';
import { parse as parseYaml } from 'yaml';
import type { GitHubAdapter } from '../adapters/providers/github/github.adapter.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Service } from '../domain/entities/service.entity.js';
import type { IHostingAdapter } from '../domain/ports/hosting.port.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import type { GitHubAutomationSpec, ProjectSpec } from '../domain/spec/spec.schema.js';
import { repoBindingsFileSchema } from '../domain/spec/repo-bindings.schema.js';
import { canonicalJsonSha256 } from '../lib/canonical-json.js';
import { workflowFilesContentHash } from '../domain/services/ci-deploy.service.js';
import { releaseEvidenceValidationRuntime } from '../domain/services/github-ops.service.js';
import { managedCiReleaseArtifactName, MANAGED_CI_RELEASE_EVIDENCE_FILE } from '../domain/services/managed-ci-evidence.js';

type Task = Extract<GitHubAutomationSpec, { kind: 'environment-task' }>;
type JsonRecord = Record<string, unknown>;
export class ManagedTaskExecutionError extends Error {
  constructor(public readonly attempted: boolean) {
    super(attempted
      ? 'Task execution, receipt, or cleanup could not be verified. Review staging before retrying.'
      : 'Task prerequisites could not be verified. No task was started.');
  }
}
function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Incomplete task evidence.');
  return value as JsonRecord;
}
const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Fixed reviewed argv; dispatch values never become executable shell text. */
export function buildManagedTaskCommand(task: Task, inputs: unknown): string {
  const supplied = record(inputs);
  if (Object.keys(supplied).some((key) => !Object.hasOwn(task.inputs, key))) throw new Error('Unknown task input.');
  const argv = [...task.command];
  for (const [key, input] of Object.entries(task.inputs)) {
    const value = supplied[key] ?? input.default;
    if (input.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error('Task boolean input is malformed.');
      if (value) argv.push(input.flag);
    } else {
      if (typeof value !== 'string' || value.length > 320 || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('-')) {
        throw new Error('Task text input is malformed.');
      }
      if (!value.trim()) {
        if (input.required) throw new Error('Required task input is missing.');
      } else argv.push(input.flag, value);
    }
  }
  return argv.map(quote).join(' ');
}

/** Deliberately excludes free text, account details and arbitrary task logs. */
export function safeManagedTaskReceipt(output: string, prefix: string, countKeys: string[] = ['applied', 'skipped']): JsonRecord {
  const lines = output.split('\n').filter((line) => line.startsWith(prefix));
  if (lines.length !== 1 || lines[0].length > 8000) throw new Error('Task did not emit one bounded receipt.');
  const value = record(JSON.parse(lines[0].slice(prefix.length)));
  const counts = record(value.counts);
  if (value.version !== 1 || typeof value.mode !== 'string' || !['preview', 'applied', 'list'].includes(value.mode)
      || Object.keys(counts).length > 32 || !Object.hasOwn(counts, 'applied') || !Object.hasOwn(counts, 'skipped')
      || Object.entries(counts).some(([key, count]) => !countKeys.includes(key)
        || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) {
    throw new Error('Task receipt is malformed.');
  }
  if (value.mode !== 'applied' && Object.values(counts).some((count) => count !== 0)) throw new Error('Preview receipt reports writes.');
  const receipt: JsonRecord = { version: 1, mode: value.mode, counts };
  if (value.accountAction !== undefined && value.accountAction !== null) {
    if (typeof value.accountAction !== 'string' || !['would-invite', 'would-reuse', 'invited', 'reused'].includes(value.accountAction)) throw new Error('Task account receipt is malformed.');
    receipt.accountAction = value.accountAction;
  }
  if (value.mode === 'preview' && value.planned !== undefined) {
    const planned = record(value.planned);
    if (Object.keys(planned).length > 32 || Object.entries(planned).some(([key, count]) => !countKeys.includes(key)
        || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) throw new Error('Task preview receipt is malformed.');
    receipt.planned = planned;
  }
  return receipt;
}

function evidenceValidator(): {
  deploymentContractFingerprint(spec: unknown, environment: string): string;
  validateReleaseEvidence(evidence: unknown, expected: JsonRecord): { imageUri: string };
} {
  // The same repository-owned producer/consumer used by managed deploy and rollback.
  const module = { exports: {} };
  new Function('require', 'module', 'exports', releaseEvidenceValidationRuntime())(
    createRequire(import.meta.url), module, module.exports,
  );
  return module.exports as ReturnType<typeof evidenceValidator>;
}

export async function executeManagedEnvironmentTask(params: {
  spec: ProjectSpec;
  rawSpec: unknown;
  bindings: unknown;
  taskId: string;
  inputs: unknown;
  repository: string;
  sha: string;
  executionId: string;
  github: GitHubAdapter;
  credentials: Record<string, string | undefined>;
}): Promise<JsonRecord> {
  let attempted = false;
  try {
    const task = params.spec.github?.actions[params.taskId];
    if (!task || task.kind !== 'environment-task' || !task.enabled) throw new Error('Named environment task is not declared.');
    const command = buildManagedTaskCommand(task, params.inputs);
    if (!/^[0-9a-f]{40}$/.test(params.sha) || !/^[0-9]+$/.test(params.executionId)) throw new Error('Workflow identity is malformed.');
    const [owner, repo, extra] = params.repository.split('/');
    if (!owner || !repo || extra || params.spec.github?.repository !== params.repository) throw new Error('Task repository does not match desired state.');
    const bindings = repoBindingsFileSchema.parse(params.bindings);
    if (bindings.project !== params.spec.project) throw new Error('Task bindings belong to another project.');
    const desired = params.spec.environments[task.environment];
    const bound = bindings.environments[task.environment]?.platformBindings;
    if (!desired?.services[task.service] || !bound || bound.provider !== desired.hosting?.provider) throw new Error('Task target has incomplete bindings.');
    const provider = String(bound.provider);
    const metadata = providerRegistry.getMetadata(provider);
    if (!metadata?.lifecycle?.hosting?.environmentTasks) throw new Error('Hosting provider does not support declared private environment tasks.');
    const ci = record(bound.ci);
    const workflows = Object.keys(record(ci.deployBranch));
    if (workflows.length !== 1 || !/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(workflows[0])) throw new Error('Task requires one bound managed deployment workflow.');
    const workflow = workflows[0];
    const repository = await params.github.getRepository(owner, repo);
    if (desired.deploy?.branch !== repository.default_branch) throw new Error('Task deployment branch is not the repository default.');
    const workflowFile = await params.github.getFileContent(owner, repo, workflow, params.sha);
    if (!workflowFile) throw new Error('Managed deployment workflow is missing.');
    const source = workflowFile;
    const workflowBinding = record(record(ci.deployBranch)[workflow]);
    const paths = workflowBinding.managedPaths ?? [workflow];
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 16 || new Set(paths).size !== paths.length
        || !paths.includes(workflow) || paths.some((path) => typeof path !== 'string' || !/^\.github\/(?:workflows|hypervibe)\/[A-Za-z0-9_./-]+$/.test(path) || path.split('/').includes('..'))) {
      throw new Error('Managed deployment file bindings are incomplete.');
    }
    const files = [];
    for (const path of paths as string[]) {
      const content = path === workflow ? source : await params.github.getFileContent(owner, repo, path, params.sha);
      if (content === null) throw new Error('Managed deployment companion file is missing.');
      files.push({ path, content });
    }
    if (workflowBinding.contentHash !== workflowFilesContentHash(files)) throw new Error('Managed deployment workflow differs from its accepted binding.');
    const concurrency = record(record(parseYaml(source)).concurrency);
    if (concurrency.group !== `hypervibe-deploy-${task.environment}` || concurrency['cancel-in-progress'] !== false) {
      throw new Error('Task and deployment do not share the reviewed execution lock.');
    }
    const fingerprints = [...source.matchAll(/HYPERVIBE_RELEASE_PROGRAM_FINGERPRINT: ([a-f0-9]{64})/g)].map((match) => match[1]);
    if (new Set(fingerprints).size !== 1) throw new Error('Managed deployment workflow has incomplete program evidence.');
    // Only the latest deployment may authorize a task. A failed or running newer
    // deployment must not silently fall back to an older successful image.
    const listing = await params.github.listWorkflowRuns(owner, repo, workflow, { per_page: 1 });
    const run = listing.workflow_runs[0];
    if (!run || run.status !== 'completed' || run.conclusion !== 'success' || run.head_sha !== params.sha
        || run.head_branch !== repository.default_branch) throw new Error('Deploy this exact default-branch revision successfully before running the task.');
    const verifiedRun = await params.github.getWorkflowRun(owner, repo, run.id);
    if (verifiedRun.path !== workflow || verifiedRun.head_sha !== params.sha
        || verifiedRun.repository.full_name !== params.repository || verifiedRun.head_repository.full_name !== params.repository
        || verifiedRun.status !== 'completed' || verifiedRun.conclusion !== 'success') throw new Error('Deployment run provenance is incomplete.');
    const artifacts = await params.github.listWorkflowRunArtifacts(owner, repo, run.id);
    const candidates = artifacts.artifacts.filter((artifact) => artifact.name === managedCiReleaseArtifactName(task.environment, params.sha) && !artifact.expired);
    if (artifacts.total_count !== artifacts.artifacts.length || candidates.length !== 1
        || candidates[0].workflow_run?.id !== run.id || candidates[0].workflow_run.head_sha !== params.sha) throw new Error('Deployment artifact identity is incomplete or ambiguous.');
    const evidence = await params.github.readJsonArtifact(owner, repo, candidates[0].id, MANAGED_CI_RELEASE_EVIDENCE_FILE);
    const services = record(bound.services);
    const resources = Object.entries(desired.services).map(([name, configuration]) => {
      const identity = record(services[name]);
      if (typeof identity.serviceId !== 'string' || !identity.serviceId || identity.workloadKind !== configuration.workloadKind) throw new Error('Task release resource bindings are incomplete.');
      return { logicalName: name, workloadKind: configuration.workloadKind, providerResourceType: 'service', providerResourceId: identity.serviceId };
    }).sort((a, b) => a.logicalName.localeCompare(b.logicalName));
    const scope = {
      providerProjectId: bound.projectId,
      providerEnvironmentId: bound.environmentId,
    };
    const validator = evidenceValidator();
    const target = { scope, resources, bindingsFingerprint: canonicalJsonSha256({ version: 1, provider, environment: task.environment, scope, resources }) };
    const { imageUri } = validator.validateReleaseEvidence(evidence, {
      label: 'Environment task', provider, environment: task.environment, repository: params.repository, sha: params.sha,
      programFingerprint: fingerprints[0], deploymentContractFingerprint: validator.deploymentContractFingerprint(params.rawSpec, task.environment),
      target, requireImmutableImage: true,
    });
    const credentialKeys = metadata.orchestration?.ci?.secretCredentialKeys;
    if (!credentialKeys || !Object.keys(credentialKeys).length) throw new Error('Task provider has no reviewed CI credential contract.');
    // Exact environment secret scope is observed by plan/apply with the owner's
    // recorded connection. The Actions token lacks Environments-read permission;
    // CI receives the reviewed job environment's credentials without listing them.
    const credentials = Object.fromEntries(Object.entries(credentialKeys).map(([key, property]) => {
      if (!params.credentials[key]) throw new Error('Required managed task credential is missing.');
      return [property, params.credentials[key]];
    }));
    if (!params.credentials.IMAGE_REGISTRY_USERNAME || !params.credentials.IMAGE_REGISTRY_TOKEN) throw new Error('Managed task image credentials are missing.');
    const adapter = await providerRegistry.createAdapter<IHostingAdapter>(provider, credentials);
    if (!adapter.runJob) throw new Error('Hosting adapter has no declared task implementation.');
    const now = new Date();
    const environment: Environment = { id: task.environment, projectId: bindings.project, name: task.environment, platformBindings: bound, createdAt: now, updatedAt: now };
    const service: Service = { id: task.service, projectId: bindings.project, name: task.service, buildConfig: desired.services[task.service], envVarSpec: {}, createdAt: now, updatedAt: now };
    attempted = true;
    const result = await adapter.runJob(environment, service, command, { declaredTask: {
      variableMode: 'references', sweep: false, expectedImage: imageUri, executionId: params.executionId,
      registryCredentials: { username: params.credentials.IMAGE_REGISTRY_USERNAME, token: params.credentials.IMAGE_REGISTRY_TOKEN },
    } });
    if (result.mutationAttempted === false) attempted = false;
    if (!result.receipt.success || result.status !== 'completed' || result.exitCode !== 0 || result.cleanupWarning) throw new Error('Environment task failed or cleanup remains unverified. Do not retry an applied run without reviewing its outcome.');
    const application = task.receiptPrefix ? safeManagedTaskReceipt(result.output ?? '', task.receiptPrefix, task.receiptCountKeys) : undefined;
    return { version: 1, task: params.taskId, environment: task.environment, executionId: params.executionId, status: 'completed', exitCode: 0,
      jobId: result.jobId, ...(application ? { application } : {}) };
  } catch {
    throw new ManagedTaskExecutionError(attempted);
  }
}

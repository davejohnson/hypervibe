import { createHash } from 'crypto';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import type { GitHubCredentials } from '../../adapters/providers/github/github.adapter.js';
import type { Project } from '../entities/project.entity.js';
import { projectSpecSchema, type IosSpec } from '../spec/spec.schema.js';
import { effectiveRuntimeInstallCommand, type ProjectRuntime } from '../spec/project-runtime.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import { buildIosReleaseWorkflow } from './ios-release-workflow.service.js';
import {
  managedCiProviderScope,
  managedCiReleaseTarget,
  resolveReviewedBranchDeployTargets,
} from './managed-ci-targets.js';
export { IOS_RELEASE_REQUIRED_SECRETS } from './ios-release-workflow.service.js';
import type {
  BranchDeployEnvironmentKind,
  BranchDeployProvider,
  BranchDeployReleaseResource,
  BranchDeployReleaseTarget,
  BranchDeployTarget,
  BranchDeployWorkflow,
} from '../ports/ci-deploy.port.js';

const connectionRepo = new ConnectionRepository();
const envRepo = new EnvironmentRepository();
const projectSpecRepo = new ProjectSpecRepository();


/**
 * Get a GitHub adapter, using scoped connection if available.
 * @param scopeHint - Optional scope hint (e.g., "owner/repo" or "owner/*") for finding scoped tokens
 */
export function getGitHubAdapter(scopeHint?: string): { adapter: GitHubAdapter } | { error: string } {
  const connection = connectionRepo.findBestVerifiedMatch('github', scopeHint);
  if (!connection) {
    return { error: `No verified GitHub connection found. ${formatConnectionGuidance('github', { scope: scopeHint })}` };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<GitHubCredentials>(connection.credentialsEncrypted);
  const adapter = new GitHubAdapter();
  adapter.connect(credentials);

  return { adapter };
}


export type {
  BranchDeployEnvironmentKind,
  BranchDeployProvider,
  BranchDeployTarget,
  BranchDeployWorkflow,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function classifyEnvironmentName(name: string): BranchDeployEnvironmentKind | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized || normalized === 'local') return null;
  if (normalized === 'production' || normalized === 'prod' || normalized.includes('prod')) return 'production';
  if (normalized === 'staging' || normalized === 'stage' || normalized.includes('stag')) return 'staging';
  if (normalized === 'development' || normalized === 'dev' || normalized.includes('develop')) return 'development';
  if (normalized === 'test' || normalized.includes('test')) return 'test';
  return 'custom';
}

function environmentBindings(projectId: string, environmentName: string, desiredServiceNames?: Set<string>): {
  provider?: string;
  providerProjectId?: string;
  providerEnvironmentId?: string;
  providerServiceIds: string[];
  providerJobNames: string[];
  boundServiceNames: string[];
  releaseResources: BranchDeployReleaseResource[];
} {
  const environment = envRepo.findByProjectAndName(projectId, environmentName);
  const bindings = asRecord(environment?.platformBindings);
  const services = asRecord(bindings?.services);
  const boundServiceNames = Object.keys(services ?? {});
  const providerServiceIds: string[] = [];
  const providerJobNames: string[] = [];
  const releaseResources: BranchDeployReleaseResource[] = [];
  for (const [serviceName, service] of Object.entries(services ?? {})) {
    if (desiredServiceNames && !desiredServiceNames.has(serviceName)) continue;
    const record = asRecord(service);
    const serviceId = typeof record?.serviceId === 'string' && record.serviceId.trim().length > 0
      ? record.serviceId.trim()
      : undefined;
    const jobName = typeof record?.jobName === 'string' && record.jobName.trim().length > 0
      ? record.jobName.trim()
      : undefined;
    const isScheduledJob = record?.resourceType === 'scheduledJob' || Boolean(jobName);
    if (isScheduledJob) {
      const target = jobName ?? serviceId;
      if (target) providerJobNames.push(target);
    } else if (serviceId) {
      providerServiceIds.push(serviceId);
    }
    const boundKind = record?.workloadKind;
    const workloadKind = boundKind === 'web' || boundKind === 'worker' || boundKind === 'cron'
      ? boundKind
      : isScheduledJob ? 'cron' : 'web';
    const providerResourceId = isScheduledJob ? jobName ?? serviceId : serviceId;
    if (providerResourceId) {
      releaseResources.push({
        logicalName: serviceName,
        workloadKind,
        providerResourceType: isScheduledJob ? 'job' : 'service',
        providerResourceId,
      });
    }
  }
  return {
    provider: typeof bindings?.provider === 'string' && bindings.provider.trim().length > 0
      ? bindings.provider.trim()
      : undefined,
    providerProjectId: typeof bindings?.projectId === 'string' ? bindings.projectId : undefined,
    providerEnvironmentId: typeof bindings?.environmentId === 'string' ? bindings.environmentId : undefined,
    providerServiceIds,
    providerJobNames,
    boundServiceNames,
    releaseResources,
  };
}

function legacyServiceNames(desiredState: Record<string, unknown> | null): string[] {
  const names = new Set<string>();
  const services = Array.isArray(desiredState?.services) ? desiredState.services : [];
  for (const service of services) {
    if (typeof service === 'string' && service.trim().length > 0) {
      names.add(service.trim());
    }
  }
  if (typeof desiredState?.serviceName === 'string' && desiredState.serviceName.trim().length > 0) {
    names.add(desiredState.serviceName.trim());
  }
  const serviceConfig = asRecord(desiredState?.serviceConfig);
  for (const serviceName of Object.keys(serviceConfig ?? {})) {
    if (serviceName.trim().length > 0) {
      names.add(serviceName.trim());
    }
  }
  return Array.from(names);
}

function legacyBranchDeployProgramFingerprint(
  provider: string,
  target: Pick<BranchDeployTarget, 'environmentName' | 'branch' | 'autoDeployOnPush' | 'serviceNames'>
): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    provider,
    environment: target.environmentName,
    branch: target.branch,
    autoDeployOnPush: target.autoDeployOnPush,
    services: [...target.serviceNames].sort(),
  }), 'utf8').digest('hex');
}

export function resolveBranchDeployTargets(project: Project): {
  targets: BranchDeployTarget[];
  desiredBranches: Record<string, string | undefined>;
  migration: { includeStep: boolean; command?: string; note?: string };
  skippedEnvironments: string[];
} {
  const specRow = projectSpecRepo.findLatest(project.id);
  const parsedSpec = specRow ? projectSpecSchema.safeParse(specRow.document) : null;
  if (parsedSpec?.success) {
    return resolveReviewedBranchDeployTargets(project, parsedSpec.data);
  }

  const desiredState = asRecord(project.policies?.desiredState);
  const desiredServiceNames = legacyServiceNames(desiredState);
  const desiredDeploy = asRecord(desiredState?.deploy);
  const desiredBranchesRecord = asRecord(desiredDeploy?.branches);
  const desiredBranches = {
    staging:
      typeof desiredBranchesRecord?.staging === 'string' && desiredBranchesRecord.staging.trim().length > 0
        ? desiredBranchesRecord.staging.trim()
        : undefined,
    production:
      typeof desiredBranchesRecord?.production === 'string' && desiredBranchesRecord.production.trim().length > 0
        ? desiredBranchesRecord.production.trim()
        : undefined,
  };

  const desiredEnvironmentName =
    typeof desiredState?.environmentName === 'string' && desiredState.environmentName.trim().length > 0
      ? desiredState.environmentName.trim()
      : undefined;

  const migrations = asRecord(desiredState?.migrations);
  const migrationMode = typeof migrations?.mode === 'string' ? migrations.mode : undefined;
  const migrationCommand =
    typeof migrations?.command === 'string' && migrations.command.trim().length > 0
      ? migrations.command.trim()
      : undefined;
  const includeMigrationStep =
    migrationMode === 'tool' && migrations?.runInDeploy !== false && Boolean(migrationCommand);

  const candidateEnvironmentNames = Array.from(
    new Set(
      [
        ...envRepo.findByProjectId(project.id).map((environment) => environment.name),
        desiredEnvironmentName,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    )
  );

  const targetsByKind = new Map<BranchDeployEnvironmentKind, BranchDeployTarget>();
  const boundProvidersByEnvironment = new Map<string, string>();
  const skippedEnvironments: string[] = [];

  for (const environmentName of candidateEnvironmentNames) {
    const kind = classifyEnvironmentName(environmentName);
    if (!kind) {
      skippedEnvironments.push(environmentName);
      continue;
    }
    if (targetsByKind.has(kind)) {
      skippedEnvironments.push(environmentName);
      continue;
    }

    const bindings = environmentBindings(project.id, environmentName);
    const target: BranchDeployTarget = {
      environmentName,
      kind,
      branch: kind === 'production'
        ? desiredBranches.production ?? 'main'
        : desiredBranches.staging ?? 'main',
      autoDeployOnPush: kind !== 'production',
      serviceNames: desiredServiceNames.length > 0 ? desiredServiceNames : bindings.boundServiceNames,
      providerProjectId: bindings.providerProjectId,
      providerEnvironmentId: bindings.providerEnvironmentId,
      providerServiceIds: bindings.providerServiceIds,
      providerJobNames: bindings.providerJobNames,
      needsServiceNames: true,
      needsJobNames: bindings.providerJobNames.length > 0,
    };
    if (bindings.provider) {
      boundProvidersByEnvironment.set(environmentName, bindings.provider);
      target.programFingerprint = legacyBranchDeployProgramFingerprint(bindings.provider, target);
      target.releaseTarget = managedCiReleaseTarget({
        provider: bindings.provider,
        environmentName,
        scope: managedCiProviderScope(target),
        resources: bindings.releaseResources,
      });
    }
    targetsByKind.set(kind, target);
  }

  const productionTarget = targetsByKind.get('production');
  const stagingTarget = targetsByKind.get('staging');
  const stagingProvider = stagingTarget
    ? boundProvidersByEnvironment.get(stagingTarget.environmentName)
    : undefined;
  if (productionTarget && stagingTarget && stagingProvider && stagingTarget.programFingerprint) {
    productionTarget.promoteFromEnvironment = stagingTarget.environmentName;
    productionTarget.promoteFromProvider = stagingProvider;
    productionTarget.promoteFromServiceNames = [...stagingTarget.serviceNames];
    productionTarget.promoteFromProgramFingerprint = stagingTarget.programFingerprint;
    productionTarget.promoteFromReleaseTarget = stagingTarget.releaseTarget;
  }

  const targets = Array.from(targetsByKind.values()).sort((a, b) => {
    if (a.kind === b.kind) return a.environmentName.localeCompare(b.environmentName);
    return a.kind === 'staging' ? -1 : 1;
  });

  return {
    targets,
    desiredBranches,
    migration: {
      includeStep: includeMigrationStep,
      command: migrationCommand,
      note:
        migrationMode === 'releaseCommand'
          ? 'Project uses release-command migrations; branch workflows will not run migrations in GitHub Actions.'
          : undefined,
    },
    skippedEnvironments,
  };
}

function buildMigrationStep(command: string, runtime: ProjectRuntime): string {
  // Migrations run app tooling (prisma, node scripts), so the runner needs
  // dependencies installed — the deploy steps that follow build a container
  // image and never run npm ci on the runner themselves.
  const installCommand = effectiveRuntimeInstallCommand(runtime);
  const setup = runtime.kind === 'node'
    ? `      - uses: actions/setup-node@v6
        if: steps.deploy.outputs.operation != 'rollback'
        with:
          node-version: '${runtime.version}'
          check-latest: true
          cache: 'npm'
      - name: Install dependencies for migrations
        if: steps.deploy.outputs.operation != 'rollback'
        run: ${installCommand}`
    : `      - uses: actions/setup-python@v6
        if: steps.deploy.outputs.operation != 'rollback'
        with:
          python-version: '${runtime.version}'
          check-latest: true
          cache: 'pip'
      - name: Install dependencies for migrations
        if: steps.deploy.outputs.operation != 'rollback'
        run: ${installCommand}`;
  return `${setup}
      - name: Run migrations
        if: steps.deploy.outputs.operation != 'rollback'
        run: ${command}
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
`;
}

function buildProviderDeploySteps(provider: BranchDeployProvider, target: BranchDeployTarget) {
  const ci = providerRegistry.getMetadata(provider)?.orchestration?.ci;
  if (!ci) {
    throw new Error(`GitHub Actions branch deploys are not supported for provider "${provider}".`);
  }
  return ci.buildGitHubActionsSteps(target);
}

function buildWorkflowTrigger(target: BranchDeployTarget): string {
  const dispatch = `  workflow_dispatch:
    inputs:
      commit_sha:
        description: 'Commit SHA to deploy. Defaults to the selected ref when omitted.'
        required: false
        type: string
      rollback:
        description: 'Restore a previously verified release. Hypervibe sets this automatically.'
        required: false
        default: false
        type: boolean
      expected_latest_run_id:
        description: 'Latest observed deploy run. Hypervibe uses it to reject stale rollback dispatches.'
        required: false
        type: string
      source_artifact_id:
        description: 'Verified release artifact selected by Hypervibe for rollback.'
        required: false
        type: string
      source_workflow_run_id:
        description: 'Successful workflow run that emitted the verified rollback artifact.'
        required: false
        type: string`;
  if (!target.autoDeployOnPush) {
    return dispatch;
  }
  return `  push:
    branches: [${target.branch}]
${dispatch}`;
}

function buildDeploymentContractStep(environmentName: string, ifCondition?: string): string {
  return `      - name: "Deployment safety gate: verify Hypervibe reconciliation"
${ifCondition ? `        if: ${ifCondition}\n` : ''}        uses: actions/github-script@v9
        env:
          HYPERVIBE_ENVIRONMENT: ${JSON.stringify(environmentName)}
          HYPERVIBE_APPLIED_SPEC_HASH: \${{ vars.HYPERVIBE_APPLIED_SPEC_HASH }}
          HYPERVIBE_DEPLOY_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const { createHash } = require('crypto');
            const { readFileSync } = require('fs');

            function asRecord(value) {
              return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
            }

            function canonicalize(value) {
              if (Array.isArray(value)) return value.map(canonicalize);
              const record = asRecord(value);
              if (!record) return value;
              return Object.fromEntries(
                Object.entries(record)
                  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
                  .map(([key, child]) => [key, canonicalize(child)])
              );
            }

            const spec = JSON.parse(readFileSync('.hypervibe/spec.json', 'utf8'));
            const environmentName = process.env.HYPERVIBE_ENVIRONMENT;
            const environment = asRecord(spec.environments)?.[environmentName];
            if (!asRecord(environment)) {
              throw new Error('Hypervibe spec has no environment "' + environmentName + '".');
            }
            const secrets = Object.fromEntries(
              Object.entries(asRecord(spec.secrets) || {})
                .filter(([, value]) => {
                  const environments = asRecord(value)?.environments;
                  return Array.isArray(environments) && environments.includes(environmentName);
                })
                .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            );
            const contract = canonicalize({
              version: spec.version,
              project: spec.project,
              gitRemoteUrl: spec.gitRemoteUrl || null,
              ...(spec.runtime ? { runtime: spec.runtime } : {}),
              environmentName,
              environment,
              secrets,
            });
            const desiredHash = createHash('sha256').update(JSON.stringify(contract), 'utf8').digest('hex');
            const appliedHash = (process.env.HYPERVIBE_APPLIED_SPEC_HASH || '').trim();
            const deploySha = (process.env.HYPERVIBE_DEPLOY_SHA || '').trim();
            core.info('Desired Hypervibe contract hash: ' + desiredHash);
            core.info('Applied Hypervibe contract hash: ' + (appliedHash || '(missing)'));
            if (!appliedHash || appliedHash !== desiredHash) {
              const annotationTitle = 'Deployment blocked — Hypervibe reconciliation required';
              const cause = !appliedHash
                ? 'applied hash missing'
                : 'desired and applied hashes differ';
              const failureMessage = !appliedHash
                ? 'Deployment blocked for ' + environmentName + ': applied contract hash is missing.'
                : 'Deployment blocked for ' + environmentName + ': desired and applied contract hashes differ.';

              core.error(failureMessage, { title: annotationTitle });
              await core.summary
                .addHeading('🚧 ' + annotationTitle, 2)
                .addRaw('**This is not an application build or test failure. No image was built and nothing was deployed.**')
                .addBreak()
                .addRaw(
                  'The desired ' + environmentName + ' infrastructure contract for commit \`'
                  + deploySha
                  + '\` does not match the last contract applied through Hypervibe.'
                )
                .addBreak()
                .addRaw('**Cause:** ' + cause)
                .addBreak()
                .addTable([
                  [{ data: 'Field', header: true }, { data: 'Value', header: true }],
                  ['Environment', environmentName],
                  ['Desired hash', desiredHash],
                  ['Applied hash', appliedHash || 'missing'],
                  ['Prevented commit', deploySha],
                ])
                .addHeading('Next', 3)
                .addList([
                  'Check out commit \`' + deploySha + '\`.',
                  'Run \`hv_status\` for \`' + environmentName + '\`.',
                  'Run \`hv_plan\` for \`' + environmentName + '\`.',
                  'Review and apply that exact plan with \`hv_apply\`.',
                  'Retrigger this workflow with \`hv_ci_trigger\`.',
                ], true)
                .write();
              core.setFailed(failureMessage);
            }
`;
}

function releaseTargetForWorkflow(
  provider: BranchDeployProvider,
  target: BranchDeployTarget
): BranchDeployReleaseTarget {
  if (target.releaseTarget) return target.releaseTarget;
  const providerIds = [
    ...target.providerServiceIds.map((providerResourceId) => ({
      providerResourceId,
      providerResourceType: 'service' as const,
      workloadKind: 'web' as const,
    })),
    ...(target.providerJobNames ?? []).map((providerResourceId) => ({
      providerResourceId,
      providerResourceType: 'job' as const,
      workloadKind: 'cron' as const,
    })),
  ];
  const resources = target.serviceNames.length === 1 && providerIds.length === 1
    ? [{ logicalName: target.serviceNames[0]!, ...providerIds[0]! }]
    : [];
  return managedCiReleaseTarget({
    provider,
    environmentName: target.environmentName,
    scope: managedCiProviderScope(target),
    resources,
  });
}

function indentWorkflowScript(script: string): string {
  return script
    .trim()
    .split('\n')
    .map((line) => `            ${line}`)
    .join('\n');
}

const RELEASE_EVIDENCE_VALIDATION_RUNTIME = `
const { createHash } = require('crypto');

function asEvidenceRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function exactEvidenceKeys(value, expected) {
  const record = asEvidenceRecord(value);
  return Boolean(record)
    && JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...expected].sort());
}

function canonicalizeEvidence(value) {
  if (Array.isArray(value)) return value.map(canonicalizeEvidence);
  const record = asEvidenceRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalizeEvidence(child)])
  );
}

function sameEvidence(left, right) {
  return JSON.stringify(canonicalizeEvidence(left)) === JSON.stringify(canonicalizeEvidence(right));
}

function normalizeEvidenceScope(value) {
  const scope = asEvidenceRecord(value);
  if (!scope || !exactEvidenceKeys(scope, ['providerProjectId', 'providerEnvironmentId', 'providerRegion', 'providerScope'].filter((key) => scope[key] !== undefined))) {
    throw new Error('Release target scope is malformed');
  }
  for (const key of ['providerProjectId', 'providerEnvironmentId', 'providerRegion']) {
    if (scope[key] !== undefined && (typeof scope[key] !== 'string' || !scope[key].trim())) {
      throw new Error('Release target scope field ' + key + ' is malformed');
    }
  }
  if (scope.providerScope !== undefined) {
    const nativeScope = asEvidenceRecord(scope.providerScope);
    if (!nativeScope || Object.keys(nativeScope).length === 0
        || Object.entries(nativeScope).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())) {
      throw new Error('Release target provider scope is malformed');
    }
  }
  return canonicalizeEvidence(scope);
}

function normalizeEvidenceResource(value, withImage) {
  const expectedKeys = ['logicalName', 'workloadKind', 'providerResourceType', 'providerResourceId'];
  if (withImage) expectedKeys.push('imageUri');
  if (!exactEvidenceKeys(value, expectedKeys)) {
    throw new Error('Release evidence resource is malformed');
  }
  const resource = asEvidenceRecord(value);
  if (typeof resource.logicalName !== 'string' || !resource.logicalName.trim()
      || !['web', 'worker', 'cron'].includes(resource.workloadKind)
      || !['service', 'job'].includes(resource.providerResourceType)
      || typeof resource.providerResourceId !== 'string' || !resource.providerResourceId.trim()
      || (resource.providerResourceType === 'job' && resource.workloadKind !== 'cron')) {
    throw new Error('Release evidence resource identity is malformed');
  }
  const normalized = {
    logicalName: resource.logicalName,
    workloadKind: resource.workloadKind,
    providerResourceType: resource.providerResourceType,
    providerResourceId: resource.providerResourceId,
  };
  if (!withImage) return normalized;
  const imageUri = resource.imageUri === null
    ? null
    : typeof resource.imageUri === 'string' ? resource.imageUri.trim().toLowerCase() : undefined;
  if (imageUri === undefined || (imageUri !== null && !/^[^\\s@]+@sha256:[0-9a-f]{64}$/.test(imageUri))) {
    throw new Error('Release evidence resource image is malformed');
  }
  return { ...normalized, imageUri };
}

function normalizeEvidenceResources(value, withImage) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Release evidence must contain at least one exact provider resource');
  }
  const resources = value.map((entry) => normalizeEvidenceResource(entry, withImage))
    .sort((left, right) => left.logicalName.localeCompare(right.logicalName)
      || left.providerResourceType.localeCompare(right.providerResourceType)
      || left.providerResourceId.localeCompare(right.providerResourceId));
  if (new Set(resources.map((entry) => entry.logicalName)).size !== resources.length
      || new Set(resources.map((entry) => entry.providerResourceType + ':' + entry.providerResourceId)).size !== resources.length) {
    throw new Error('Release evidence contains duplicate logical or provider resources');
  }
  return resources;
}

function expectedReleaseTarget(provider, environment, serviceNamesValue, scopeValue, resourcesValue, fingerprint) {
  let serviceNames;
  try {
    serviceNames = JSON.parse(serviceNamesValue);
  } catch {
    throw new Error('Reviewed release service set is invalid JSON');
  }
  if (!provider || !environment || !Array.isArray(serviceNames) || serviceNames.length === 0
      || serviceNames.some((name) => typeof name !== 'string' || !name.trim())
      || new Set(serviceNames).size !== serviceNames.length) {
    throw new Error('Reviewed release provider, environment, or service set is incomplete');
  }
  let scope;
  let resources;
  try {
    scope = normalizeEvidenceScope(JSON.parse(scopeValue));
    resources = normalizeEvidenceResources(JSON.parse(resourcesValue), false);
  } catch (error) {
    throw new Error('Reviewed release target is incomplete: ' + error.message);
  }
  const expectedNames = [...serviceNames].sort();
  const actualNames = resources.map((resource) => resource.logicalName).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    throw new Error('Reviewed release target does not cover the exact desired service set');
  }
  const calculated = createHash('sha256').update(JSON.stringify(canonicalizeEvidence({
    version: 1,
    provider,
    environment,
    scope,
    resources,
  })), 'utf8').digest('hex');
  if (!/^[0-9a-f]{64}$/.test(fingerprint) || calculated !== fingerprint) {
    throw new Error('Reviewed release bindings fingerprint is stale');
  }
  return { scope, resources, bindingsFingerprint: fingerprint };
}

function validateReleaseEvidence(evidence, expected) {
  const failure = () => {
    throw new Error(expected.label + ' release evidence does not match the exact reviewed provider, environment, repository, SHA, scope, bindings fingerprint, resources, program, and immutable image');
  };
  try {
    if (!exactEvidenceKeys(evidence, ['environment', 'programFingerprint', 'provider', 'source', 'target', 'verifiedAt', 'version'])
        || evidence.version !== 3
        || evidence.provider !== expected.provider
        || evidence.environment !== expected.environment
        || evidence.programFingerprint !== expected.programFingerprint
        || typeof evidence.verifiedAt !== 'string'
        || Number.isNaN(Date.parse(evidence.verifiedAt))
        || !exactEvidenceKeys(evidence.source, ['repository', 'sha'])
        || evidence.source.repository !== expected.repository
        || String(evidence.source.sha || '').toLowerCase() !== expected.sha
        || !exactEvidenceKeys(evidence.target, ['bindingsFingerprint', 'resources', 'scope'])
        || evidence.target.bindingsFingerprint !== expected.target.bindingsFingerprint
        || !sameEvidence(normalizeEvidenceScope(evidence.target.scope), expected.target.scope)) {
      failure();
    }
    const resources = normalizeEvidenceResources(evidence.target.resources, true);
    const identities = resources.map(({ imageUri: _imageUri, ...identity }) => identity);
    if (!sameEvidence(identities, expected.target.resources)) failure();
    const images = resources.map((resource) => resource.imageUri);
    if (expected.requireImmutableImage
        && (images.some((imageUri) => imageUri === null) || new Set(images).size !== 1)) {
      failure();
    }
    return { resources, imageUri: images[0] ?? null };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(expected.label + ' release evidence')) throw error;
    failure();
  }
}
`;

function buildReleaseTargetPreflight(
  provider: BranchDeployProvider,
  target: BranchDeployTarget
): string {
  const releaseTarget = releaseTargetForWorkflow(provider, target);
  const programFingerprint = target.programFingerprint
    ?? legacyBranchDeployProgramFingerprint(provider, target);
  return `      - name: Verify reviewed release target
        uses: actions/github-script@v9
        env:
          HYPERVIBE_RELEASE_PROVIDER: ${JSON.stringify(provider)}
          HYPERVIBE_RELEASE_ENVIRONMENT: ${JSON.stringify(target.environmentName)}
          HYPERVIBE_RELEASE_SERVICES: ${JSON.stringify(JSON.stringify(target.serviceNames))}
          HYPERVIBE_RELEASE_TARGET_SCOPE: ${JSON.stringify(JSON.stringify(releaseTarget.scope))}
          HYPERVIBE_RELEASE_RESOURCES: ${JSON.stringify(JSON.stringify(releaseTarget.resources))}
          HYPERVIBE_RELEASE_BINDINGS_FINGERPRINT: ${releaseTarget.bindingsFingerprint}
          HYPERVIBE_RELEASE_PROGRAM_FINGERPRINT: ${programFingerprint}
        with:
          script: |
${indentWorkflowScript(RELEASE_EVIDENCE_VALIDATION_RUNTIME)}
            expectedReleaseTarget(
              process.env.HYPERVIBE_RELEASE_PROVIDER,
              process.env.HYPERVIBE_RELEASE_ENVIRONMENT,
              process.env.HYPERVIBE_RELEASE_SERVICES,
              process.env.HYPERVIBE_RELEASE_TARGET_SCOPE,
              process.env.HYPERVIBE_RELEASE_RESOURCES,
              process.env.HYPERVIBE_RELEASE_BINDINGS_FINGERPRINT
            );
            if (!/^[0-9a-f]{64}$/.test(process.env.HYPERVIBE_RELEASE_PROGRAM_FINGERPRINT || '')) {
              throw new Error('Reviewed release program fingerprint is missing or malformed');
            }
`;
}

function buildImmutableRollbackEvidenceSteps(
  provider: BranchDeployProvider,
  target: BranchDeployTarget
): string {
  const releaseTarget = releaseTargetForWorkflow(provider, target);
  const programFingerprint = target.programFingerprint
    ?? legacyBranchDeployProgramFingerprint(provider, target);
  return `      - name: Download rollback release evidence
        if: steps.deploy.outputs.operation == 'rollback'
        uses: actions/download-artifact@v8
        with:
          artifact-ids: \${{ inputs.source_artifact_id }}
          run-id: \${{ inputs.source_workflow_run_id }}
          github-token: \${{ github.token }}
          path: \${{ runner.temp }}/hypervibe-rollback-evidence
          merge-multiple: true
      - name: Resolve immutable rollback image
        id: rollback_evidence
        if: steps.deploy.outputs.operation == 'rollback'
        uses: actions/github-script@v9
        env:
          HYPERVIBE_RELEASE_EVIDENCE_PATH: \${{ runner.temp }}/hypervibe-rollback-evidence/hypervibe-server-release.json
          HYPERVIBE_ROLLBACK_PROVIDER: ${JSON.stringify(provider)}
          HYPERVIBE_ROLLBACK_ENVIRONMENT: ${JSON.stringify(target.environmentName)}
          HYPERVIBE_ROLLBACK_SHA: \${{ steps.deploy.outputs.sha }}
          HYPERVIBE_ROLLBACK_SERVICES: ${JSON.stringify(JSON.stringify(target.serviceNames))}
          HYPERVIBE_ROLLBACK_TARGET_SCOPE: ${JSON.stringify(JSON.stringify(releaseTarget.scope))}
          HYPERVIBE_ROLLBACK_RESOURCES: ${JSON.stringify(JSON.stringify(releaseTarget.resources))}
          HYPERVIBE_ROLLBACK_BINDINGS_FINGERPRINT: ${releaseTarget.bindingsFingerprint}
          HYPERVIBE_ROLLBACK_PROGRAM_FINGERPRINT: ${programFingerprint}
        with:
          script: |
${indentWorkflowScript(RELEASE_EVIDENCE_VALIDATION_RUNTIME)}
            const { readFileSync } = require('fs');
            let evidence;
            try {
              evidence = JSON.parse(readFileSync(process.env.HYPERVIBE_RELEASE_EVIDENCE_PATH, 'utf8'));
            } catch {
              throw new Error('Rollback release evidence is missing or invalid JSON');
            }
            const expectedTarget = expectedReleaseTarget(
              process.env.HYPERVIBE_ROLLBACK_PROVIDER,
              process.env.HYPERVIBE_ROLLBACK_ENVIRONMENT,
              process.env.HYPERVIBE_ROLLBACK_SERVICES,
              process.env.HYPERVIBE_ROLLBACK_TARGET_SCOPE,
              process.env.HYPERVIBE_ROLLBACK_RESOURCES,
              process.env.HYPERVIBE_ROLLBACK_BINDINGS_FINGERPRINT
            );
            const validated = validateReleaseEvidence(evidence, {
              label: 'Rollback',
              provider: process.env.HYPERVIBE_ROLLBACK_PROVIDER,
              environment: process.env.HYPERVIBE_ROLLBACK_ENVIRONMENT,
              repository: process.env.GITHUB_REPOSITORY,
              sha: process.env.HYPERVIBE_ROLLBACK_SHA,
              target: expectedTarget,
              programFingerprint: process.env.HYPERVIBE_ROLLBACK_PROGRAM_FINGERPRINT,
              requireImmutableImage: true,
            });
            core.setOutput('image_uri', validated.imageUri);
            core.info('Resolved immutable rollback image ' + validated.imageUri);
`;
}

function branchDeployWorkflowPath(provider: string, environmentName: string): string {
  const safeEnvironment = environmentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `.github/workflows/deploy-${provider}-${safeEnvironment}.yml`;
}

function buildPromotionEvidenceStep(
  provider: BranchDeployProvider,
  target: BranchDeployTarget
): string {
  if (!target.promoteFromEnvironment) return '';
  const sourceEnvironment = target.promoteFromEnvironment;
  const sourceProvider = target.promoteFromProvider ?? provider;
  if (target.promoteFromServiceNames === undefined) {
    throw new Error(`Promotion target ${target.environmentName} has no reviewed source service set`);
  }
  if (!/^[0-9a-f]{64}$/.test(target.promoteFromProgramFingerprint ?? '')) {
    throw new Error(`Promotion target ${target.environmentName} has no reviewed source program fingerprint`);
  }
  if (!target.promoteFromReleaseTarget) {
    throw new Error(`Promotion target ${target.environmentName} has no reviewed source release target`);
  }
  const sourceReleaseTarget = target.promoteFromReleaseTarget;
  const sourceWorkflowPath = branchDeployWorkflowPath(sourceProvider, sourceEnvironment);
  const safeSourceEnvironment = sourceEnvironment.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `      - name: Verify promotion release evidence
        id: promotion_evidence
        if: steps.deploy.outputs.operation != 'rollback'
        uses: actions/github-script@v9
        env:
          HYPERVIBE_PROMOTE_FROM_ENVIRONMENT: ${JSON.stringify(sourceEnvironment)}
          HYPERVIBE_PROMOTE_FROM_WORKFLOW: ${JSON.stringify(sourceWorkflowPath)}
          HYPERVIBE_PROMOTION_SHA: \${{ steps.deploy.outputs.sha }}
        with:
          script: |
            const sourceEnvironment = process.env.HYPERVIBE_PROMOTE_FROM_ENVIRONMENT;
            const sourceWorkflow = process.env.HYPERVIBE_PROMOTE_FROM_WORKFLOW;
            const targetSha = (process.env.HYPERVIBE_PROMOTION_SHA || '').toLowerCase();
            if (!/^[0-9a-f]{40}$/.test(targetSha)) {
              throw new Error('Promotion requires a full 40-character Git commit SHA');
            }
            const expectedArtifactName = 'hypervibe-server-release-${safeSourceEnvironment}-' + targetSha;
            const response = await github.rest.actions.listWorkflowRuns({
              owner: context.repo.owner,
              repo: context.repo.repo,
              workflow_id: sourceWorkflow,
              head_sha: targetSha,
              status: 'success',
              per_page: 20,
            });
            const runs = Array.isArray(response.data.workflow_runs) ? response.data.workflow_runs : [];
            const candidates = runs.filter((run) => (
              Number.isSafeInteger(run.id)
              && run.id > 0
              && String(run.head_sha || '').toLowerCase() === targetSha
              && run.conclusion === 'success'
              && run.path === sourceWorkflow
            ));
            if (candidates.length === 0) {
              throw new Error(
                'No successful ' + sourceEnvironment + ' deployment of ' + targetSha
                + ' was found in ' + sourceWorkflow
              );
            }
            let verified;
            for (const run of candidates) {
              const artifactResponse = await github.rest.actions.listWorkflowRunArtifacts({
                owner: context.repo.owner,
                repo: context.repo.repo,
                run_id: run.id,
                per_page: 100,
              });
              const artifacts = Array.isArray(artifactResponse.data.artifacts)
                ? artifactResponse.data.artifacts
                : [];
              const artifact = artifacts.find((candidate) => (
                Number.isSafeInteger(candidate.id)
                && candidate.id > 0
                && candidate.name === expectedArtifactName
                && candidate.expired === false
                && candidate.workflow_run?.id === run.id
                && String(candidate.workflow_run?.head_sha || '').toLowerCase() === targetSha
              ));
              if (artifact) {
                verified = { run, artifact };
                break;
              }
            }
            if (!verified) {
              throw new Error(
                'No unexpired Hypervibe ' + sourceEnvironment + ' release artifact for '
                + targetSha + ' was found in ' + sourceWorkflow
              );
            }
            core.info(
              'Verified ' + sourceEnvironment + ' release evidence for ' + targetSha
              + ' from ' + sourceWorkflow + ' run ' + verified.run.id
              + ' artifact ' + verified.artifact.id
            );
            core.setOutput('artifact_id', String(verified.artifact.id));
            core.setOutput('run_id', String(verified.run.id));
      - name: Download promotion release evidence
        if: steps.deploy.outputs.operation != 'rollback'
        uses: actions/download-artifact@v8
        with:
          artifact-ids: \${{ steps.promotion_evidence.outputs.artifact_id }}
          run-id: \${{ steps.promotion_evidence.outputs.run_id }}
          github-token: \${{ github.token }}
          path: \${{ runner.temp }}/hypervibe-promotion-evidence
          merge-multiple: true
      - name: Validate promotion release evidence
        id: promotion_release
        if: steps.deploy.outputs.operation != 'rollback'
        uses: actions/github-script@v9
        env:
          HYPERVIBE_RELEASE_EVIDENCE_PATH: \${{ runner.temp }}/hypervibe-promotion-evidence/hypervibe-server-release.json
          HYPERVIBE_PROMOTE_FROM_ENVIRONMENT: ${JSON.stringify(sourceEnvironment)}
          HYPERVIBE_PROMOTE_FROM_PROVIDER: ${JSON.stringify(sourceProvider)}
          HYPERVIBE_PROMOTION_SHA: \${{ steps.deploy.outputs.sha }}
          HYPERVIBE_PROMOTION_SERVICES: ${JSON.stringify(JSON.stringify(target.promoteFromServiceNames))}
          HYPERVIBE_PROMOTION_PROGRAM_FINGERPRINT: ${target.promoteFromProgramFingerprint}
          HYPERVIBE_PROMOTION_TARGET_SCOPE: ${JSON.stringify(JSON.stringify(sourceReleaseTarget.scope))}
          HYPERVIBE_PROMOTION_RESOURCES: ${JSON.stringify(JSON.stringify(sourceReleaseTarget.resources))}
          HYPERVIBE_PROMOTION_BINDINGS_FINGERPRINT: ${sourceReleaseTarget.bindingsFingerprint}
        with:
          script: |
${indentWorkflowScript(RELEASE_EVIDENCE_VALIDATION_RUNTIME)}
            const { readFileSync } = require('fs');
            let evidence;
            try {
              evidence = JSON.parse(readFileSync(process.env.HYPERVIBE_RELEASE_EVIDENCE_PATH, 'utf8'));
            } catch {
              throw new Error('Promotion release evidence is missing or invalid JSON');
            }
            const expectedTarget = expectedReleaseTarget(
              process.env.HYPERVIBE_PROMOTE_FROM_PROVIDER,
              process.env.HYPERVIBE_PROMOTE_FROM_ENVIRONMENT,
              process.env.HYPERVIBE_PROMOTION_SERVICES,
              process.env.HYPERVIBE_PROMOTION_TARGET_SCOPE,
              process.env.HYPERVIBE_PROMOTION_RESOURCES,
              process.env.HYPERVIBE_PROMOTION_BINDINGS_FINGERPRINT
            );
            const validated = validateReleaseEvidence(evidence, {
              label: 'Promotion',
              provider: process.env.HYPERVIBE_PROMOTE_FROM_PROVIDER,
              environment: process.env.HYPERVIBE_PROMOTE_FROM_ENVIRONMENT,
              repository: process.env.GITHUB_REPOSITORY,
              sha: process.env.HYPERVIBE_PROMOTION_SHA,
              target: expectedTarget,
              programFingerprint: process.env.HYPERVIBE_PROMOTION_PROGRAM_FINGERPRINT,
              requireImmutableImage: true,
            });
            core.setOutput('image_uri', validated.imageUri);
            core.info(
              'Validated ' + process.env.HYPERVIBE_PROMOTE_FROM_ENVIRONMENT
              + ' release evidence content for ' + process.env.HYPERVIBE_PROMOTION_SHA
            );
`;
}

function buildServerReleaseEvidenceStep(
  provider: BranchDeployProvider,
  target: BranchDeployTarget,
  releaseImageUri?: string
): string {
  const programFingerprint = target.programFingerprint
    ?? legacyBranchDeployProgramFingerprint(provider, target);
  const releaseTarget = releaseTargetForWorkflow(provider, target);
  return `      - name: Write server release evidence
        uses: actions/github-script@v9
        env:
          HYPERVIBE_RELEASE_SHA: \${{ steps.deploy.outputs.sha }}
          HYPERVIBE_RELEASE_PROVIDER: ${JSON.stringify(provider)}
          HYPERVIBE_RELEASE_ENVIRONMENT: ${JSON.stringify(target.environmentName)}
          HYPERVIBE_RELEASE_SERVICES: ${JSON.stringify(JSON.stringify(target.serviceNames))}
          HYPERVIBE_RELEASE_TARGET_SCOPE: ${JSON.stringify(JSON.stringify(releaseTarget.scope))}
          HYPERVIBE_RELEASE_RESOURCES: ${JSON.stringify(JSON.stringify(releaseTarget.resources))}
          HYPERVIBE_RELEASE_BINDINGS_FINGERPRINT: ${releaseTarget.bindingsFingerprint}
          HYPERVIBE_RELEASE_PROGRAM_FINGERPRINT: ${programFingerprint}
          HYPERVIBE_RELEASE_REQUIRES_IMMUTABLE_IMAGE: ${releaseImageUri ? 'true' : 'false'}
          HYPERVIBE_RELEASE_IMAGE_URI: ${releaseImageUri ?? "''"}
        with:
          script: |
${indentWorkflowScript(RELEASE_EVIDENCE_VALIDATION_RUNTIME)}
            const { writeFileSync } = require('fs');
            const sha = String(process.env.HYPERVIBE_RELEASE_SHA || '').trim().toLowerCase();
            const repository = String(process.env.GITHUB_REPOSITORY || '').trim();
            if (!/^[0-9a-f]{40}$/.test(sha) || !/^[^\\s/]+\\/[^\\s/]+$/.test(repository)) {
              throw new Error('Release evidence source repository or SHA is missing or malformed');
            }
            const expectedTarget = expectedReleaseTarget(
              process.env.HYPERVIBE_RELEASE_PROVIDER,
              process.env.HYPERVIBE_RELEASE_ENVIRONMENT,
              process.env.HYPERVIBE_RELEASE_SERVICES,
              process.env.HYPERVIBE_RELEASE_TARGET_SCOPE,
              process.env.HYPERVIBE_RELEASE_RESOURCES,
              process.env.HYPERVIBE_RELEASE_BINDINGS_FINGERPRINT
            );
            const imageUri = String(process.env.HYPERVIBE_RELEASE_IMAGE_URI || '').trim().toLowerCase();
            const requiresImmutableImage = process.env.HYPERVIBE_RELEASE_REQUIRES_IMMUTABLE_IMAGE === 'true';
            if ((imageUri && !/^[^\\s@]+@sha256:[0-9a-f]{64}$/.test(imageUri))
                || (requiresImmutableImage && !imageUri)) {
              throw new Error('Verified deployment did not produce an immutable image digest');
            }
            writeFileSync('hypervibe-server-release.json', JSON.stringify({
              version: 3,
              provider: process.env.HYPERVIBE_RELEASE_PROVIDER,
              environment: process.env.HYPERVIBE_RELEASE_ENVIRONMENT,
              source: {
                repository,
                sha,
              },
              target: {
                scope: expectedTarget.scope,
                bindingsFingerprint: expectedTarget.bindingsFingerprint,
                resources: expectedTarget.resources.map((resource) => ({
                  ...resource,
                  imageUri: imageUri || null,
                })),
              },
              programFingerprint: process.env.HYPERVIBE_RELEASE_PROGRAM_FINGERPRINT,
              verifiedAt: new Date().toISOString(),
            }, null, 2) + '\\n');
`;
}

function buildDeploymentFailureEvidenceJob(environmentName: string): string {
  return `
  failure_evidence:
    needs: deploy
    if: \${{ always() && needs.deploy.result == 'failure' }}
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
    steps:
      - name: Capture sanitized deployment failure evidence
        uses: actions/github-script@v9
        env:
          HYPERVIBE_RUN_ID: \${{ github.run_id }}
        with:
          script: |
            const { writeFileSync } = require('fs');
            const runId = Number(process.env.HYPERVIBE_RUN_ID);
            if (!Number.isSafeInteger(runId) || runId <= 0) {
              throw new Error('GITHUB_RUN_ID must be a positive integer.');
            }

            const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
              owner: context.repo.owner,
              repo: context.repo.repo,
              run_id: runId,
              filter: 'latest',
              per_page: 100,
            });
            const deployJob = jobs.find((job) => job.name === 'deploy' && job.conclusion === 'failure');
            if (!deployJob) {
              throw new Error('Could not find the failed deploy job for workflow run ' + runId + '.');
            }

            const response = await github.request(
              'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
              { owner: context.repo.owner, repo: context.repo.repo, job_id: deployJob.id }
            );
            const raw = typeof response.data === 'string'
              ? response.data
              : Buffer.from(response.data).toString('utf8');
            const redacted = raw
              .replace(/([a-z][a-z0-9+.-]*:\\/\\/)[^\\s\\/:@]+:[^\\s@\\/]+@/gi, '$1***:***@')
              .replace(/([?&](?:token|password|secret|credential|api_key)=)[^&\\s]+/gi, '$1***')
              .split(/\\r?\\n/)
              .slice(-400)
              .map((line) => line
                .replace(/(Authorization:\\s*(?:Bearer|Basic)\\s+)\\S+/gi, '$1***')
                .replace(/\\b([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)\\s*([=:]\\s*)(?:"[^"]*"|'[^']*'|\\S+)/gi, '$1$2***')
                .replace(/\\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\\b/g, '***'))
              .join('\\n')
              .slice(-65536);

            writeFileSync(
              'hypervibe-deploy-failure.log',
              (redacted || 'Deploy job failed without readable log output.') + '\\n',
              { encoding: 'utf8', mode: 0o600 }
            );
            core.info('Captured sanitized evidence from failed deploy job ' + deployJob.id + '.');
      - name: Upload deployment failure evidence
        uses: actions/upload-artifact@v7
        with:
          name: deploy-${environmentName}-failure-evidence
          path: hypervibe-deploy-failure.log
          if-no-files-found: error
          retention-days: 14
`;
}

export function buildBranchDeployWorkflow(
  provider: BranchDeployProvider,
  target: BranchDeployTarget,
  migration: { includeStep: boolean; command?: string },
  ios?: IosSpec
): BranchDeployWorkflow {
  const safeEnvironment = target.environmentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const template = `deploy-${provider}-${safeEnvironment}`;
  if (migration.includeStep && migration.command && !target.runtime) {
    throw new Error(
      `Managed migration tooling for ${target.environmentName} requires an explicit project runtime. `
      + 'Run hv_spec to review repository runtime evidence and persist the intended version.'
    );
  }
  const migrationStep = migration.includeStep && migration.command && target.runtime
    ? buildMigrationStep(migration.command, target.runtime)
    : '';
  const deployBlock = buildProviderDeploySteps(provider, target);
  const immutableRollback = Boolean(deployBlock.releaseImageUri);
  if (target.promoteFromEnvironment && !immutableRollback) {
    throw new Error(
      `Promotion to ${target.environmentName} is unavailable because provider "${provider}" `
      + 'does not expose a verifiable immutable artifact.'
    );
  }
  const sourcePreparationCondition = immutableRollback
    ? "steps.deploy.outputs.operation != 'rollback'"
    : undefined;
  const rollbackEvidenceSteps = immutableRollback
    ? buildImmutableRollbackEvidenceSteps(provider, target)
    : '';
  const promotionEvidenceStep = buildPromotionEvidenceStep(provider, target);
  const releaseEvidenceStep = buildServerReleaseEvidenceStep(provider, target, deployBlock.releaseImageUri);
  const providerName = deployBlock.displayName ?? providerRegistry.getMetadata(provider)?.displayName ?? provider;
  let requiredSecrets = migrationStep
    ? [...deployBlock.requiredSecrets, 'DATABASE_URL']
    : [...deployBlock.requiredSecrets];
  const requiredVariables = [...deployBlock.requiredVariables];
  const permissionsBlock = deployBlock.permissions ?? `    permissions:
      actions: read
      contents: read
`;

  const content = `name: Deploy ${providerName} (${target.environmentName})

run-name: Deploy ${target.environmentName} \${{ inputs.commit_sha || github.sha }} \${{ inputs.rollback && '(rollback)' || '' }}

on:
${buildWorkflowTrigger(target)}

concurrency:
  group: hypervibe-deploy-${target.environmentName}
  cancel-in-progress: false

jobs:
  deploy:
${target.autoDeployOnPush
  ? "    if: github.event_name != 'push' || vars.HYPERVIBE_APPLIED_SPEC_HASH != ''\n"
  : ''}    runs-on: ubuntu-latest
    environment: ${target.environmentName}
${permissionsBlock.trimEnd()}
    steps:
      - name: Resolve deploy SHA
        id: deploy
        uses: actions/github-script@v9
        with:
          script: |
            const inputSha = ((context.payload.inputs || {}).commit_sha || '').trim();
            const sha = (inputSha || process.env.GITHUB_SHA).toLowerCase();
            if (!/^[0-9a-f]{40}$/i.test(sha)) {
              throw new Error('commit_sha must be a full 40-character Git commit SHA, got: ' + JSON.stringify(inputSha || sha));
            }
            const rollbackInput = (context.payload.inputs || {}).rollback;
            const operation = rollbackInput === true || rollbackInput === 'true' ? 'rollback' : 'deploy';
            if (operation === 'rollback' && ${immutableRollback ? 'false' : 'true'}) {
              throw new Error('Rollback is unavailable because this provider workflow does not expose a verifiable immutable artifact');
            }
            core.setOutput('sha', sha);
            core.setOutput('operation', operation);
            core.info((operation === 'rollback' ? 'Restoring' : 'Deploying') + ' commit ' + sha);
      - name: Verify rollback release evidence
        if: steps.deploy.outputs.operation == 'rollback'
        uses: actions/github-script@v9
        env:
          HYPERVIBE_ENVIRONMENT: ${JSON.stringify(target.environmentName)}
          HYPERVIBE_ROLLBACK_SHA: \${{ steps.deploy.outputs.sha }}
          HYPERVIBE_WORKFLOW_REF: \${{ github.workflow_ref }}
          HYPERVIBE_EXPECTED_LATEST_RUN_ID: \${{ inputs.expected_latest_run_id }}
          HYPERVIBE_SOURCE_ARTIFACT_ID: \${{ inputs.source_artifact_id }}
          HYPERVIBE_SOURCE_WORKFLOW_RUN_ID: \${{ inputs.source_workflow_run_id }}
        with:
          script: |
            const environment = process.env.HYPERVIBE_ENVIRONMENT;
            const targetSha = process.env.HYPERVIBE_ROLLBACK_SHA.toLowerCase();
            const safeEnvironment = environment.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
            const expectedName = 'hypervibe-server-release-' + safeEnvironment + '-' + targetSha;
            const expectedLatestRunId = Number(process.env.HYPERVIBE_EXPECTED_LATEST_RUN_ID);
            if (!Number.isSafeInteger(expectedLatestRunId) || expectedLatestRunId <= 0) {
              throw new Error('Rollback requires Hypervibe expected_latest_run_id evidence');
            }
            const sourceArtifactId = Number(process.env.HYPERVIBE_SOURCE_ARTIFACT_ID);
            const sourceWorkflowRunId = Number(process.env.HYPERVIBE_SOURCE_WORKFLOW_RUN_ID);
            if (!Number.isSafeInteger(sourceArtifactId) || sourceArtifactId <= 0
                || !Number.isSafeInteger(sourceWorkflowRunId) || sourceWorkflowRunId <= 0) {
              throw new Error('Rollback requires exact Hypervibe source artifact and workflow run evidence');
            }
            const workflowPath = process.env.HYPERVIBE_WORKFLOW_REF.split('@')[0].split('/').slice(2).join('/');
            const recentRuns = await github.rest.actions.listWorkflowRuns({
              owner: context.repo.owner,
              repo: context.repo.repo,
              workflow_id: workflowPath,
              per_page: 10,
            });
            const latestPriorRun = recentRuns.data.workflow_runs.find((run) => run.id !== context.runId);
            if (!latestPriorRun || latestPriorRun.id !== expectedLatestRunId) {
              throw new Error(
                'Rollback dispatch is stale: expected latest run ' + expectedLatestRunId
                + ', observed ' + (latestPriorRun ? latestPriorRun.id : 'none')
              );
            }
            const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
              owner: context.repo.owner,
              repo: context.repo.repo,
              run_id: sourceWorkflowRunId,
              per_page: 100,
            });
            const artifact = artifacts.find((candidate) => candidate.id === sourceArtifactId);
            if (!artifact || artifact.name !== expectedName || artifact.expired
                || artifact.workflow_run?.id !== sourceWorkflowRunId) {
              throw new Error('Exact Hypervibe rollback artifact evidence is missing, expired, or does not match SHA ' + targetSha);
            }
            const run = await github.rest.actions.getWorkflowRun({
              owner: context.repo.owner,
              repo: context.repo.repo,
              run_id: sourceWorkflowRunId,
            });
            if (run.data.conclusion !== 'success' || run.data.path !== workflowPath) {
              throw new Error('Rollback evidence for ' + targetSha + ' did not come from a successful run of ' + workflowPath);
            }
            core.info('Verified rollback evidence from successful workflow run ' + run.data.id);
${buildReleaseTargetPreflight(provider, target)}${rollbackEvidenceSteps}${promotionEvidenceStep}      - uses: actions/checkout@v7
${sourcePreparationCondition ? `        if: ${sourcePreparationCondition}\n` : ''}        with:
          ref: \${{ steps.deploy.outputs.sha }}
          persist-credentials: false
${buildDeploymentContractStep(target.environmentName, sourcePreparationCondition)}${migrationStep}${deployBlock.steps}${releaseEvidenceStep}      - name: Upload server release evidence
        uses: actions/upload-artifact@v7
        with:
          name: hypervibe-server-release-${safeEnvironment}-\${{ steps.deploy.outputs.sha }}
          path: hypervibe-server-release.json
          if-no-files-found: error
          retention-days: 90
${buildDeploymentFailureEvidenceJob(target.environmentName)}`;

  const iosRelease = ios
    ? buildIosReleaseWorkflow({
      providerName,
      target,
      ios,
    })
    : null;
  if (iosRelease) requiredSecrets = [...requiredSecrets, ...iosRelease.requiredSecrets];
  const readableServiceNames = target.serviceNames.length <= 1
    ? target.serviceNames.join('')
    : `${target.serviceNames.slice(0, -1).join(', ')} and ${target.serviceNames.at(-1)}`;
  const serviceLabel = target.serviceNames.length === 0
    ? 'the configured services'
    : target.serviceNames.length === 1
      ? `the ${target.serviceNames[0]} service`
      : `the ${readableServiceNames} services`;
  const reviewDetails = [
    'Requires a full 40-character commit ID so the deployment always points to one exact version of the code.',
    `Builds and deploys ${serviceLabel}, then waits for ${providerName} to confirm the result.`,
    ...(migrationStep ? ['Runs the declared database migration before deploying the services.'] : []),
    ...(target.promoteFromEnvironment
      ? [`Requires an unexpired successful ${target.promoteFromEnvironment} release for the exact commit before building.`]
      : []),
    ...(deployBlock.reviewDetails ?? []),
    deployBlock.releaseImageUri
      ? 'Saves a versioned release record with the exact provider scope, resource bindings, deployed image digest, environment, commit, and program so promotion and rollback never rebuild it.'
      : 'Saves a versioned release record with the exact provider scope and resource bindings. Promotion and rollback remain unavailable until the provider exposes a verifiable immutable artifact.',
    'Uploads safe failure details when the deployment does not complete.',
  ];
  return {
    template,
    templateName: `Deploy ${providerName} (${target.environmentName})`,
    branch: target.branch,
    autoDeployOnPush: target.autoDeployOnPush,
    ...(target.promoteFromEnvironment ? { promoteFromEnvironment: target.promoteFromEnvironment } : {}),
    supportsImmutableRollback: immutableRollback,
    environment: target.environmentName,
    path: branchDeployWorkflowPath(provider, target.environmentName),
    content,
    ...(iosRelease ? { companionFiles: iosRelease.files } : {}),
    review: {
      title: `${target.environmentName} deployment`,
      summary: `Updates the GitHub workflow that deploys ${serviceLabel} to ${providerName}.`,
      details: reviewDetails,
      mergeEffect: target.autoDeployOnPush
        ? `Merging this PR may start a ${target.environmentName} deployment because pushes to ${target.branch} deploy automatically.`
        : `Merging this PR does not deploy ${target.environmentName} by itself; that deployment still has to be started manually.`,
    },
    requiredSecrets: Array.from(new Set(requiredSecrets)),
    requiredVariables: Array.from(new Set(requiredVariables)),
  };
}

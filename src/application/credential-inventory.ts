import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { CommandContext } from './context.js';
import { HvError } from './results.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { RunReceipt } from '../domain/entities/run.entity.js';
import { PlanService } from '../domain/plan/plan.service.js';
import { hashEnvValue, type ObservedState } from '../domain/ports/observe.port.js';
import { parseHostingBindings } from '../domain/ports/hosting.port.js';
import { parseSecretRef } from '../domain/ports/secretmanager.port.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { secretManagerRegistry } from '../domain/registry/secretmanager.registry.js';
import { parseDelegatedSecretBindings } from '../domain/services/delegated-secret.service.js';
import { withReceiptValidatedManagedSecretBindings } from '../domain/services/managed-secret-binding-receipts.js';
import { parseRuntimeRolloutBindings, runtimeRolloutRequirements } from '../domain/services/runtime-rollout.service.js';
import { parseGitHubDelegatedBindings } from '../domain/services/github-infrastructure.service.js';
import { getGitHubAdapter } from '../domain/services/github-ops.service.js';
import { managedCiCredentialSources } from '../domain/services/ci-deploy.service.js';
import { isProviderOnlyDeployEnvKey, loadDeployEnvFile } from '../domain/services/deploy-env-file.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { githubActionsCanonicalEnvironment, resolveDevOpsSelection } from '../domain/spec/devops-selection.js';
import { findRepoRoot, repositoryMatchesProjectIdentity } from '../domain/spec/repo-spec-file.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { parseEnvFile } from '../utils/env-parser.js';
import { redactExactValues } from '../utils/redact-exact-values.js';
import { credentialManagement } from '../domain/registry/credential-validation.registry.js';
import { credentialRuntimeServices } from '../domain/services/credential-runtime-consumers.js';
import { importedCredentialProvenance } from './cloud-secret-import.js';
import { credentialOperationEvidence, type CredentialOperationResult } from './credential-operation-verification.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';

type Presence = 'present' | 'absent' | 'unknown';
type Comparison = 'match' | 'different' | 'unknown';
interface Consumer {
  kind: 'hosting' | 'github-actions' | 'container-pull' | 'provider-api' | 'database';
  provider: string;
  name: string;
  service?: string;
  serviceId?: string;
  providerProjectId?: string;
  providerEnvironmentId?: string;
  environment?: string;
  repository?: string;
  scope?: string;
  nativeIdentity?: { componentId: string; externalId: string; username: string; database: string; providerScope: Record<string, unknown> };
  configuration: {
    presence: Presence;
    comparison: Comparison;
    basis: string;
    recordedSyncAt?: string;
    scopeState?: Presence;
    destinationCreatedAt?: string;
    destinationUpdatedAt?: string;
    recordedValueComparison?: Comparison;
  };
  activation: {
    state: 'unknown' | 'pending' | 'replacement-deployed' | 'not-applicable';
    deploymentId?: string;
    activeDeploymentIds?: string[];
    baselineDeploymentId?: string;
    requiredSince?: string;
    lastConfirmedAt: string | null;
    allInstances: 'unknown' | 'confirmed';
    coverage?: 'traffic' | 'instances';
    reason: string;
  };
}
interface Credential {
  id: string;
  label: string;
  purpose: string;
  ownership: 'provider-connection' | 'user-supplied-runtime-key' | 'generated-secret' | 'provider-reference' | 'untracked-input';
  aliases: string[];
  source: Record<string, unknown>;
  localCandidates: Array<{ path: string; key: string; present: boolean; comparisonToAccepted: Comparison; selectedForDeploy: boolean }>;
  consumers: Consumer[];
  validation: { at: string | null; result: string; tested: string; lastSuccessfulAt?: string | null; subject?: 'accepted-plan-input' | 'candidate-plan-input';
    connectionEvidence?: { at: string | null; result: string } };
  rotation: { providerCreatedAt: null; userReportedCreatedAt?: string | null; userReportedRotatedAt: string | null; acceptedUpdateAt: string | null;
    lastRotatedAt: null; expiresAt: null; evidence: 'unknown' | 'user-reported' };
  identity: { state: 'unknown' | 'validated'; reason: string; intended?: Record<string, unknown> };
  management?: { managementUrl: string; creationUrl: string };
  lifecycle?: { state: string; planId?: string; revocation: 'pending' };
  applicationOperation: { state: 'unknown'; reason: string } | CredentialOperationResult;
  updates: Array<{ runId: string; actionId: string; at: string; outcome: RunReceipt['status']; writeOutcome: 'recorded-success' | 'unknown' }>;
  nextAction: string;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined;
const compare = (actual?: string, expected?: string): Comparison => actual && expected ? actual === expected ? 'match' : 'different' : 'unknown';
const unknownActivation = (reason = 'Configuration does not prove which credential running instances use.'): Consumer['activation'] => ({
  state: 'unknown', allInstances: 'unknown', lastConfirmedAt: null, reason,
});
function credential(id: string, label: string, purpose: string, ownership: Credential['ownership'], source: Credential['source']): Credential {
  return { id, label, purpose, ownership, source, aliases: [], localCandidates: [], consumers: [], updates: [],
    validation: { at: null, result: 'unknown', tested: 'No credential-specific validation evidence recorded.' },
    rotation: { providerCreatedAt: null, userReportedRotatedAt: null, acceptedUpdateAt: null,
      lastRotatedAt: null, expiresAt: null, evidence: 'unknown' },
    identity: { state: 'unknown', reason: 'Intended account/sandbox and credential identity have not been compared.' },
    applicationOperation: { state: 'unknown', reason: 'Neither authentication nor a homepage response proves the application operation.' },
    nextAction: 'Review the declared source and consumers before planning a credential update.' };
}

/** A projection of existing desired state, local evidence and provider reads.
 * No adoption, source resolution, credential validation, plan, or persistence. */
export async function credentialInventory(ctx: CommandContext, project: Project, env: string) {
  const stored = new SpecStore().getForInspection(project);
  if (!stored) throw new HvError('NOT_FOUND', 'No recorded desired state is available for inventory. Review hv_spec first.');
  const spec = stored.spec;
  const desired = spec.environments[env];
  if (!desired && env !== githubActionsCanonicalEnvironment(spec)) throw new HvError('NOT_FOUND', 'The selected environment is not declared in the recorded spec.');
  const environment = ctx.repos.environments.findByProjectAndName(project.id, env);
  const provider = desired?.hosting.provider ?? 'unknown';
  const bindings = parseHostingBindings(environment);
  let observed: ObservedState | null = null;
  // No name-based discovery. A provider switch leaves the old identity unknown.
  if (desired && environment && bindings.provider === provider && (bindings.projectId || Object.keys(bindings.services ?? {}).length)) {
    try { observed = (await new PlanService().observeEnvironment(project, environment, desired, { hostingOnly: true })).observed; }
    catch { /* Never forward provider errors, which can echo credentials. */ }
  }
  const identityMatches = observed?.provider === provider
    && (!bindings.projectId || observed.projectId === bindings.projectId)
    && (!bindings.environmentId || observed.environmentId === bindings.environmentId);
  const absentEnvironment = Boolean(observed && observed.provider === provider && (!observed.projectId || observed.projectId === bindings.projectId)
    && !observed.partial && observed.completeness?.project === 'complete'
    && !observed.projectExists) || Boolean(observed && observed.provider === provider && !observed.partial
    && observed.projectId === bindings.projectId && observed.completeness?.environment === 'complete'
    && providerRegistry.getMetadata(provider)?.orchestration?.environment?.separateResource && !observed.environmentId);
  const environmentState: Presence = absentEnvironment ? 'absent' : identityMatches && observed?.completeness?.environment === 'complete' ? 'present' : 'unknown';
  const servicesKnown = identityMatches && (observed?.completeness?.serviceIdentities === 'complete' || !observed?.partial && observed?.completeness?.services === 'complete');
  const accepted = parseDelegatedSecretBindings(withReceiptValidatedManagedSecretBindings(environment, ctx.repos.runs));
  const recentRuns = environment ? ctx.repos.runs.findByEnvironmentId(environment.id, 100).filter(run => run.type === 'apply') : [];
  const rollouts = parseRuntimeRolloutBindings(environment);
  const pending = runtimeRolloutRequirements({ environment, provider, observed: identityMatches ? observed : null });
  const exactValues: string[] = [];
  const gaps = new Set<string>([
    'Historical file/reference provenance, credential creation, rotation and expiry are unknown unless recorded by the owning lifecycle.',
    'Deployment identity does not prove credential use by every serving instance; application operations remain unverified.',
    'Only declared mappings group aliases. Matching names or values never establish shared ownership.',
    'Update history projects action receipts from the latest 100 local runs; failed or pending actions do not prove whether a provider write occurred.',
  ]);
  const entries: Credential[] = [];

  // Read both candidate files without invoking the scaffolder or its chmod path.
  const root = stored.source?.kind === 'repo' ? path.dirname(path.dirname(stored.source.path)) : findRepoRoot();
  const local: Array<{ path: string; values: Record<string, string>; selected: Set<string> }> = [];
  const matchingRoot = root && (stored.source?.kind === 'repo' || repositoryMatchesProjectIdentity(root, project.name, project.gitRemoteUrl ?? undefined));
  if (matchingRoot && /^[A-Za-z0-9_-]+$/.test(env)) {
    for (const name of ['.env', `.env.${env}`]) {
      const file = path.join(root!, name);
      try {
        const info = lstatSync(file);
        if (!info.isFile() || info.size > 1024 * 1024) { gaps.add('A local dotenv candidate is not a bounded regular file; it was not read.'); continue; }
        const values = parseEnvFile(file); exactValues.push(...Object.values(values));
        const selected = loadDeployEnvFile({ envFile: file, syncEnvSpecific: false,
          mode: desired ? desired.envFile?.mode : 'off', includeKeys: desired?.envFile?.include, excludeKeys: desired?.envFile?.exclude });
        local.push({ path: file, values, selected: new Set(Object.keys(selected?.vars ?? {})) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') gaps.add('A local dotenv candidate could not be read; local evidence is incomplete.');
      }
    }
  } else gaps.add('No matching repository checkout was available for local dotenv inspection.');
  const selectedFile = local.at(-1);
  function candidates(entry: Credential, key: string, acceptedHash?: string) {
    for (const file of local) if (Object.hasOwn(file.values, key)) entry.localCandidates.push({
      path: file.path, key, present: file.values[key].trim().length > 0,
      comparisonToAccepted: compare(file.values[key] ? hashEnvValue(file.values[key]) : undefined, acceptedHash),
      selectedForDeploy: entry.ownership === 'untracked-input' && file === selectedFile && file.selected.has(key),
    });
  }
  function hosting(name: string, expectedHash?: string, selected?: string[], serviceHashes?: Record<string, unknown>): Consumer[] {
    const retainedConsumers = servicesKnown ? Object.entries(bindings.services ?? {}).filter(([, binding]) =>
      observed!.services.some(service => service.externalId === (binding.serviceId ?? binding.jobName) && service.envVarKeys.includes(name))).map(([name]) => name) : [];
    return (selected ?? [...new Set([...Object.keys(desired?.services ?? {}), ...retainedConsumers])]).sort().map(service => {
      const acceptedHash = string(serviceHashes?.[service]) ?? expectedHash;
      const bound = bindings.services?.[service];
      const id = bound?.serviceId ?? bound?.jobName;
      const matches = servicesKnown && id ? observed!.services.filter(item => item.externalId === id) : [];
      const live = matches.length === 1 ? matches[0] : undefined;
      const presence: Presence = absentEnvironment ? 'absent' : live
        ? live.envVarKeys.includes(name) ? 'present' : 'absent'
        : servicesKnown && id && matches.length === 0 ? 'absent' : 'unknown';
      const rollout = rollouts.find(item => item.service === service && item.provider === provider && (!item.serviceExternalId || item.serviceExternalId === id));
      const requirement = pending.find(item => item.service === service);
      const activation = unknownActivation();
      if (live?.deployment?.id) activation.deploymentId = live.deployment.id;
      if (live?.deployment?.activeDeploymentIds) activation.activeDeploymentIds = live.deployment.activeDeploymentIds;
      if (live?.deployment?.activeDeploymentCoverage) activation.coverage = live.deployment.activeDeploymentCoverage;
      if (rollout) {
        activation.requiredSince = rollout.requiredAt;
        activation.baselineDeploymentId = rollout.baselineDeployment.id;
        activation.state = requirement ? 'pending' : live?.status === 'running' && live.deployment?.id ? 'replacement-deployed' : 'unknown';
        activation.reason = requirement?.reason ?? 'A later deployment is selected; credential use and retirement of old instances are not proven.';
        if (!requirement && rollout.operationId && activation.state === 'replacement-deployed') {
          activation.lastConfirmedAt = observed?.observedAt ?? null;
          activation.allInstances = activation.coverage === 'instances' ? 'confirmed' : 'unknown';
          activation.reason = activation.coverage === 'instances'
            ? 'The exact replacement configuration is bound to the active deployment, and the provider confirms old instances have retired. Application operation requires its own check.'
            : 'The exact replacement configuration is bound to the active deployment. Provider coverage establishes current traffic routing; old process retirement remains unknown.';
        }
      }
      return { kind: 'hosting', provider, name, service, ...(id ? { serviceId: id } : {}), environment: env,
        providerProjectId: bindings.projectId, providerEnvironmentId: bindings.environmentId,
        configuration: { presence, comparison: live && live.envVarEvidence !== 'recorded-update' ? compare(live.envVarHashes[name], acceptedHash) : 'unknown',
          basis: live?.envVarEvidence === 'recorded-update' ? 'recorded-update; current-value-unreadable' : acceptedHash ? 'provider-configuration-compared-privately' : 'presence-only', scopeState: environmentState }, activation };
    });
  }

  const repository = spec.github?.repository ?? parseGitHubRepoFromRemote(project.gitRemoteUrl);
  const canonicalName = githubActionsCanonicalEnvironment(spec);
  const canonical = canonicalName ? ctx.repos.environments.findByProjectAndName(project.id, canonicalName) : null;
  const githubBindings = parseGitHubDelegatedBindings(canonical);
  let github: ReturnType<typeof getGitHubAdapter> | null = null;
  try { github = repository ? getGitHubAdapter(repository) : null; }
  catch { gaps.add('The GitHub connection could not be read; CI destination observations are unknown.'); }
  const githubReads = new Map<string, Awaited<ReturnType<Extract<NonNullable<typeof github>, { adapter: unknown }>['adapter']['observeSecretInventory']>>>();
  async function githubConsumer(name: string, target: string, receipt?: { syncedAt?: string; valueHash?: string }, expectedHash?: string): Promise<Consumer> {
    const targetEnv = target.startsWith('environment:') ? target.slice('environment:'.length) : undefined;
    let evidence = githubReads.get(target);
    if (!evidence) {
      evidence = { state: 'unknown', secrets: [] };
      if (repository && github && 'adapter' in github) {
        const [owner, repo] = repository.split('/');
        evidence = await github.adapter.observeSecretInventory(owner, repo, targetEnv);
      }
      githubReads.set(target, evidence);
    }
    const live = evidence.secrets.find(secret => secret.name.toLowerCase() === name.toLowerCase());
    return { kind: 'github-actions', provider: 'github', name, repository: repository ?? undefined,
      scope: targetEnv === undefined ? 'repository' : 'environment', ...(targetEnv ? { environment: targetEnv } : {}),
      configuration: { presence: evidence.state === 'unknown' ? 'unknown' : live ? 'present' : 'absent',
        scopeState: evidence.state, comparison: 'unknown', basis: 'write-only-destination',
        ...(receipt?.syncedAt ? { recordedSyncAt: receipt.syncedAt } : {}),
        recordedValueComparison: compare(receipt?.valueHash, expectedHash),
        ...(live ? { destinationCreatedAt: live.created_at, destinationUpdatedAt: live.updated_at } : {}) },
      activation: unknownActivation('A write-only CI secret and a synchronization receipt do not prove a workflow or workload used this value.') };
  }

  const declaredRoles = new Map<string, Credential>();
  for (const [key, slot] of Object.entries(spec.secrets)) {
    const targets = slot.ownership === 'delegated' ? [
      ...(slot.githubActions?.repository ? ['repository'] : []),
      ...(slot.githubActions?.environments ?? []).map(name => `environment:${name}`),
    ] : [];
    if (!slot.environments.includes(env) && !targets.length && slot.credential?.database?.environment !== env) continue;
    const binding = accepted.find(item => item.name === key && (slot.ownership === 'hypervibe'
      ? item.source === 'hypervibe-generated' && item.generator === slot.generator && item.generation === slot.generation
      : item.source === 'delegated-plan-input' && item.principal === slot.principal));
    const recordedHashes = [...new Set(githubBindings.filter(item => slot.ownership === 'delegated'
      && item.name === key && item.principal === slot.principal && targets.includes(item.target)).map(item => item.valueHash))];
    const roleHistory = slot.credential ? record(record(environment?.platformBindings.credentialUpdates)[slot.credential.role]) : {};
    const acceptedInputHash = string(roleHistory.acceptedInputHash) ?? binding?.valueHash ?? (recordedHashes.length === 1 ? recordedHashes[0] : undefined);
    const entry = credential(`secret:${key}`, key.replaceAll('_', ' '), slot.ownership === 'hypervibe'
      ? 'Hypervibe-generated application secret.' : 'Externally supplied application or workflow credential.',
    slot.ownership === 'hypervibe' ? 'generated-secret' : 'user-supplied-runtime-key',
    slot.ownership === 'hypervibe' ? { kind: 'generator', generator: slot.generator, generation: slot.generation }
      : { kind: 'unknown', principal: slot.principal, reason: 'Existing acceptance records do not retain the original source reference.' });
    entry.aliases.push(key); entry.rotation.acceptedUpdateAt = binding?.syncedAt ?? null;
    entry.updates = recentRuns.flatMap(run => run.receipts.filter(receipt => receipt.step === `secret:${key}`).map(receipt => ({
      runId: run.id, actionId: receipt.step, at: receipt.timestamp, outcome: receipt.status,
      writeOutcome: receipt.status === 'success' ? 'recorded-success' as const : 'unknown' as const,
    })));
    if (slot.ownership === 'delegated') candidates(entry, key, acceptedInputHash);
    if (slot.environments.includes(env)) entry.consumers.push(...hosting(key, binding?.valueHash,
      slot.credential?.runtimeConsumers || slot.credential?.stripeWebhook ? credentialRuntimeServices(spec, env, key, slot.credential) : undefined,
      record(record(roleHistory.hostingHashes)[key])));
    for (const target of targets) {
      const receipt = githubBindings.find(item => item.name === key && item.target === target && slot.ownership === 'delegated' && item.principal === slot.principal);
      entry.consumers.push(await githubConsumer(key, target, receipt));
    }
    if (slot.credential) {
      const descriptor = slot.credential;
      const history = record(record(environment?.platformBindings.credentialUpdates)[descriptor.role]);
      const audit = ctx.repos.audit.findByResource('credential-role', `${project.id}/${descriptor.role}`, 100);
      const validations = audit.filter(event => event.action === 'credential.validated');
      const validation = validations[0]?.details ?? record(history.validation);
      entry.id = `role:${descriptor.role}`;
      entry.label = descriptor.label; entry.purpose = descriptor.purpose;
      entry.source = descriptor.source ? { kind: 'declared-reference', ref: descriptor.source, acceptedSource: record(history.descriptor).source ?? null } : entry.source;
      entry.source.lastReadAt = audit.find(event => event.action === 'credential.source.read'
        && event.details.source === (descriptor.source ?? 'hypervibe-generator'))?.timestamp.toISOString() ?? null;
      entry.management = credentialManagement(descriptor);
      entry.lifecycle = { state: string(history.state) ?? 'unadopted', planId: string(history.planId), revocation: 'pending' };
      entry.rotation.userReportedCreatedAt = descriptor.userReportedCreatedAt ?? null;
      entry.rotation.userReportedRotatedAt = descriptor.userReportedRotatedAt ?? null;
      entry.rotation.evidence = descriptor.userReportedRotatedAt ? 'user-reported' : 'unknown';
      entry.rotation.acceptedUpdateAt = string(history.acceptedAt) ?? entry.rotation.acceptedUpdateAt;
      if (validation.result) entry.validation = { result: String(validation.result), at: string(validation.at) ?? null, tested: String(validation.tested ?? 'Unknown check'),
        subject: history.state === 'accepted' && validations[0]?.id && validations[0].id === record(history.validation).evidenceId ? 'accepted-plan-input' : 'candidate-plan-input',
        lastSuccessfulAt: string(validations.find(event => event.details.result === 'passed')?.details.at) ?? (validation.result === 'passed' ? string(validation.at) ?? null : null) };
      const testedIdentity = record(validation.intendedIdentity);
      const identityMatches = descriptor.identity && validation.result === 'passed'
        && validation.accountId === (descriptor.identity.sandboxId ?? descriptor.identity.accountId)
        && ['accountId', 'sandboxId', 'mode', 'endpointId'].every(key => testedIdentity[key] === record(descriptor.identity)[key]);
      entry.identity = { state: identityMatches ? 'validated' : 'unknown', intended: descriptor.identity,
        reason: identityMatches ? 'Provider returned the declared account identity during the recorded input check; runtime use remains unproven.' : 'Matching the currently intended identity has not been proven.' };
      // Read only bounded local descriptors. Secret-manager references remain
      // descriptors: inventory never resolves or validates remote credentials.
      if (descriptor.source?.startsWith('dotenv:') || descriptor.source?.startsWith('file:')) {
        const dotenv = descriptor.source.startsWith('dotenv:');
        const fragment = descriptor.source.lastIndexOf('#');
        const file = dotenv ? descriptor.source.slice(7, fragment) : descriptor.source.slice(5);
        const sourceKey = dotenv ? descriptor.source.slice(fragment + 1) : '(file contents)';
        try {
          const stat = lstatSync(file);
          if (stat.isFile() && stat.size <= 1024 * 1024) {
            const values = dotenv ? parseEnvFile(file) : { [sourceKey]: readFileSync(file, 'utf8').trim() }; exactValues.push(...Object.values(values));
            entry.localCandidates.push({ path: file, key: sourceKey, present: Boolean(values[sourceKey]), comparisonToAccepted: compare(values[sourceKey] ? hashEnvValue(values[sourceKey]) : undefined, acceptedInputHash), selectedForDeploy: false });
          } else gaps.add('A declared local source is not a bounded regular file; its candidate comparison is unknown.');
        } catch { gaps.add('A declared local source could not be inspected; its candidate comparison is unknown.'); }
      } else if (descriptor.source?.startsWith('env:')) {
        const sourceKey = descriptor.source.slice(4);
        const value = process.env[sourceKey];
        if (value) exactValues.push(value);
        entry.localCandidates.push({ path: 'process environment', key: sourceKey, present: Boolean(value), comparisonToAccepted: compare(value ? hashEnvValue(value) : undefined, acceptedInputHash), selectedForDeploy: false });
      }
      if (descriptor.kind === 'database-password' && descriptor.database?.environment === env && environment) {
        const component = ctx.repos.components.findById(descriptor.database.component);
        const nativeHistory = record(history.nativeDatabase);
        const target = record(nativeHistory.target);
        const nativeProvider = string(target.provider) ?? string(component?.bindings.provider) ?? desired?.database?.provider ?? 'unknown';
        let presence: Presence = 'unknown';
        if (component?.externalId && component.environmentId === environment.id && nativeProvider === desired?.database?.provider) {
          try {
            const connection = await adapterFactory.getDatabaseAdapter(nativeProvider, project);
            if (connection.success && connection.adapter && typeof connection.adapter.observeDatabase === 'function') {
              const native = await connection.adapter.observeDatabase(environment, component);
              if (native === null) presence = 'absent';
              else if (native?.externalId === component.externalId && native.provider === nativeProvider && native.engine === 'postgres') presence = 'present';
            }
          } catch { /* Read-only scope/authentication failures remain unknown. */ }
        }
        const marker = record(component?.bindings.credentialRotation);
        if (marker.planId && marker.phase !== 'installed') entry.lifecycle = { state: 'pending', planId: String(marker.planId), revocation: 'pending' };
        if (record(history.sourceDescriptor).kind === 'provider-generated') {
          entry.ownership = 'provider-reference'; entry.source = { ...record(history.sourceDescriptor),
            lastReadAt: audit.find(event => event.action === 'credential.source.read' && event.details.source === `provider-generated:${nativeProvider}`)?.timestamp.toISOString() ?? null };
        }
        entry.consumers.push({ kind: 'database', provider: nativeProvider, name: `${descriptor.database.username}@${descriptor.database.database}`, environment: env,
          ...(component?.externalId ? { nativeIdentity: { componentId: component.id, externalId: component.externalId, username: descriptor.database.username, database: descriptor.database.database,
            providerScope: record(component.bindings.providerScope) } } : {}),
          configuration: { presence, comparison: 'unknown', basis: 'recorded-native-authentication; current-password-not-inspected', ...(string(history.acceptedAt) ? { recordedSyncAt: String(history.acceptedAt) } : {}) },
          activation: { ...unknownActivation('Database authentication is recorded separately from application deployment and existing sessions.'), state: 'not-applicable' } });
        const consumers = Array.isArray(nativeHistory.consumers) ? nativeHistory.consumers.map(record)
          : Object.entries(desired?.services ?? {}).map(([service, spec]) => ({ service, externalId: bindings.services?.[service]?.serviceId ?? bindings.services?.[service]?.jobName,
            keys: ['DATABASE_URL', ...Object.keys(spec.databaseEnvAliases ?? {})] }));
        for (const consumer of consumers) {
          const service = string(consumer.service); const keys = Array.isArray(consumer.keys) ? consumer.keys.filter((key): key is string => typeof key === 'string') : [];
          if (!service) continue;
          for (const key of keys) entry.consumers.push(...hosting(key, undefined, [service], record(record(history.hostingHashes)[key])).map(consumerState => {
            if (consumerState.serviceId !== consumer.externalId) return { ...consumerState, configuration: { ...consumerState.configuration, comparison: 'unknown' as const, basis: 'consumer-identity-changed-after-acceptance' }, activation: unknownActivation('The accepted database consumer identity changed.') };
            if (record(consumer).valueEvidence === 'acknowledgement') return { ...consumerState, configuration: { ...consumerState.configuration, comparison: 'unknown' as const, basis: 'write-only-destination; synchronization-acknowledged' } };
            return consumerState;
          }));
        }
      }
      entry.nextAction = entry.lifecycle?.state === 'pending' ? `Resume hv_apply planId="${String(entry.lifecycle.planId)}"; inspect uncertain writes before replacing the frozen input.` : `Review hv_plan scope="credentials" credential="${descriptor.role}" intent="${history.state === 'accepted' ? 'rotate' : 'adopt'}". Adoption preserves values; rotation replaces them.`;
      const prior = declaredRoles.get(descriptor.role);
      if (prior) {
        prior.aliases.push(...entry.aliases); prior.consumers.push(...entry.consumers); prior.localCandidates.push(...entry.localCandidates); prior.updates.push(...entry.updates);
        continue;
      }
      for (const pull of descriptor.containerPull ?? []) {
        const targetEnv = ctx.repos.environments.findByProjectAndName(project.id, pull.environment);
        const targetBinding = parseHostingBindings(targetEnv);
        const targetProgress = record(record(targetEnv?.platformBindings.credentialUpdates)[descriptor.role]);
        const alias = Object.entries(spec.secrets).filter(([, candidate]) => candidate.credential?.role === descriptor.role).map(([key]) => key).sort()[0];
        const actionId = `credential:${descriptor.role}:registry:${encodeURIComponent(pull.environment)}:${alias}:${encodeURIComponent(pull.service)}`;
        const completed = Array.isArray(targetProgress.completed) && targetProgress.completed.includes(actionId);
        entry.consumers.push({ kind: 'container-pull', provider: targetBinding.provider ?? spec.environments[pull.environment]?.hosting.provider ?? 'unknown', name: 'registry credentials', environment: pull.environment, service: pull.service,
          serviceId: targetBinding.services?.[pull.service]?.serviceId, providerProjectId: targetBinding.projectId, providerEnvironmentId: targetBinding.environmentId,
          configuration: { presence: 'unknown', comparison: 'unknown', basis: 'write-only-container-pull-credential', ...(completed && string(targetProgress.acceptedAt) ? { recordedSyncAt: string(targetProgress.acceptedAt) } : {}) },
          activation: pull.environment === env ? hosting(alias).find(c => c.service === pull.service)?.activation ?? unknownActivation() : unknownActivation('Inspect this exact environment and managed image deployment; another consumer does not establish activation.') });
      }
      declaredRoles.set(descriptor.role, entry);
    }
    entries.push(entry);
  }

  // Identical *declared references* establish shared source, never equal values.
  const references = new Map<string, Credential>();
  for (const [key, value] of Object.entries(desired?.envVars ?? {})) {
    const reference = parseSecretRef(value);
    if (!reference) { exactValues.push(value); continue; }
    let entry = references.get(reference.raw);
    if (!entry) {
      entry = credential(`reference:${key}`, `${key.replaceAll('_', ' ')} source`, 'Application values supplied by a declared secret manager reference.',
        'provider-reference', { kind: 'secret-manager', provider: reference.provider, path: reference.path,
          ...(reference.key ? { key: reference.key } : {}), ...(reference.version ? { version: reference.version } : {}) });
      references.set(reference.raw, entry); entries.push(entry);
    }
    entry.aliases.push(key); entry.consumers.push(...hosting(key));
  }

  for (const key of [...new Set(local.flatMap(file => Object.keys(file.values)))].sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || spec.secrets[key] || entries.some(entry => entry.aliases.includes(key))) continue;
    const entry = credential(`untracked:${key}`, key.replaceAll('_', ' '), 'Local application input; credential purpose and ownership have not been reviewed.',
      'untracked-input', { kind: 'dotenv-candidate', accepted: false });
    entry.aliases.push(key); candidates(entry, key);
    const value = selectedFile?.values[key];
    if (!isProviderOnlyDeployEnvKey(key)) entry.consumers.push(...hosting(key, value ? hashEnvValue(value) : undefined));
    entry.nextAction = 'Review this local candidate and its exact consumers before declaring or adopting it with hv_spec; inventory preserves existing values.';
    entries.push(entry);
  }

  if (servicesKnown) for (const [service, bound] of Object.entries(bindings.services ?? {})) {
    const matching = observed!.services.filter(item => item.externalId === (bound.serviceId ?? bound.jobName));
    if (matching.length !== 1) continue;
    for (const key of matching[0].envVarKeys) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || entries.some(entry => entry.consumers.some(consumer => consumer.kind === 'hosting' && consumer.service === service && consumer.name === key))) continue;
      const entry = credential(`untracked:${service}:${key}`, key.replaceAll('_', ' '), 'Observed hosting input; credential purpose and original source have not been declared.',
        'untracked-input', { kind: 'provider-configuration', provider, service, originalInput: 'unknown' });
      entry.aliases.push(key); entry.consumers.push(...hosting(key).filter(consumer => consumer.service === service));
      entry.nextAction = 'Review this existing service input before declaring ownership; inventory does not adopt or replace it.';
      entries.push(entry);
    }
  }

  const devops = resolveDevOpsSelection(spec);
  if (devops?.ci && devops.ci.provider !== 'github-actions') gaps.add('CI secret inventory is not implemented for the selected CI provider; its destinations remain unchecked.');
  const ciTargets = Object.entries(spec.environments).flatMap(([name, target]) => {
    const saved = ctx.repos.environments.findByProjectAndName(project.id, name);
    const workflows = Object.values(record(record(saved?.platformBindings.ci).deployBranch)).map(record);
    const managed = workflows.length > 0 || target.deploy?.strategy === 'branch' && target.deploy.trigger !== 'native';
    if (!repository || !managed || devops?.ci && devops.ci.provider !== 'github-actions') return [];
    let sources: ReturnType<typeof managedCiCredentialSources> = [];
    try { sources = managedCiCredentialSources(target.hosting.provider, repository); }
    catch { gaps.add('A managed CI source could not be resolved; recorded destinations retain unknown provenance.'); }
    return [{ environment: name, provider: target.hosting.provider, bindings: parseHostingBindings(saved), workflows, sources }];
  });
  const workflowBindings = Object.values(record(record(environment?.platformBindings.ci).deployBranch)).map(record);
  for (const definition of [...providerRegistry.all(), ...secretManagerRegistry.all()]) {
    const metadata = definition.metadata;
    const best = ctx.repos.connections.findBestMatchFromHints(metadata.name, getProjectScopeHints(project));
    const selectedIds = new Set([best?.id, ...ciTargets.flatMap(target => target.sources.map(source => source.connectionId))]);
    for (const connection of ctx.repos.connections.findAllByProvider(metadata.name).filter(connection => selectedIds.has(connection.id))) {
      const acquisition = ctx.repos.audit.findByResource('connection', connection.id, 100).find(event => event.action === 'connection.created');
      const sourceEvidence = { originalInput: string(acquisition?.details.credentialsSource) ?? 'unknown',
        ...(string(acquisition?.details.credentialsRef) ? { ref: string(acquisition?.details.credentialsRef) } : {}),
        lastReadAt: acquisition?.timestamp.toISOString() ?? null };
      let credentials: Record<string, unknown>;
      try { credentials = ctx.secretStore.decryptObject(connection.credentialsEncrypted); }
      catch { gaps.add('A saved connection could not be read; credential source evidence is incomplete.'); continue; }
      const inputs = providerRegistry.getMetadata(metadata.name)?.credentials?.localEnvInputs ?? [];
      const roles = inputs.length ? inputs : [{ envKey: '', credentialKeys: [metadata.credentials?.defaultScalarKey ?? 'credential'], comment: `${metadata.displayName} provider access` }];
      for (const input of roles) {
        for (const key of input.credentialKeys.filter(key => typeof credentials[key] === 'string')) {
          exactValues.push(credentials[key] as string);
          const resolvedSource = record(record(acquisition?.details.credentialsResolution)[key]);
          const entry = credential(`connection:${connection.id}:${key}`, input.comment.split(';')[0], input.comment,
            'provider-connection', { kind: 'connection', id: connection.id, provider: metadata.name, credentialRole: key,
              scope: connection.scope, ...sourceEvidence,
              ...(string(resolvedSource.resolvedRef) ? { resolvedRef: string(resolvedSource.resolvedRef) } : {}),
              ...(string(resolvedSource.sourceKey) ? { resolvedInputKey: string(resolvedSource.sourceKey) } : {}),
              ...(string(resolvedSource.sourceField) ? { resolvedField: string(resolvedSource.sourceField) } : {}),
              ...(string(record(acquisition?.details.credentialsMap)[key]) ? { inputKey: string(record(acquisition?.details.credentialsMap)[key]) } : {}) });
          entry.rotation.acceptedUpdateAt = acquisition?.timestamp.toISOString() ?? null;
          const expectedHash = hashEnvValue(credentials[key] as string);
          if (input.envKey) { entry.aliases.push(input.envKey); candidates(entry, input.envKey, expectedHash); }
          // Connection verification timestamps are not per-role authentication or rotation evidence.
          entry.validation = { at: null, result: 'unknown',
            tested: 'Individual credential-role authentication was not recorded. Connection verification is separate evidence.',
            connectionEvidence: { at: connection.lastVerifiedAt?.toISOString() ?? null, result: connection.status } };
          entry.consumers.push({ kind: 'provider-api', provider: metadata.name, name: key,
            configuration: { presence: 'present', comparison: 'unknown', basis: 'encrypted-local-connection' },
            activation: { ...unknownActivation('Control-plane credential; runtime activation does not apply.'), state: 'not-applicable' } });
          for (const target of ciTargets) for (const mapping of target.sources.filter(source => source.connectionId === connection.id && source.credentialKey === key)) {
            entry.aliases.push(mapping.name);
            const receipts = target.workflows.filter(binding => typeof record(binding.syncedEnvironmentSecretHashes)[mapping.name] === 'string');
            const receipt = receipts.length === 1 ? { syncedAt: string(receipts[0].updatedAt), valueHash: string(record(receipts[0].syncedEnvironmentSecretHashes)[mapping.name]) } : undefined;
            entry.consumers.push(await githubConsumer(mapping.name, `environment:${target.environment}`, receipt, expectedHash));
            if (mapping.containerPull) for (const [service, binding] of Object.entries(target.bindings.services ?? {})) {
              entry.consumers.push({ kind: 'container-pull', provider: target.provider, name: mapping.name, service,
                serviceId: binding.serviceId, environment: target.environment,
                providerProjectId: target.bindings.projectId, providerEnvironmentId: target.bindings.environmentId,
                configuration: { presence: 'unknown', comparison: 'unknown', basis: 'declared-image-pull-source; provider-copy-not-observed' },
                activation: unknownActivation('A successful deployment does not prove the stored pull credential or future pull access.') });
            }
          }
          entries.push(entry);
        }
      }
      if (!entries.some(entry => entry.source.kind === 'connection' && entry.source.id === connection.id)) {
        const entry = credential(`connection:${connection.id}`, `${metadata.displayName} access`, 'Saved provider authentication with no separately described scalar credential role.',
          'provider-connection', { kind: 'connection', id: connection.id, provider: metadata.name, scope: connection.scope, ...sourceEvidence });
        entry.rotation.acceptedUpdateAt = acquisition?.timestamp.toISOString() ?? null;
        entry.validation.connectionEvidence = { at: connection.lastVerifiedAt?.toISOString() ?? null, result: connection.status };
        entries.push(entry);
      }
    }
  }
  // A local provider slot is a candidate for the provider-declared role, not a
  // second credential or evidence that its contents were accepted.
  const connectionAliases = new Set(entries.filter(entry => entry.ownership === 'provider-connection').flatMap(entry => entry.localCandidates.map(candidate => candidate.key)));
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index].ownership === 'untracked-input' && entries[index].aliases.some(key => connectionAliases.has(key))) entries.splice(index, 1);
  }
  // Recorded CI names without retained source mappings are useful evidence too.
  for (const binding of workflowBindings) for (const name of new Set([
    ...(Array.isArray(binding.syncedEnvironmentSecrets) ? binding.syncedEnvironmentSecrets.filter((name): name is string => typeof name === 'string') : []),
    ...Object.keys(record(binding.syncedEnvironmentSecretHashes)),
  ])) {
    if (entries.some(entry => entry.consumers.some(consumer => consumer.kind === 'github-actions' && consumer.name === name && consumer.environment === env))) continue;
    const entry = credential(`ci:${env}:${name}`, name.replaceAll('_', ' '), 'Recorded workflow secret; original credential role is unknown.',
      'untracked-input', { kind: 'unknown', reason: 'CI receipt records the destination but no source mapping.' });
    entry.aliases.push(name);
    entry.consumers.push(await githubConsumer(name, `environment:${env}`, { syncedAt: string(binding.updatedAt) })); entries.push(entry);
  }
  const credentialRuns = ctx.repos.runs.findByProjectId(project.id, 100).filter(run => run.type === 'apply');
  const acquisitions = repository ? importedCredentialProvenance(ctx, repository, env) : [];
  const sameFile = (left: string, right: string) => {
    if (path.resolve(left) === path.resolve(right)) return true;
    try { return realpathSync(left) === realpathSync(right); } catch { return false; }
  };
  for (const entry of entries) {
    const sources = acquisitions.filter(acquisition => entry.localCandidates.some(candidate => sameFile(candidate.path, acquisition.path) && candidate.key === acquisition.key));
    if (sources.length) entry.source.acquisitions = sources;
    entry.aliases = [...new Set(entry.aliases)].sort();
    if (entry.id.startsWith('role:')) {
      entry.applicationOperation = await credentialOperationEvidence(ctx, project, spec, entry.id.slice(5), { [env]: identityMatches ? observed : null });
      const prefix = `credential:${entry.id.slice(5)}:`;
      entry.updates.push(...credentialRuns.flatMap(run => run.receipts.filter(receipt => receipt.step.startsWith(prefix)).map(receipt => ({
        runId: run.id, actionId: receipt.step, at: receipt.timestamp, outcome: receipt.status,
        writeOutcome: receipt.status === 'success' ? 'recorded-success' as const : 'unknown' as const,
      }))));
    }
    const role = entry.id.startsWith('role:') ? entry.id.slice(5) : undefined;
    const runtimeConsumers = entry.consumers.filter(consumer => consumer.kind === 'hosting' || consumer.kind === 'container-pull');
    const acceptedRole = entry.lifecycle?.state === 'accepted';
    if (entry.lifecycle?.state === 'pending') {
      entry.nextAction = `Resume hv_apply planId="${entry.lifecycle.planId}" with its reviewed actions; recover the frozen replacement before planning another update.`;
    } else if (entry.consumers.some(consumer => consumer.configuration.scopeState === 'absent')) {
      entry.nextAction = 'The exact destination scope is absent. Review desired state with hv_spec and hv_plan; inventory will not recreate it.';
    } else if (entry.consumers.some(consumer => consumer.configuration.comparison === 'different' || consumer.configuration.recordedValueComparison === 'different')) {
      entry.nextAction = 'Configuration differs from the candidate or accepted credential. Review synchronization of the exact affected destinations with hv_plan before completing rollout; preserve the accepted input.';
    } else if (entry.consumers.some(consumer => consumer.activation.state === 'pending' && consumer.activation.coverage === 'traffic')) {
      entry.nextAction = 'The provider reports only traffic routing for a pending consumer. Keep this credential rollout pending until exact old-instance retirement can be observed; the current provider capability cannot prove it. Preserve the accepted input.';
    } else if (entry.consumers.some(consumer => consumer.activation.state === 'pending')) {
      entry.nextAction = 'Finish the accepted configuration rollout: inspect hv_status and hv_ci_status, then complete the existing managed rollout through hv_ci_trigger if required. Verify the application operation after activation; preserve the accepted input.';
    } else if (acceptedRole && runtimeConsumers.some(consumer => consumer.activation.state === 'unknown')) {
      entry.nextAction = 'Inspect hv_status and hv_ci_status to confirm the exact accepted deployment for every runtime consumer. Complete any existing managed rollout before verifying application operations; preserve the accepted input.';
    } else if (acceptedRole && role && runtimeConsumers.length && entry.applicationOperation.state !== 'verified') {
      const health = `hv_health project=${JSON.stringify(project.name)} credential=${JSON.stringify(role)}`;
      const checks = Object.values(spec.secrets).find(slot => slot.credential?.role === role)?.credential?.verification;
      entry.nextAction = entry.applicationOperation.state === 'failed'
        ? `Investigate the failed application assertion, perform the approved operation, then use ${health} to verify a fresh receipt for the accepted deployment.`
        : checks?.length
          ? `Use ${health} to verify declared application receipts for every runtime consumer. Declare any missing meaningful checks through hv_spec; authentication alone does not verify the application operation.`
          : `Declare a meaningful application-operation check for every runtime consumer through hv_spec, then use ${health} to verify its receipt for the accepted deployment.`;
    } else if (entry.localCandidates.some(candidate => candidate.comparisonToAccepted === 'different')) {
      entry.nextAction = 'A local candidate differs from the accepted credential. Review an explicit replacement through hv_plan; do not overwrite accepted values automatically.';
    } else if (acceptedRole) {
      entry.nextAction = 'Review the recorded synchronization and activation evidence for every exact destination before considering retirement of the previous credential.';
    }
    if (entry.lifecycle?.state === 'pending' || acceptedRole) {
      entry.nextAction += runtimeConsumers.length
        ? ' Revocation remains pending until every known consumer, application check, and old-instance retirement are confirmed.'
        : ' Revocation remains pending until every known consumer is confirmed to use the replacement.';
    }
  }
  return redactExactValues({ project: { id: project.id, name: project.name }, environment: env, view: 'inventory',
    readOnly: true, environmentState, hostingObservedAt: observed?.observedAt ?? null,
    roles: entries, evidenceGaps: [...gaps] }, exactValues);
}

import type { Project } from '../entities/project.entity.js';
import { appStoreReleaseSecretNames, matchSigningSecretNames, type ProjectSpec } from '../spec/spec.schema.js';
import { resolveDevOpsSelection } from '../spec/devops-selection.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { getProjectScopeHints } from './project-scope.js';
import { cloudflareScopeHintsForDomain } from './domain-scope.js';

export type ProjectRotationMode = 'incident' | 'routine';
export interface ProjectRotationConnection {
  id: string;
  provider: string;
  scope: string | null;
  status: string;
}
type RotationProject = Pick<Project, 'id' | 'name' | 'gitRemoteUrl'>;
export interface ProjectRotationInput {
  project: RotationProject;
  spec: ProjectSpec;
  specRevision: number;
  mode: ProjectRotationMode;
  recordedEnvironments: Array<{ name: string }>;
  connections: ProjectRotationConnection[];
}
export interface ProjectRotationBlocker {
  code: string;
  message: string;
  environment?: string;
}
export interface ProjectRotationDestination {
  kind: 'runtime' | 'github-repository' | 'github-environment' | 'resource' | 'connection' | 'ci';
  environment?: string;
  service?: string;
  workloadKind?: 'web' | 'worker' | 'cron';
  repository?: string;
  resource?: string;
  scope?: string | null;
}
export interface ProjectRotationStage {
  id: string;
  status: 'required' | 'blocked';
  dependsOn: string[];
  message: string;
}
export interface ProjectRotationEntry {
  id: string;
  category: 'generated-secret' | 'delegated-secret' | 'configuration' | 'database' | 'cache'
    | 'storage' | 'integration' | 'ci' | 'registry' | 'signing' | 'retained-resources' | 'connection';
  ownership: 'hypervibe' | 'delegated' | 'provider' | 'unclassified' | 'unknown';
  keys: string[];
  provider?: string;
  principal?: string;
  generation?: number;
  replacementPolicy?: 'immutable';
  connection?: ProjectRotationConnection;
  destinations: ProjectRotationDestination[];
  blockers: ProjectRotationBlocker[];
  stages: ProjectRotationStage[];
}
export interface ProjectRotationAssessment {
  version: 1;
  project: { id: string; name: string };
  specRevision: number;
  mode: ProjectRotationMode;
  status: 'review_required';
  rotationPerformed: false;
  executable: false;
  coverage: {
    basis: 'recorded_desired_state';
    live: 'unchecked';
    unmanaged: 'unchecked';
    outsideConsumers: 'unchecked';
    complete: false;
  };
  inventory: ProjectRotationEntry[];
  blockers: ProjectRotationBlocker[];
  process: ProjectRotationStage[];
}

const blocker = (code: string, message: string): ProjectRotationBlocker => ({ code, message });
const outsideConsumers = () => blocker('outside_consumers_unchecked',
  'Consumers outside these declarations are unchecked. A matching name or connection scope does not prove exclusive ownership.');
const unsupportedIssuer = () => blocker('issuer_rotation_unsupported',
  'This project-wide preparation workflow does not execute issuer rotation. Separate scoped lifecycle capabilities may exist; their prerequisites and exact-credential evidence are unchecked here. Copying a value is not rotation.');
const identityUnknown = () => blocker('credential_identity_unverified',
  'Verify the issuing account, exact credential identity, privileges and every consumer before choosing the change.');
const id = (...parts: string[]) => parts.map(part => encodeURIComponent(part)).join(':');
const sorted = <T>(entries: Record<string, T>): [string, T][] => Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
const unique = (names: string[]) => [...new Set(names)].sort();
const trustStage = (): ProjectRotationStage => ({ id: 'trust-destinations', status: 'blocked', dependsOn: ['review'],
  message: 'Establish destination trust before installing replacements. Provider health or redeployment does not prove that a suspected host, CI runner or secret source is safe to receive fresh credentials.' });
const closureStage = (dependsOn: string[]): ProjectRotationStage => ({ id: 'closure', status: 'blocked', dependsOn,
  message: 'Reconcile all consumer-use, invalidation and revocation evidence with live, unmanaged, retained and outside scopes. Keep unchecked boundaries and unsupported issuers visible; a completed checklist is not independent proof of containment.' });

/** Process guidance only. No stage grants mutation authority or attests completion. */
export function projectRotationStages(mode: ProjectRotationMode): ProjectRotationStage[] {
  const stage = (name: string, dependsOn: string[], message: string): ProjectRotationStage =>
    ({ id: name, status: name === 'review' ? 'required' : 'blocked', dependsOn, message });
  const review = stage('review', [], mode === 'incident'
    ? 'Review exact exposure, issuer identity, shared consumers and immediate revocation. Record outage impact and containment approval; never automatically reactivate a suspected credential.'
    : 'Review issuer identity, all consumers and application effects. Confirm the issuer permits overlapping credentials and review consequences before mutation.');
  const issue = stage('issue', [mode === 'incident' ? 'verify-revocation' : 'review'],
    'Persist exact reviewed issuance intent, obtain a least-privilege replacement and save one-time values encrypted before distribution. Reconcile uncertain issuance without creating or retrieving another copy.');
  const distribute = stage('distribute', ['issue', 'trust-destinations'],
    'Use reviewed spec/plan/apply actions to install the same issued replacement into every exact approved destination. Partial writes remain incomplete; local files are not issuer evidence.');
  const rollout = stage('rollout', ['distribute'],
    'Deploy the reviewed configuration to every runtime and CI consumer, including workers, scheduled jobs and serving revisions. Saved configuration is not a rollout.');
  const verify = stage('verify-consumers', ['rollout'],
    'Verify meaningful operations using the replacement on every consumer. An HTTP health check or key presence alone does not prove credential use; failed or unknown checks remain unresolved.');
  const revoke = stage('revoke', [mode === 'incident' ? 'review' : 'verify-consumers'],
    'Revoke or disable the exact old credential at its issuer under reviewed authority. Removing an environment variable or local connection does not revoke it.');
  const revoked = stage('verify-revocation', ['revoke'],
    'Verify issuer-side revocation of the exact old identity and rejection of old authority. Timeouts, unverified receipts and missing logs are unknown, not success.');
  return mode === 'incident'
    ? [review, revoke, revoked, issue, trustStage(), distribute, rollout, verify, closureStage(['verify-consumers', 'verify-revocation'])]
    : [review, issue, trustStage(), distribute, rollout, verify, revoke, revoked, closureStage(['verify-consumers', 'verify-revocation'])];
}

function generatedStages(immutable: boolean): ProjectRotationStage[] {
  return immutable ? [
    { id: 'review', status: 'required', dependsOn: [], message: 'Identify all encrypted data, key versions, backups and consumers. A confirmation cannot override an immutable secret policy.' },
    trustStage(),
    { id: 'rewrap', status: 'blocked', dependsOn: ['review', 'trust-destinations'], message: 'Use an explicit application-aware rewrap or re-encryption migration; never increment this generation or overwrite the old key in place.' },
    { id: 'verify-recovery', status: 'blocked', dependsOn: ['rewrap'], message: 'Verify existing and new data plus backup recovery before retiring old decryption material. Retained keys require protected custody.' },
    closureStage(['verify-recovery']),
  ] : [
    { id: 'review', status: 'required', dependsOn: [], message: 'Identify whether the application uses this value for sessions, signing, encryption or another purpose. Review session invalidation and data consequences before changing generation.' },
    trustStage(),
    { id: 'generation', status: 'blocked', dependsOn: ['review', 'trust-destinations'], message: 'Review a generation change through hv_spec, then authorize the exact hv_plan/hv_apply replacement. One declaration may change intent for multiple environments; values remain environment-separated.' },
    { id: 'rollout', status: 'blocked', dependsOn: ['generation'], message: 'Deploy every declared consumer and verify the exact running configuration. Never infer runtime use from a saved secret.' },
    { id: 'verify-consumers', status: 'blocked', dependsOn: ['rollout'], message: 'Verify application behavior on every consumer using the replacement; generic health is insufficient.' },
    { id: 'verify-invalidation', status: 'blocked', dependsOn: ['verify-consumers'], message: 'Verify application-specific rejection of compromised signatures or sessions, including old-key fallback and cached sessions. Encryption requires a separate rewrap workflow.' },
    closureStage(['verify-consumers', 'verify-invalidation']),
  ];
}

function runtimeDestinations(spec: ProjectSpec, environment: string, names?: string[]): ProjectRotationDestination[] {
  const services = spec.environments[environment]?.services ?? {};
  return unique(names ?? Object.keys(services)).map(service => ({ kind: 'runtime', environment, service,
    ...(services[service] ? { workloadKind: services[service].workloadKind } : {}) }));
}

function connectionSelection(spec: ProjectSpec, project: RotationProject) {
  const scopesByProvider = new Map<string, Set<string>>();
  const repositoryScopes = getProjectScopeHints({ gitRemoteUrl: spec.gitRemoteUrl ?? project.gitRemoteUrl } as Project);
  const add = (provider: string, extraScopes: string[] = []) => providerRegistry.connectionProviders(provider).forEach(name => {
    const scopes = scopesByProvider.get(name) ?? new Set(repositoryScopes);
    extraScopes.forEach(scope => scopes.add(scope));
    scopesByProvider.set(name, scopes);
  });
  const devops = resolveDevOpsSelection(spec);
  if (devops) add(devops.code.provider, [devops.code.scope]);
  for (const action of Object.values(spec.github?.actions ?? {})) {
    if ('agent' in action) add(action.agent.provider, devops ? [devops.code.scope] : []);
  }
  for (const [environment, desired] of sorted(spec.environments)) {
    add(desired.hosting.provider);
    if (desired.database) add(desired.database.provider);
    if (desired.cache) add(desired.cache.provider);
    for (const resource of Object.values(desired.storage ?? {})) add(resource.provider);
    if (desired.loadBalancer) add(desired.loadBalancer.provider);
    if (desired.domain) add('cloudflare', cloudflareScopeHintsForDomain(desired.domain));
    if (desired.email.enabled) add('sendgrid');
    if (desired.messaging) add(desired.messaging.provider);
    if (desired.payments?.stripe) add('stripe', [desired.payments.stripe.environment ?? environment]);
    if (desired.ios) add('appstoreconnect', [desired.ios.bundleId]);
  }
  return scopesByProvider;
}

/** Candidate selection only; even an exact match does not establish credential use or ownership. */
export function applicableRotationConnections(
  spec: ProjectSpec,
  project: RotationProject,
  connections: ProjectRotationConnection[]
): ProjectRotationConnection[] {
  const scopesByProvider = connectionSelection(spec, project);
  return connections.filter(connection => {
    const scopes = scopesByProvider.get(connection.provider);
    if (!scopes) return false;
    const scope = connection.scope?.trim();
    return !scope || scope.toLowerCase() === 'global' || scopes.has(scope)
      || scope.endsWith('/*') && [...scopes].some(hint => hint.startsWith(scope.slice(0, -1)));
  }).map(({ id, provider, scope, status }) => ({ id, provider,
    scope: !scope?.trim() || scope.trim().toLowerCase() === 'global' ? null : scope.trim(),
    status: ['verified', 'pending', 'failed'].includes(status) ? status : 'unknown',
  })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Build a value-free assessment from declarations and explicitly supplied local metadata.
 * Does not load files, resolve values, derive keys, observe providers or persist state. */
export function buildProjectRotationAssessment(input: ProjectRotationInput): ProjectRotationAssessment {
  const { spec, mode } = input;
  const inventory: ProjectRotationEntry[] = [];
  const blockers: ProjectRotationBlocker[] = [
    blocker('live_inventory_unchecked', 'Live provider configuration, issuer identities and credential validity have not been inspected.'),
    blocker('unmanaged_consumers_unchecked', 'Undeclared services, local files, external workflows and consumers outside Hypervibe remain unchecked.'),
    blocker('secret_source_credentials_unchecked', 'Credential-source access and secret-manager identities are unchecked. This assessment does not read source references, values or manager scopes; review source credentials and all shared consumers separately.'),
    outsideConsumers(),
  ];
  const recorded = new Set(input.recordedEnvironments.map(environment => environment.name));
  const devops = resolveDevOpsSelection(spec);
  const repository = devops?.code.scope;
  const ciDestination = (environment?: string): ProjectRotationDestination => ({
    kind: devops?.ci?.provider === 'github-actions' ? environment ? 'github-environment' : 'github-repository' : 'ci',
    ...(repository ? { repository } : {}), ...(environment ? { environment } : {}),
  });
  const add = (entry: Omit<ProjectRotationEntry, 'stages'> & { stages?: ProjectRotationStage[] }) => {
    inventory.push({ ...entry, keys: unique(entry.keys), stages: entry.stages ?? projectRotationStages(mode) });
  };
  const obligation = (category: ProjectRotationEntry['category'], environment: string | undefined,
    resource: string, provider?: string, destinations?: ProjectRotationDestination[], keys: string[] = []) => add({
    id: id(category, environment ?? 'project', resource), category, ownership: 'provider', keys,
    ...(provider ? { provider } : {}),
    destinations: destinations ?? [{ kind: 'resource', resource, ...(environment ? { environment } : {}) }],
    blockers: [identityUnknown(), outsideConsumers(), unsupportedIssuer()],
  });

  for (const [key, slot] of sorted(spec.secrets)) {
    const generated = slot.ownership === 'hypervibe';
    const slotBlockers = generated
      ? [blocker(slot.replacementPolicy === 'immutable' ? 'rewrap_required' : 'application_effect_unknown',
        slot.replacementPolicy === 'immutable' ? 'Immutable values require an explicit credential rewrap workflow; in-place replacement is forbidden.'
          : 'A generated value has no declared application purpose. Review encryption and session consequences before requesting replacement.')]
      : [blocker('issuer_unknown', 'The delegated declaration names a responsible principal, not the issuer or exact credential identity.'),
        outsideConsumers(), unsupportedIssuer()];
    const base = { category: generated ? 'generated-secret' as const : 'delegated-secret' as const,
      ownership: slot.ownership, keys: [key], blockers: slotBlockers,
      ...(generated ? { generation: slot.generation, ...(slot.replacementPolicy ? { replacementPolicy: slot.replacementPolicy } : {}) }
        : { principal: slot.principal }),
      ...(generated ? { stages: generatedStages(slot.replacementPolicy === 'immutable') } : {}) };
    for (const environment of unique(slot.environments)) {
      const destinations = runtimeDestinations(spec, environment);
      add({ ...base, id: id('secret', 'runtime', environment, key), destinations,
        blockers: [...slotBlockers, ...(!destinations.length ? [blocker('runtime_consumers_unknown', 'No declared runtime services establish this slot’s actual consumers.')] : [])] });
    }
    if (!generated) {
      if (slot.githubActions?.repository) add({ ...base, id: id('secret', 'github-repository', key),
        destinations: [{ kind: 'github-repository', ...(repository ? { repository } : {}) }] });
      for (const environment of unique(slot.githubActions?.environments ?? [])) add({ ...base,
        id: id('secret', 'github-environment', environment, key),
        destinations: [{ kind: 'github-environment', environment, ...(repository ? { repository } : {}) }] });
    }
  }

  for (const [environment, desired] of sorted(spec.environments)) {
    if (!recorded.has(environment)) blockers.push({ ...blocker('environment_unrecorded',
      'This declared environment has no supplied local environment record; its deployed identity and consumers are unknown.'), environment });
    const runtime = runtimeDestinations(spec, environment);
    const managedKeys = new Set(Object.entries(spec.secrets).filter(([, slot]) => slot.environments.includes(environment)).map(([key]) => key));
    const names = unique([...Object.keys(desired.envVars),
      ...(desired.envFile?.mode !== 'off' ? desired.envFile?.include.filter(key => !desired.envFile?.exclude.includes(key)) ?? [] : [])]);
    for (const key of names.filter(key => !managedKeys.has(key))) add({
      id: id('configuration', environment, key), category: 'configuration', ownership: 'unclassified', keys: [key], destinations: runtime,
      blockers: [blocker('configuration_unclassified', 'A declared configuration name does not prove a credential or its issuer. Classify this key without exposing its value.'), outsideConsumers()],
      stages: [{ id: 'review', status: 'required', dependsOn: [], message: 'Determine whether this name holds public configuration or credential material and identify its issuer, purpose and consumers.' }],
    });
    if (!desired.envFile || ['runtime', 'all'].includes(desired.envFile.mode)) blockers.push({
      ...blocker('dotenv_inventory_unchecked', 'Runtime dotenv input may contain additional keys; this assessment does not read private files.'), environment });
    obligation('integration', environment, 'hosting-control-plane', desired.hosting.provider);
    if (desired.database) obligation('database', environment, desired.database.engine, desired.database.provider, runtime);
    if (desired.cache) obligation('cache', environment, desired.cache.engine, desired.cache.provider, runtime);
    for (const [name, resource] of sorted(desired.storage ?? {})) obligation('storage', environment, name, resource.provider,
      [{ kind: 'resource', environment, resource: name }, ...runtimeDestinations(spec, environment, resource.injectInto)]);
    if (desired.email.enabled) obligation('integration', environment, 'email', 'sendgrid', runtime);
    if (desired.messaging) obligation('integration', environment, 'messaging', desired.messaging.provider,
      runtimeDestinations(spec, environment, desired.messaging.services));
    if (desired.domain) obligation('integration', environment, 'dns', 'cloudflare');
    if (desired.loadBalancer) obligation('integration', environment, 'load-balancer', desired.loadBalancer.provider);
    const stripe = desired.payments?.stripe;
    if (stripe) {
      obligation('integration', environment, 'payments', 'stripe', runtimeDestinations(spec, environment, stripe.services),
        stripe.credentials ? [stripe.credentials.secretKeyEnvVar] : []);
      for (const [name, webhook] of sorted(stripe.webhooks)) obligation('integration', environment, `webhook:${name}`, 'stripe',
        runtimeDestinations(spec, environment, [webhook.service]), [webhook.envVar]);
    }
    if (desired.deploy?.strategy === 'branch' && desired.deploy.trigger !== 'native') {
      const ci = providerRegistry.getMetadata(desired.hosting.provider)?.orchestration?.ci;
      obligation('ci', environment, 'deploy', devops?.ci?.provider, [ciDestination(environment)], ci?.requiredSecrets ?? []);
      obligation('registry', environment, 'image-build-and-pull', desired.hosting.provider, [ciDestination(environment), ...runtime]);
    }
    if (desired.ios) {
      const release = desired.ios.release;
      const buildsHere = release && !release.promoteFrom;
      obligation('signing', environment, 'app-store-publishing', 'appstoreconnect',
        buildsHere ? [ciDestination(environment)] : [{ kind: 'resource', environment, resource: desired.ios.bundleId }],
        buildsHere ? appStoreReleaseSecretNames : []);
      if (buildsHere) obligation('signing', environment, `ios-signing:${release.signing.provider}`,
        undefined, [ciDestination(environment)], [...release.build.requiredSecrets,
          ...(release.signing.provider === 'match' ? matchSigningSecretNames : [])]);
    }
  }
  if (devops?.ci) obligation('ci', undefined, 'workflow-and-package-credentials', devops.ci.provider, [ciDestination()]);
  for (const [name, action] of sorted(spec.github?.actions ?? {})) {
    if ('agent' in action) obligation('integration', undefined, `github-action:${name}`, action.agent.provider,
      [{ kind: 'github-repository', ...(repository ? { repository } : {}), resource: `github-action:${name}` }], ['OPENAI_API_KEY']);
  }

  for (const environment of unique([...Object.keys(spec.environments), ...recorded])) {
    if (!spec.environments[environment]) blockers.push({ ...blocker('retained_environment_unchecked',
      'A recorded environment is omitted from desired state; retained workloads and credentials remain unchecked.'), environment });
    add({ id: id('retained', environment), category: 'retained-resources', ownership: 'unknown', keys: [],
      destinations: [{ kind: 'resource', environment, resource: 'retained-resources' }],
      blockers: [blocker('retained_resources_unchecked', 'Retained resources, old deployments, backups and abandoned-provider credentials require exact-identity inspection; omission does not prove removal.'), outsideConsumers()],
      stages: [{ id: 'review', status: 'required', dependsOn: [], message: 'Inspect retained and abandoned resources without adopting or deleting them. Include surviving credential consumers in the reviewed rotation scope.' }],
    });
  }
  for (const connection of applicableRotationConnections(spec, input.project, input.connections)) add({
    id: id('connection', connection.id), category: 'connection', ownership: 'unknown', keys: [], provider: connection.provider, connection,
    destinations: [{ kind: 'connection', scope: connection.scope }],
    blockers: [blocker('connection_usage_unverified', 'This local connection is a selection candidate only. Stored verification does not prove current validity, deployment, exposure or project ownership.'),
      ...(!connection.scope || connection.scope.endsWith('/*') ? [blocker('shared_scope_review_required', 'This global or wildcard connection may serve other projects. Review its full issuer scope and consumers before revocation.')] : []),
      outsideConsumers(), identityUnknown(), unsupportedIssuer()],
  });
  return {
    version: 1, project: { id: input.project.id, name: input.project.name }, specRevision: input.specRevision, mode,
    status: 'review_required', rotationPerformed: false, executable: false,
    coverage: { basis: 'recorded_desired_state', live: 'unchecked', unmanaged: 'unchecked', outsideConsumers: 'unchecked', complete: false },
    inventory: inventory.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), blockers, process: projectRotationStages(mode),
  };
}

import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationDriver, type CloudInstallationEvidence,
  type CloudInstallationProviderContext, type OperatorApplicationIntent } from '../ports/cloud-installation.port.js';
import type { OperatorApplicationLocalContext } from '../ports/operator-application.port.js';
import { operatorOutputSelectionSchema } from '../ports/operator-output.port.js';
import { runtimeSecretReferenceSchema } from '../ports/secret-destination.port.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { SpecStore } from '../spec/spec.store.js';
import { OperatorCredentialCustody } from './operator-credential-custody.js';
import { assertReadySecretContainers } from './secret-container-setup.js';
type Intent = OperatorApplicationIntent;
type Context = CloudInstallationProviderContext<Intent>;
const operation = 'operator-output';
function fail(): never { throw new CloudInstallationBoundaryError('identity_mismatch'); }
function outputs(intent: Intent) { return intent.outputs ? operatorOutputSelectionSchema.parse(intent.outputs) : undefined; }
function actions(intent: Intent, dependencies: string[]): CloudInstallationAction[] {
  return [...outputs(intent)?.destinations ?? []].sort((a, b) => a.role.localeCompare(b.role)).map(({ role, key }) => ({
    id: `${intent.applicationProvider}:${intent.nativeScope.name}:output:${key}`, type: 'create',
    resource: { kind: 'secret', provider: intent.applicationProvider, name: key }, verified: true, requiresConfirm: true, dataBearing: true, billable: true,
    ...(dependencies.length ? { dependsOn: dependencies } : {}), reason: `Deliver the private operator ${role} only to its verified empty secret container; retain its immutable reference.`,
    metadata: { operation, category: 'secret-container', execution: 'api', native: { role, key } },
  }));
}
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.literal('operator-output'), id: z.string().min(1).max(2048),
  identity: z.object({ role: z.string(), key: z.string(), reference: z.string().max(2048), createTime: z.string(), encoding: z.literal('base64').optional() }).strict() }).strict()).length(1),
  native: z.object({ operation: z.literal(operation), installationId: z.string().guid(), attemptId: z.string().guid() }).strict(),
}).strict();
export function parseOperatorOutputEvidence(value: unknown, intent: Intent): CloudInstallationEvidence {
  const parsed = evidenceSchema.parse(value), resource = parsed.resources[0], target = outputs(intent)?.destinations.find(item => item.role === resource.identity.role);
  const reference = runtimeSecretReferenceSchema.parse(JSON.parse(resource.identity.reference));
  if (!target || target.key !== resource.identity.key || target.binding.resource !== resource.id || target.binding.createTime !== resource.identity.createTime
    || resource.identity.encoding !== target.encoding || !isDeepStrictEqual(reference.destination, target.binding.destination) || parsed.native.installationId !== intent.installationId) fail();
  return parsed;
}
export function operatorOutputReceipts(completed: Record<string, CloudInstallationEvidence>, intent: Intent): Array<Record<string, string>> {
  return Object.values(completed).filter(item => item.native.operation === operation)
    .map(item => ({ ...parseOperatorOutputEvidence(item, intent).resources[0].identity }));
}
/** Private GitHub App metadata verification only; no command exposes this read. */
export async function readGithubOperatorSigningKey(intent: Intent, local: OperatorApplicationLocalContext, signal: AbortSignal): Promise<string> {
  if (intent.applicationProvider !== 'github-app' || intent.appId !== local.projectId || intent.installationId !== local.installationId
    || canonicalJsonSha256(intent) !== local.intentDigest) fail();
  const selected = outputs(intent), target = selected?.destinations.find(item => item.role === 'private-key');
  if (!selected || target?.verificationPurpose !== 'github-app-signing-key') fail();
  const store = new OperatorCredentialCustody({ ...local, provider: 'github-app' }), retained = store.read();
  const delivery = retained?.state.deliveries?.[target.key];
  if (retained?.state.phase !== 'delivered' || delivery?.status !== 'delivered' || !delivery.reference
    || !isDeepStrictEqual(delivery.reference.destination, target.binding.destination)) fail();
  const authorize = async () => {
    if (!await local.authorizeCurrent?.()) fail();
    const project = new ProjectRepository().findById(local.projectId), environment = new EnvironmentRepository().findById(local.environmentId);
    const spec = project && new SpecStore().getForInspection(project)?.spec;
    if (!project || !environment || !spec || environment.projectId !== project.id || environment.name !== intent.environment
      || spec.environments[environment.name]?.hosting.provider !== selected.hostingProvider) fail();
    const current = await assertReadySecretContainers({ project, environment, spec, keys: [target.key] });
    if (!isDeepStrictEqual(current[target.key], target.binding) || !await local.authorizeCurrent?.()) fail();
  };
  await authorize();
  const capability = providerRegistry.getOperatorOutputDelivery(selected.hostingProvider);
  if (!capability || !capability.providers.includes(target.binding.destination.provider)) fail();
  const client = await capability.create(target.binding); if (!client.readGithubSigningKey) fail();
  const value = await client.readGithubSigningKey(delivery.reference, signal, authorize);
  if (target.encoding !== 'base64') fail();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'base64')); } catch { fail(); }
}
/** Adds separate reviewed deliveries to a native operator registration. Never replays a value write. */
export function withOperatorOutputDelivery(native: CloudInstallationDriver<Intent>, local?: OperatorApplicationLocalContext,
  dependencies: (intent: Intent) => string[] = () => []): CloudInstallationDriver<Intent> {
  function custody(intent: Intent) {
    if (!local || local.projectId !== intent.appId || local.installationId !== intent.installationId || local.intentDigest !== canonicalJsonSha256(intent)
      || !['github-app', 'google-oauth', 'google-recaptcha', 'sendgrid'].includes(intent.applicationProvider)) fail();
    return new OperatorCredentialCustody({ ...local, provider: intent.applicationProvider as 'github-app' | 'google-oauth' | 'google-recaptcha' | 'sendgrid' });
  }
  async function selection(intent: Intent) {
    if (!local) fail();
    const project = new ProjectRepository().findById(local.projectId), environment = new EnvironmentRepository().findById(local.environmentId);
    const spec = project && new SpecStore().getForInspection(project)?.spec, desired = outputs(intent);
    if (!project || !environment || !spec || !desired || environment.projectId !== project.id || environment.name !== intent.environment
      || spec.environments[environment.name]?.hosting.provider !== desired.hostingProvider) fail();
    const current = await assertReadySecretContainers({ project, environment, spec, keys: Object.values(desired.destinations).map(item => item.key) });
    if (Object.values(desired.destinations).some(item => !isDeepStrictEqual(current[item.key], item.binding))) fail();
    const capability = providerRegistry.getOperatorOutputDelivery(desired.hostingProvider);
    if (!capability || Object.values(desired.destinations).some(item => !capability.providers.includes(item.binding.destination.provider))) fail();
    return { desired, capability };
  }
  async function inspect(context: Context & { action: CloudInstallationAction }, retryInspection = false) {
    try {
      const action = actions(context.intent, dependencies(context.intent)).find(item => isDeepStrictEqual(item, context.action)); if (!action) fail();
      const role = String(action.metadata.native.role), { desired, capability } = await selection(context.intent), target = desired.destinations.find(item => item.role === role)!;
      const store = custody(context.intent), snapshot = store.read(), delivery = snapshot?.state.deliveries?.[target.key];
      if (snapshot && delivery?.status === 'delivered' && delivery.reference) {
        const client = await capability.create(target.binding); await client.verifyReference(delivery.reference, context.signal);
        const keys = desired.destinations.map(item => item.key);
        if (snapshot.state.phase === 'credentials-stored' && keys.every(key => snapshot.state.deliveries?.[key]?.status === 'delivered')) {
          for (const item of desired.destinations) {
            const receipt = snapshot.state.deliveries![item.key]; if (!receipt.reference) fail();
            await (await capability.create(item.binding)).verifyReference(receipt.reference, context.signal);
          }
          if (!store.eraseDeliveredCredentials(snapshot, keys) && store.read()?.state.phase !== 'delivered') fail();
        }
        const evidence = parseOperatorOutputEvidence({ resources: [{ kind: operation, id: target.binding.resource,
          identity: { role, key: target.key, reference: JSON.stringify(delivery.reference), createTime: target.binding.createTime, ...(target.encoding ? { encoding: target.encoding } : {}) } }],
          native: { operation, installationId: context.intent.installationId, attemptId: delivery.attemptId } }, context.intent);
        return { state: 'satisfied' as const, evidence };
      }
      if (delivery) {
        if (retryInspection && delivery.status === 'rejected' && context.attempts?.some(item => item.id === delivery.attemptId && item.actionId === action.id && item.status === 'rejected'))
          return { state: 'action-required' as const };
        return { state: delivery.status === 'rejected' ? 'rejected' as const : 'unknown' as const, reason: 'not_converged' as const };
      }
      return snapshot?.state.phase === 'credentials-stored' && snapshot.state.credentials?.[role]
        ? { state: 'action-required' as const } : { state: 'pending' as const, reason: 'not_converged' as const };
    } catch { return { state: 'unknown' as const, reason: 'identity_mismatch' as const }; }
  }
  return { ...native,
    parseAction(value, intent) {
      const selected = actions(intent, dependencies(intent)).find(item => isDeepStrictEqual(item, value));
      return selected ?? native.parseAction(value, intent);
    },
    parseEvidence(value, intent) {
      return value && typeof value === 'object' && (value as any).native?.operation === operation
        ? parseOperatorOutputEvidence(value, intent) : native.parseEvidence(value, intent);
    },
    async plan(context) {
      const plan = await native.plan(context), targets = outputs(context.intent);
      if (!targets) return plan;
      const { capability } = await selection(context.intent), reviews = Object.values(targets.destinations).map(item => ({ target: item, review: capability.review(item.binding, item.verificationPurpose) }));
      return { ...plan, actions: [...plan.actions, ...actions(context.intent, dependencies(context.intent))], review: { ...plan.review,
        resources: [...plan.review.resources ?? [], ...Object.values(targets.destinations).map(item => ({ kind: 'operator-secret-version', name: item.key, scope: item.binding.resource! }))],
        permissions: [...plan.review.permissions, ...reviews.map(({ target, review }) => ({ principal: 'current transient local operator', scope: target.binding.resource!, actions: review.permissions, purpose: 'writer' as const }))],
        costs: [...plan.review.costs, ...reviews.map(({ target, review }) => ({ resource: target.binding.resource!, description: review.cost, pricingUrl: review.pricingUrl }))],
        warnings: [...plan.review.warnings, 'Private operator credentials remain encrypted locally until every selected native delivery receipt is durable. No secret value enters the public journal.',
          'A lost Secret Manager add-version acknowledgement cannot be correlated or automatically retried. Existing observed versions block first delivery; this API has no empty-container compare-and-set.'],
      } };
    },
    inspect: context => context.action.metadata.operation === operation ? inspect(context, true) : native.inspect(context),
    recover: context => context.action.metadata.operation === operation ? inspect(context) : native.recover(context),
    async mutate(context) {
      if (context.action.metadata.operation !== operation) return native.mutate(context);
      let claimed = false;
      try {
        const action = actions(context.intent, dependencies(context.intent)).find(item => isDeepStrictEqual(item, context.action));
        if (!action || dependencies(context.intent).some(id => !context.completed[id])) fail();
        const role = String(action.metadata.native.role), { desired, capability } = await selection(context.intent), target = desired.destinations.find(item => item.role === role)!;
        const store = custody(context.intent); let snapshot = store.read();
        if (!snapshot || snapshot.state.phase !== 'credentials-stored' || !snapshot.state.credentials?.[role]) fail();
        const previous = snapshot.state.deliveries?.[target.key];
        if (previous && (previous.status !== 'rejected' || previous.attemptId === context.attempt.id
          || !context.attempts?.some(item => item.id === previous.attemptId && item.actionId === action.id && item.status === 'rejected'))) fail();
        const raw = snapshot.state.credentials[role], value = target.encoding === 'base64' ? Buffer.from(raw, 'utf8').toString('base64') : raw,
          client = await capability.create(target.binding);
        await context.beforeMutation();
        snapshot = store.updateDelivery(snapshot, target.key, { attemptId: context.attempt.id, status: 'attempted' }); if (!snapshot) fail(); claimed = true;
        const result = await client.driver.deliver({ attemptId: context.attempt.id, destination: target.binding.destination,
          context: { accountId: context.intent.customerId, repository: context.intent.source.repository.split('/').slice(-2).join('/'), environment: context.intent.environment,
            key: target.key, sourceRevision: context.intent.source.specDigest, sourceDigest: canonicalJsonSha256(context.intent) } }, value,
          { signal: context.signal, beforeWrite: async () => { await selection(context.intent); await context.beforeMutation(); } });
        const retained = store.updateDelivery(snapshot, target.key, { attemptId: context.attempt.id,
          status: result.status === 'delivered' ? 'delivered' : result.status === 'rejected' ? 'rejected' : 'uncertain',
          ...(result.status === 'delivered' ? { reference: result.reference } : {}) });
        if (!retained || result.status !== 'delivered') return { state: retained && result.status === 'rejected' ? 'rejected' : 'uncertain', reason: 'not_converged' };
        const verified = await inspect(context);
        return verified.state === 'satisfied' ? { state: 'acknowledged', evidence: verified.evidence } : { state: 'uncertain', reason: 'not_converged' };
      } catch { return { state: claimed ? 'uncertain' : 'rejected', reason: 'identity_mismatch' }; }
    },
  };
}

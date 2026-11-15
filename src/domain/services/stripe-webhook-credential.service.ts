import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Project } from '../entities/project.entity.js';
import type { CredentialTracking } from '../spec/credential.schema.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import type { CredentialValidation } from '../registry/credential-validation.registry.js';
import { hashEnvValue } from '../ports/observe.port.js';
import { getStripeAdapter } from './stripe-ops.service.js';
import { parseStripeBindings, stripeEnvironmentName } from './stripe-env.service.js';
import { resolveSecretValueRef } from './secret-value-ref.js';

export interface StripeWebhookCredentialEndpoint {
  environmentId: string;
  environment: string;
  stripeEnvironment: string;
  name: string;
  endpointId: string;
  accountId: string;
  mode: 'test' | 'live';
  url: string;
  service: string;
  envVar: string;
  events: string[];
}
type Input = { project: Project; spec: ProjectSpec; descriptor: CredentialTracking; value: string };
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function inspect(input: Omit<Input, 'value'>): Promise<StripeWebhookCredentialEndpoint> {
  const selection = input.descriptor.stripeWebhook;
  const identity = input.descriptor.identity;
  if (input.descriptor.kind !== 'stripe-webhook' || !selection || !identity?.mode || !identity.endpointId || !identity.accountId) {
    throw new Error('Declare the exact Stripe webhook environment/name, account or sandbox, mode and endpoint ID before rotating its signing secret.');
  }
  const environment = new EnvironmentRepository().findByProjectAndName(input.project.id, selection.environment);
  const envSpec = input.spec.environments[selection.environment];
  const stripeSpec = envSpec?.payments?.stripe;
  const webhook = stripeSpec?.webhooks[selection.webhook];
  const bindings = parseStripeBindings(environment);
  const binding = bindings.webhooks[selection.webhook];
  if (!environment || !stripeSpec || !webhook || !binding || binding.endpointId !== identity.endpointId
    || binding.url !== webhook.url || binding.service !== webhook.service || binding.envVar !== webhook.envVar
    || !isDeepStrictEqual([...binding.events].sort(), [...webhook.events].sort())) {
    throw new Error('The declared Stripe webhook does not match its exact existing endpoint binding. Review that identity first.');
  }
  const slot = input.spec.secrets[webhook.envVar];
  if (!slot || slot.ownership !== 'delegated' || slot.credential?.role !== input.descriptor.role || !slot.environments.includes(selection.environment)) {
    throw new Error('The credential role must include the exact webhook signing-variable consumer.');
  }
  for (const [key, candidate] of Object.entries(input.spec.secrets).filter(([, candidate]) => candidate.credential?.role === input.descriptor.role)) {
    if (candidate.environments.some(name => name !== selection.environment) || candidate.environments.length && key !== webhook.envVar) {
      throw new Error('A webhook signing secret is bound to its exact endpoint and service; unrelated runtime consumers require a separate role.');
    }
  }
  const stripeEnvironment = stripeEnvironmentName(selection.environment, stripeSpec);
  if (bindings.environment && bindings.environment !== stripeEnvironment) throw new Error('The Stripe environment binding changed; account identity must be reviewed.');
  const connection = getStripeAdapter(stripeEnvironment, { verifiedOnly: true });
  if ('error' in connection) throw new Error('A verified connection for the exact Stripe environment is required.');
  let observed: Awaited<ReturnType<typeof connection.adapter.inspectWebhookCredential>>;
  try { observed = await connection.adapter.inspectWebhookCredential(connection.mode, identity.endpointId); }
  catch { throw new Error('The exact Stripe account and webhook endpoint identity could not be verified.'); }
  const accountId = identity.sandboxId ?? identity.accountId;
  if (observed.accountId !== accountId || observed.livemode !== (identity.mode === 'live')) throw new Error('Stripe account/sandbox or mode differs from the intended identity.');
  if (observed.endpointId !== identity.endpointId || observed.url !== webhook.url || observed.status !== 'enabled'
    || !isDeepStrictEqual([...observed.events].sort(), [...webhook.events].sort())) throw new Error('Stripe endpoint identity, URL, events or enabled state differs from the reviewed webhook.');
  return { environmentId: environment.id, environment: environment.name, stripeEnvironment, name: selection.webhook,
    endpointId: observed.endpointId, accountId, mode: identity.mode, url: observed.url, service: webhook.service, envVar: webhook.envVar, events: [...observed.events].sort() };
}

async function validateDelivery(input: Input): Promise<CredentialValidation> {
  const selection = input.descriptor.stripeWebhook!;
  const at = new Date().toISOString();
  const common = { at, accountId: input.descriptor.identity!.sandboxId ?? input.descriptor.identity!.accountId, intendedIdentity: input.descriptor.identity, applicationOperation: 'unknown' as const };
  if (!selection.delivery) return { ...common, result: 'unknown', tested: 'Exact Stripe endpoint/account/mode inspected. No supplied signed delivery verifies this signing value.' };
  try {
    const stat = lstatSync(selection.delivery.payloadFile);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error();
    const payload = readFileSync(selection.delivery.payloadFile);
    const header = await resolveSecretValueRef(selection.delivery.signatureRef, { projectId: input.project.id, environmentName: selection.environment });
    if (header.length > 8192) throw new Error();
    const entries = header.split(',').map(part => part.trim().split('='));
    const times = entries.filter(([key]) => key === 't').map(([, value]) => value);
    const signatures = entries.filter(([key]) => key === 'v1').map(([, value]) => value).filter(value => /^[a-fA-F0-9]{64}$/.test(value ?? ''));
    if (times.length !== 1 || !/^\d+$/.test(times[0] ?? '') || signatures.length === 0 || signatures.length > 16) throw new Error();
    const timestamp = Number(times[0]);
    if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) throw new Error();
    const expected = createHmac('sha256', input.value).update(times[0] + '.').update(payload).digest();
    if (!signatures.some(signature => timingSafeEqual(expected, Buffer.from(signature, 'hex')))) throw new Error();
    const event = z.object({ id: z.string().regex(/^evt_[A-Za-z0-9]+$/), object: z.literal('event'), type: z.string().min(1), livemode: z.boolean(), account: z.string().optional() }).parse(JSON.parse(payload.toString('utf8')));
    if (event.livemode !== (input.descriptor.identity!.mode === 'live') || event.account && event.account !== common.accountId) throw new Error();
    return { ...common, result: 'passed', tested: 'Verified the supplied signed delivery using the replacement, with a five-minute timestamp tolerance. Endpoint attribution is user supplied; application processing remains unverified.' };
  } catch { throw new Error('The supplied Stripe delivery signature, raw body, recency or account/mode could not be verified. No signing value was accepted.'); }
}

export async function reviewStripeWebhookCredential(input: Input) {
  if (!/^whsec_[A-Za-z0-9]+$/.test(input.value)) throw new Error('The source must contain the signing secret issued for the exact Stripe webhook endpoint.');
  const endpoint = await inspect(input);
  const validation = await validateDelivery(input);
  return { endpoint, validation, guidance: { managementUrl: 'https://dashboard.stripe.com/webhooks', accountId: endpoint.accountId, mode: endpoint.mode, endpointId: endpoint.endpointId,
    action: 'Select this exact account/sandbox, mode and endpoint in Workbench. Choose Roll secret with an overlap window (up to 24 hours), then save the replacement at the declared private source. Keep the old secret active until every consumer, deployment and application check is covered.' },
    warnings: ['Stripe exposes same-endpoint signing-secret rotation in Workbench; Hypervibe does not delete/recreate the endpoint or revoke its old secret.',
      ...(input.descriptor.stripeWebhook?.userReportedPreviousSecretExpiresAt ? [`User-reported old-secret expiry: ${input.descriptor.stripeWebhook.userReportedPreviousSecretExpiresAt}. This is not provider-confirmed expiry.`] : []),
      'A verified supplied signature proves the replacement validates that delivery. It does not prove the application handled the event or that old instances have drained.'] };
}

export async function revalidateStripeWebhookCredential(input: Omit<Input, 'value'> & { reviewed: StripeWebhookCredentialEndpoint }): Promise<void> {
  if (!isDeepStrictEqual(await inspect(input), input.reviewed)) throw new Error('The exact Stripe webhook consumer changed after review; no credential write is authorized.');
}

/** Called only after the shared credential lifecycle has confirmed every
 * selected consumer. No Stripe mutation; update the existing lifecycle binding
 * so ordinary reconciliation preserves this same endpoint and accepted value. */
export async function acceptStripeWebhookCredential(input: Input & { reviewed: StripeWebhookCredentialEndpoint }): Promise<void> {
  await revalidateStripeWebhookCredential(input);
  const repo = new EnvironmentRepository();
  const environment = repo.findById(input.reviewed.environmentId)!;
  const payments = obj(environment.platformBindings.payments);
  const stripe = obj(payments.stripe);
  const webhooks = obj(stripe.webhooks);
  const binding = obj(webhooks[input.reviewed.name]);
  repo.updatePlatformBindings(environment.id, { payments: { ...payments, stripe: { ...stripe, webhooks: { ...webhooks,
    [input.reviewed.name]: { ...binding, valueHash: hashEnvValue(input.value), updatedAt: new Date().toISOString() },
  } } } });
}

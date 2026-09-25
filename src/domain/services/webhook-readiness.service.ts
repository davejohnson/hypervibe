import { createHash } from 'node:crypto';
import type { Environment } from '../entities/environment.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { serviceBindingFor } from './spec.service.js';
import type { EventSigningReadiness } from './email-signing.service.js';
import { SENDGRID_EVENT_PUBLIC_KEY } from '../spec/spec.schema.js';

type MaterialStatus = 'present' | 'missing' | 'unknown' | 'not_managed';
interface WebhookCheck {
  provider: 'stripe' | 'twilio' | 'sendgrid';
  name: string;
  service: string;
  https: 'configured' | 'insecure' | 'unknown';
  urlEvidence: 'declared' | 'binding' | 'unavailable';
  providerSigning?: EventSigningReadiness['providerSigning'];
  signingMaterial: { status: MaterialStatus; key?: string; evidence: 'desired' | 'observed' | 'unavailable' };
}
export interface WebhookReadiness {
  status: 'configured' | 'needs_attention' | 'unknown';
  basis: 'configuration-only';
  applicationVerification: 'not_verified';
  webhooks: WebhookCheck[];
  guidance: string;
}
const emptyHash = createHash('sha256').update('').digest('hex');

/** Pure, value-free configuration assessment. No endpoint probes or provider writes. */
export function inspectWebhookReadiness(params: {
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  observed: ObservedState | null;
  runtimeValues?: Record<string, string>;
  eventSigningReadiness?: EventSigningReadiness;
}): WebhookReadiness | undefined {
  const { environmentSpec: spec, environment, observed } = params;
  const values = params.runtimeValues ?? spec.envVars;
  const webhooks: WebhookCheck[] = [];
  const material = (service: string, key?: string): WebhookCheck['signingMaterial'] => {
    if (!key) return { status: 'not_managed', evidence: 'unavailable' };
    if (Object.hasOwn(values, key)) return { key, status: values[key].trim() ? 'present' : 'missing', evidence: 'desired' };
    // Partial reads and masked values do not prove either presence of a usable value or absence.
    if (!observed || observed.partial || observed.completeness?.services === 'unknown') return { key, status: 'unknown', evidence: 'unavailable' };
    const matches = observed.services.filter(item => item.name === service);
    if (matches.length !== 1) return { key, status: 'unknown', evidence: 'unavailable' };
    const live = matches[0];
    if (!live.envVarKeys.includes(key)) return { key, status: 'missing', evidence: 'observed' };
    const hash = live.envVarHashes[key];
    return { key, status: hash === emptyHash ? 'missing' : /^[a-f0-9]{64}$/i.test(hash ?? '') ? 'present' : 'unknown', evidence: 'observed' };
  };
  const add = (provider: WebhookCheck['provider'], name: string, service: string, url: string | undefined,
    urlEvidence: WebhookCheck['urlEvidence'], key?: string) => {
    let https: WebhookCheck['https'] = 'unknown';
    if (url !== undefined) {
      try {
        const parsed = new URL(url);
        https = parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash ? 'configured' : 'insecure';
      } catch { https = 'insecure'; }
    }
    webhooks.push({ provider, name, service, https, urlEvidence, signingMaterial: material(service, key) });
  };
  const boundUrl = (service: string): string | undefined => {
    const url = environment ? serviceBindingFor(environment, service)?.url : undefined;
    return typeof url === 'string' ? url : undefined;
  };
  const addBound = (provider: WebhookCheck['provider'], name: string, target: { service: string; path: string }, key?: string) => {
    const base = boundUrl(target.service);
    let url: string | undefined;
    if (base !== undefined) {
      try { url = new URL(target.path, base).toString(); } catch { url = ''; }
    }
    add(provider, name, target.service, url, base === undefined ? 'unavailable' : 'binding', key);
  };
  const stripe = spec.payments?.stripe;
  for (const [name, webhook] of Object.entries(stripe?.webhooks ?? {})) {
    add('stripe', name, webhook.service, webhook.url, 'declared', webhook.envVar);
  }
  // Exact conventional env roles only. An API key alone does not imply an inbound webhook.
  for (const [service, config] of Object.entries(spec.services)) {
    if (config.workloadKind && config.workloadKind !== 'web') continue;
    if (config.public === false) continue;
    const keys = new Set([...Object.keys(values), ...(observed?.services.filter(item => item.name === service).flatMap(item => item.envVarKeys) ?? [])]);
    const managedConventionalSecret = Object.values(stripe?.webhooks ?? {}).some(webhook => webhook.service === service && webhook.envVar === 'STRIPE_WEBHOOK_SECRET');
    if (!keys.has('STRIPE_WEBHOOK_URL') && (!keys.has('STRIPE_WEBHOOK_SECRET') || managedConventionalSecret)) continue;
    add('stripe', 'environment configuration', service, values.STRIPE_WEBHOOK_URL,
      Object.hasOwn(values, 'STRIPE_WEBHOOK_URL') ? 'declared' : 'unavailable', 'STRIPE_WEBHOOK_SECRET');
  }
  if (spec.messaging) {
    const messaging = spec.messaging.service;
    if (messaging.inbound) addBound('twilio', 'inbound', messaging.inbound, 'TWILIO_AUTH_TOKEN');
    if (messaging.deliveryStatus) addBound('twilio', 'status callback', messaging.deliveryStatus, 'TWILIO_AUTH_TOKEN');
  }
  if (spec.email.enabled) {
    if (spec.email.inbound) addBound('sendgrid', 'inbound parse', spec.email.inbound);
    if (spec.email.deliveryEvents) {
      addBound('sendgrid', 'delivery events', spec.email.deliveryEvents);
      if (spec.email.deliveryEvents.signatureVerification !== undefined) {
        const item = webhooks[webhooks.length - 1];
        const signing = params.eventSigningReadiness;
        item.providerSigning = signing?.providerSigning ?? 'unknown';
        item.signingMaterial = { key: SENDGRID_EVENT_PUBLIC_KEY, evidence: 'observed', status:
          signing?.status === 'configured' && signing.providerSigning === 'enabled' && signing.keyWiring === 'matching' ? 'present'
            : signing?.providerSigning === 'disabled' || signing?.keyWiring === 'missing' || signing?.keyWiring === 'drifted' ? 'missing' : 'unknown' };
      }
    }
  }
  if (!webhooks.length) return undefined;
  return {
    status: webhooks.some(item => item.https === 'insecure' || item.signingMaterial.status === 'missing') ? 'needs_attention'
      : webhooks.some(item => item.https === 'unknown' || ['unknown', 'not_managed'].includes(item.signingMaterial.status)) ? 'unknown' : 'configured',
    basis: 'configuration-only', applicationVerification: 'not_verified', webhooks,
    guidance: 'Use HTTPS and wire verification material to the receiving service through reviewed desired state. Desired values are not proof of deployment; observed presence does not prove the key belongs to this endpoint. Stripe needs its endpoint signing secret; Twilio callbacks need the account auth token. SendGrid delivery-event signing can be managed declaratively; Inbound Parse verification remains unmanaged. Check the app rejects invalid signatures before trusting events. This report does not test delivery, TLS, or application verification, and never rotates credentials or sends test events.',
  };
}

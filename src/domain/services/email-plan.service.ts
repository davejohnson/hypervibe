import type { Environment } from '../entities/environment.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';

export const EMAIL_SETUP_OPERATION = 'emailSetup';

export function planEmailSetup(params: {
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  observed: ObservedState | null;
  dependsOn?: string[];
}): PlanAction | null {
  if (!params.environmentSpec.email.enabled) return null;

  const serviceNames = Object.keys(params.environmentSpec.services).sort();
  const emailBinding = params.environment?.platformBindings.email;
  const emailRecord = emailBinding && typeof emailBinding === 'object' && !Array.isArray(emailBinding)
    ? emailBinding as Record<string, unknown>
    : {};
  const boundServices = Array.isArray(emailRecord.services)
    ? emailRecord.services.filter((value): value is string => typeof value === 'string').sort()
    : [];
  const servicesObservable = params.observed !== null
    && params.observed.completeness?.services !== 'unknown';
  const servicesObservationUnknown = params.observed?.completeness?.services === 'unknown';
  const liveKeyPresent = servicesObservable && serviceNames.every((name) =>
    params.observed?.services
      .find((service) => service.name === name)
      ?.envVarKeys.includes('SENDGRID_API_KEY')
  );
  const bindingMatches = emailRecord.provider === 'sendgrid'
    && emailRecord.enabled === true
    && (emailRecord.domain ?? null) === (params.environmentSpec.domain ?? null)
    && JSON.stringify(boundServices) === JSON.stringify(serviceNames);
  const inSync = liveKeyPresent && bindingMatches;
  const preserveUnknown = !servicesObservable && bindingMatches;

  return {
    id: 'email:sendgrid',
    type: inSync || preserveUnknown ? 'noop' : 'update',
    resource: {
      kind: 'email',
      name: params.environmentSpec.domain ?? params.environmentName,
      provider: 'sendgrid',
    },
    verified: inSync,
    reason: inSync
      ? 'SendGrid runtime key and email setup are in sync'
      : preserveUnknown
        ? 'Preserving locally recorded SendGrid setup because service observation is unknown'
        : 'Configure SendGrid runtime key and sender/domain authentication',
    ...(params.dependsOn?.length ? { dependsOn: [...new Set(params.dependsOn)] } : {}),
    metadata: {
      operation: EMAIL_SETUP_OPERATION,
      services: serviceNames,
      ...(params.environmentSpec.domain ? { domain: params.environmentSpec.domain } : {}),
      ...(servicesObservationUnknown && !bindingMatches
        ? { blockedReason: 'email_observation_unknown' }
        : {}),
    },
  };
}

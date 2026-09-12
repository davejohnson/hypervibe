import { isDeepStrictEqual } from 'node:util';
import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';

/** Compare logical resources, never environment values or provider identity bindings. */
function resources(environment: EnvironmentSpec): Map<string, unknown> {
  const result = new Map<string, unknown>([['hosting', environment.hosting.provider]]);
  for (const [name, service] of Object.entries(environment.services)) {
    result.set(`service:${name}`, {
      kind: service.workloadKind,
      start: service.startCommand,
      release: service.releaseCommand,
      schedule: service.cronSchedule,
      timeZone: service.timeZone,
      public: service.public ?? service.workloadKind === 'web',
      healthCheck: service.healthCheckPath,
    });
  }
  for (const kind of ['database', 'cache'] as const) {
    const resource = environment[kind];
    if (resource) result.set(kind, { provider: resource.provider, engine: resource.engine });
  }
  for (const [name, bucket] of Object.entries(environment.storage ?? {})) {
    result.set(`storage:${name}`, { provider: bucket.provider, type: bucket.type, services: [...bucket.injectInto].sort() });
  }
  for (const [name, queue] of Object.entries(environment.queues ?? {})) result.set(`queue:${name}`, queue);
  if (environment.domain) result.set('custom-domain', true);
  if (environment.loadBalancer) result.set('load-balancer', {
    provider: environment.loadBalancer.provider, services: [...environment.loadBalancer.services].sort(),
  });
  if (environment.email.enabled) {
    result.set('email', true);
    for (const kind of ['inbound', 'deliveryEvents', 'forwarding'] as const) {
      if (environment.email[kind]) result.set(`email:${kind}`, true);
    }
  }
  if (environment.messaging) {
    result.set('messaging', { provider: environment.messaging.provider, services: [...environment.messaging.services].sort() });
    if (environment.messaging.sender) result.set('messaging:sender', true);
    for (const kind of ['inbound', 'deliveryStatus'] as const) {
      if (environment.messaging.service[kind]) result.set(`messaging:${kind}`, true);
    }
  }
  for (const [name, payment] of Object.entries(environment.payments ?? {})) {
    if (payment) result.set(`payments:${name}`, true);
  }
  if (environment.ios) result.set('ios', true);
  return result;
}

export function environmentResourceWarnings(spec: ProjectSpec, selectedEnvironment?: string): string[] {
  const environments = Object.entries(spec.environments)
    .filter(([name]) => !['local', 'repository'].includes(name.trim().toLowerCase()))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, environment]) => ({ name, resources: resources(environment) }));
  const warnings: string[] = [];
  for (const [index, left] of environments.entries()) {
    for (const right of environments.slice(index + 1)) {
      if (selectedEnvironment && left.name !== selectedEnvironment && right.name !== selectedEnvironment) continue;
      const onlyLeft = [...left.resources.keys()].filter((key) => !right.resources.has(key)).sort();
      const onlyRight = [...right.resources.keys()].filter((key) => !left.resources.has(key)).sort();
      const changed = [...left.resources.keys()].filter((key) => right.resources.has(key)
        && !isDeepStrictEqual(left.resources.get(key), right.resources.get(key))).sort();
      const differences = [
        ...(onlyLeft.length ? [`only in "${left.name}": ${onlyLeft.join(', ')}`] : []),
        ...(onlyRight.length ? [`only in "${right.name}": ${onlyRight.join(', ')}`] : []),
        ...(changed.length ? [`different definitions: ${changed.join(', ')}`] : []),
      ];
      if (differences.length) warnings.push(
        `Environments "${left.name}" and "${right.name}" may behave differently (${differences.join('; ')}). This compares declared resources, not live state. Review whether these differences are intentional before relying on one environment to test another; this warning does not copy or change resources.`
      );
    }
  }
  return warnings;
}

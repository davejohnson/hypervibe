import type { PlanAction } from './plan.types.js';
import type { ProjectSpec } from '../spec/spec.schema.js';

/** Make gaps in the enrolled environment visible beside the changes a user approves. */
export function runtimeMonitoringCoverage(spec: ProjectSpec, environmentName: string, actions: PlanAction[]): string[] {
  const env = spec.environments[environmentName];
  if (!env?.runtimeObservation) return [];
  const gaps: string[] = [];
  if (env.hosting.provider === 'cloudrun' && env.database?.placement === 'app') gaps.push('CPU usage attributable to a single tenant on the shared Cloud SQL instance');
  if (env.cache && env.hosting.provider !== 'cloudrun') gaps.push('the cache');
  if (Object.keys(env.queues ?? {}).length && env.hosting.provider !== 'cloudrun') gaps.push('message queues');
  if (env.domain || env.domains?.length || env.dns || env.domainRegistration) gaps.push('custom domains and DNS');
  if (env.email.enabled) gaps.push('email delivery');
  if (Object.keys(env.webhooks ?? {}).length) gaps.push('webhooks');
  if (env.payments) gaps.push('payments integrations');
  if (env.backups?.mode === 'daily' || Object.values(env.storage ?? {}).some(bucket => bucket.automatedBackups)) gaps.push('backup completion');
  if (env.ios) gaps.push('iOS distribution');
  const support = new Set<string>();
  for (const { id, resource, type } of actions) {
    if (type === 'destroy' || id.startsWith('monitor:')) continue;
    const category = id.split(':')[0];
    if (category === 'identity' || category === 'iam') support.add('identities and access grants');
    else if (category === 'registry' || category === 'builds' || id === 'shared:registry' || resource.kind === 'ci') support.add('the image build and registry');
    else if (category === 'network' || ['environment:base', 'shared:apps', 'shared:network'].includes(id)) support.add('the base network and environment');
    else if (resource.kind === 'secret') support.add('secrets');
    else if (resource.kind === 'volume') support.add('persistent volumes');
    else if (resource.kind === 'maintenance') support.add('maintenance operations');
    else if (resource.kind === 'retained-resource') support.add('retained resources');
    else if (resource.kind === 'repo') support.add('the source repository');
    else if (!['database', 'storage', 'cache', 'queue'].includes(resource.kind)
      && !(resource.kind === 'service' && Object.hasOwn(env.services, resource.name))) {
      support.add(resource.name);
    }
  }
  for (const name of support) if (!gaps.includes(name)) gaps.push(name);
  return gaps.length ? ['Runtime monitoring has no dedicated health signal for ' + gaps.join(', ') + '.'] : [];
}

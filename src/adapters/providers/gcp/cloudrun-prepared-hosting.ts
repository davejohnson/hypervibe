import type { CloudDeploymentConnectionV1, CloudDeploymentSourceAuthorizationV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { cloudDeploymentEffectiveSourceV1 } from '../../../domain/services/cloud-deployment-authentication.js';
import { preparedHostingMarkerSchema, preparedHostingReleaseEvidenceSchema, type IPreparedHosting, type PreparedHostingBindings } from '../../../domain/ports/hosting-prepared.port.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { createGcpCloudDeploymentDriver, parseGcpPreparedResources } from './gcp-cloud-deployment.js';
import { gcpPreparedApplicationConfiguration, gcpPreparedApplicationDigest, gcpObservedPreparedApplicationConfiguration } from './gcp-prepared-release.js';
import type { ProjectSpec } from '../../../domain/spec/spec.schema.js';

/** Native read proof for the isolated local metadata frontier. It never adopts
 * or writes cloud resources, and holding readiness is not app convergence. */
export class CloudRunPreparedHosting implements IPreparedHosting {
  constructor(private readonly connection: () => CloudDeploymentConnectionV1, private readonly token: () => Promise<string>, private readonly request: typeof fetch = fetch,
    private readonly sourceAuthorization: () => CloudDeploymentSourceAuthorizationV1 | undefined = () => undefined) {}
  async inspect({ environment, environmentSpec, releaseEvidence }: Parameters<IPreparedHosting['inspect']>[0]): ReturnType<IPreparedHosting['inspect']> {
    try {
      const connection = this.connection(), prepared = parseGcpPreparedResources(connection.preparedResources, connection);
      const driver = createGcpCloudDeploymentDriver({ fetch: this.request });
      if (environment.name !== connection.environment || environment.platformBindings.projectId !== connection.nativeScope.projectId) return { state: 'unknown' };
      driver.deployment!.assertSourcePlacement!({ environments: { [connection.environment]: environmentSpec } } as ProjectSpec, connection);
      const receiptDigest = canonicalJsonSha256(connection), previous = environment.platformBindings.preparedHosting === undefined ? undefined
        : preparedHostingMarkerSchema.parse(environment.platformBindings.preparedHosting);
      const release = releaseEvidence === undefined ? undefined : preparedHostingReleaseEvidenceSchema.parse(releaseEvidence);
      const source = cloudDeploymentEffectiveSourceV1(connection, this.sourceAuthorization());
      if (release && (release.repository.replace(/^github\.com\//, '') !== source.repository.replace(/^github\.com\//, '')
        || release.branch !== source.branch)) return { state: 'unknown' };
      if (previous && (previous.installationId !== connection.installationId || previous.planDigest !== connection.planDigest || previous.receiptDigest !== receiptDigest)) return { state: 'unknown' };
      const observed = await driver.readPrepared(connection, await this.token(), AbortSignal.timeout(30000));
      const pending = previous ? [...previous.pendingFirstRelease] : prepared.workloads.map(item => item.workload);
      const configurations: Record<string, string> = {}, services: PreparedHostingBindings['services'] = {};
      for (const item of prepared.workloads) {
        const workload = connection.deployment.workloads.find(value => value.name === item.workload)!;
        const native = observed.workloads[item.workload] as any, desired = environmentSpec.services[item.workload];
        const runtime = connection.runtimeIdentities.find(value => value.workload === item.workload)?.principal;
        if (!desired || workload.kind === 'cron' || runtime?.kind !== 'gcp-service-account') return { state: 'unknown' };
        const holding = native.template.serviceAccount === (item.holding.principal.kind === 'gcp-service-account' ? item.holding.principal.serviceAccountEmail : '');
        if (!pending.includes(item.workload) && holding) return { state: 'unknown' };
        const target = release?.targets.find(value => value.workload === item.workload);
        if (!holding && pending.includes(item.workload) && previous?.firstReleaseConfigurationDigests?.[item.workload]
          && target?.kind === 'service' && target.resourceId === item.id.split('/').at(-1) && target.resourceUid === item.lifetimeId
          && native.template.containers[0].image === release?.imageUri
          && gcpPreparedApplicationDigest(gcpObservedPreparedApplicationConfiguration(native)) === previous.firstReleaseConfigurationDigests[item.workload])
          pending.splice(pending.indexOf(item.workload), 1);
        if (pending.includes(item.workload)) configurations[item.workload] = gcpPreparedApplicationDigest(gcpPreparedApplicationConfiguration({
          workloadKind: workload.kind, publicAccess: workload.public === true, serviceAccountEmail: runtime.serviceAccountEmail,
          envVars: environmentSpec.envVars, secretVersionRefs: Object.fromEntries(workload.runtimeSecrets.map(value => [value.key, value.reference])),
          startCommand: desired.startCommand?.trim() || null, healthCheckPath: desired.healthCheckPath?.trim() || null,
        }));
        services[item.workload] = { serviceId: item.id.split('/').at(-1)!, resourceUid: item.lifetimeId, resourceType: 'service',
          workloadKind: workload.kind, imageUri: String(native.template.containers[0].image) };
      }
      // Only native convergence plus the independently verified managed release
      // and the prior reviewed configuration can retire a pending workload.
      return { state: 'verified', bindings: { provider: 'cloudrun', projectId: connection.nativeScope.projectId,
        environmentId: connection.deployment.region, providerScope: { projectId: connection.nativeScope.projectId, region: connection.deployment.region,
          artifactRepository: prepared.registry.id.split('/').at(-1)!, artifactRepositoryCreateTime: prepared.registry.lifetimeId }, services },
      preparation: { schemaVersion: 1, installationId: connection.installationId, planDigest: connection.planDigest, receiptDigest,
        pendingFirstRelease: pending, firstReleaseConfigurationDigests: configurations } };
    } catch { return { state: 'unknown' }; }
  }
}

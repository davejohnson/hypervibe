import { describe, expect, it } from 'vitest';
import { gcpHoldingServiceConfiguration, gcpObservedHoldingConfiguration, gcpHoldingConfigurationDigest } from '../../src/adapters/providers/gcp/gcp-prepared-hosting.js';

// Reconstructed Cloud Run v2 Service JSON; values/defaults come from native
// Service/RevisionTemplate/Container and documented TCP startup defaults.
// https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services
// https://docs.cloud.google.com/run/docs/configuring/healthchecks
const image = `us-west1-docker.pkg.dev/holding-project/public/holding@sha256:${'f'.repeat(64)}`;
const email = 'holding@customer-project.iam.gserviceaccount.com';
const id = 'projects/customer-project/locations/us-west1/services/web';
const uid = '22222222-2222-4222-8222-222222222222';
const expected = { id, lifetimeId: uid, image, serviceAccountEmail: email, publicAccess: false };
function native() { return { name: id, uid, etag: 'native-etag', generation: '1', observedGeneration: '1',
  terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
  latestCreatedRevision: `${id}/revisions/web-00001-abc`, latestReadyRevision: `${id}/revisions/web-00001-abc`,
  ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY', template: { serviceAccount: email, executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
    scaling: { maxInstanceCount: 1 }, timeout: '300s', maxInstanceRequestConcurrency: 1,
    containers: [{ image, ports: [{ containerPort: 8080 }], resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: true },
      startupProbe: { tcpSocket: { port: 8080 }, periodSeconds: 240, timeoutSeconds: 240, failureThreshold: 1 } }] } }; }

describe('one native holding configuration interpretation for installer and first release', () => {
  it('normalizes documented omitted false/zero/empty defaults without losing identity or readiness', () => {
    const observed = gcpObservedHoldingConfiguration(native(), expected);
    expect(observed).toEqual(gcpHoldingServiceConfiguration(image, email, false));
    expect(gcpHoldingConfigurationDigest(observed)).toMatch(/^[a-f0-9]{64}$/);
    const explicit: any = native(); explicit.reconciling = false; explicit.invokerIamDisabled = false;
    explicit.template.scaling.minInstanceCount = 0; explicit.template.containers[0].resources.startupCpuBoost = false;
    explicit.template.containers[0].env = []; explicit.template.containers[0].args = []; explicit.template.volumes = [];
    expect(gcpObservedHoldingConfiguration(explicit, expected)).toEqual(observed);
  });
  it('accepts native empty default traffic and explicitly false revision flags', () => {
    const value: any = native(); value.traffic = [];
    value.template.sessionAffinity = false; value.template.healthCheckDisabled = false;
    expect(gcpObservedHoldingConfiguration(value, expected)).toEqual(gcpHoldingServiceConfiguration(image, email, false));
    for (const field of ['sessionAffinity', 'healthCheckDisabled']) {
      const changed = structuredClone(value); changed.template[field] = true;
      expect(() => gcpObservedHoldingConfiguration(changed, expected)).toThrow();
    }
  });
  it.each(['uid', 'etag', 'generation', 'reconciling', 'revision', 'env', 'principal', 'image', 'containers', 'volume', 'command', 'probe', 'public', 'cpu', 'scale'])(
    'rejects a changed or incomplete %s before authorizing first rollout', field => {
      const value: any = native(); const container = value.template.containers[0];
      if (field === 'uid') value.uid = '33333333-3333-4333-8333-333333333333';
      if (field === 'etag') delete value.etag;
      if (field === 'generation') value.observedGeneration = '2';
      if (field === 'reconciling') value.reconciling = true;
      if (field === 'revision') value.latestReadyRevision = `${id}/revisions/web-00000-old`;
      if (field === 'env') container.env = [{ name: 'API_KEY', valueSource: { secretKeyRef: { secret: 'api-key', version: '7' } } }];
      if (field === 'principal') value.template.serviceAccount = 'reader@customer-project.iam.gserviceaccount.com';
      if (field === 'image') container.image = image.replace('f'.repeat(64), 'e'.repeat(64));
      if (field === 'containers') value.template.containers.push({ image });
      if (field === 'volume') value.template.volumes = [{ name: 'private', secret: { secret: 'api-key' } }];
      if (field === 'command') container.command = ['/bin/sh'];
      if (field === 'probe') container.livenessProbe = { httpGet: { path: '/health' } };
      if (field === 'public') value.invokerIamDisabled = true;
      if (field === 'cpu') delete container.resources.cpuIdle;
      if (field === 'scale') value.template.scaling.minInstanceCount = 1;
      expect(() => gcpObservedHoldingConfiguration(value, expected)).toThrow();
    });
});

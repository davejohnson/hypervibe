import { describe, expect, it } from 'vitest';
import { buildGcpPreparedReleaseRuntime, gcpObservedPreparedApplicationConfiguration, gcpPreparedApplicationConfiguration, gcpPreparedApplicationDigest } from '../gcp-prepared-release.js';
import { canonicalJsonSha256 } from '../../../../lib/canonical-json.js';
import { githubActionsWorkflowInputHash } from '../../../../domain/services/github-ops.service.js';
import { gcpBrokerTarget } from '../../../../domain/services/__tests__/cloud-deployment-ci.fixture.js';

// Reconstructed Cloud Run v2 JSON boundary, not live evidence. Published Service
// traffic selects revisions independently of the revision template. Probe's
// httpGet path may be the empty protobuf string (HTTP root), which is not TCP.
// https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services
// https://docs.cloud.google.com/run/docs/reference/rest/v2/Container#HttpGetAction
function native() {
  const id = 'projects/customer-project/locations/us-west2/services/web', revision = `${id}/revisions/web-00002-app`;
  return JSON.parse(JSON.stringify({ name: id, uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', etag: 'current-etag',
    generation: '2', observedGeneration: '2', terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    latestCreatedRevision: revision, latestReadyRevision: revision, uri: 'https://web.example.run.app',
    ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY', invokerIamDisabled: false,
    template: { serviceAccount: 'runtime@customer-project.iam.gserviceaccount.com', executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
      scaling: { minInstanceCount: 0, maxInstanceCount: 100 }, timeout: '300s', maxInstanceRequestConcurrency: 80,
      containers: [{ image: `us-west2-docker.pkg.dev/customer-project/images/web@sha256:${'a'.repeat(64)}`, ports: [{ containerPort: 8080 }], env: [],
        resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: true, startupCpuBoost: false },
        startupProbe: { tcpSocket: { port: 8080 }, periodSeconds: 240, timeoutSeconds: 240, failureThreshold: 1 } }] } }));
}
describe('independent prepared first-release readback counterexamples', () => {
  it('renders the Cloud SQL socket volume required by the resolved database connection',()=>{
    const value=native(),connection='customer-project:us-west2:primary';
    const configuration=gcpPreparedApplicationConfiguration({workloadKind:'web',publicAccess:false,serviceAccountEmail:value.template.serviceAccount,
      envVars:{CLOUD_SQL_CONNECTION_NAME:connection},secretVersionRefs:{},startCommand:null,healthCheckPath:null});
    expect(configuration.template).toMatchObject({volumes:[{name:'cloudsql',cloudSqlInstance:{instances:[connection]}}],
      containers:[{volumeMounts:[{name:'cloudsql',mountPath:'/cloudsql'}]}]});
  });
  it('verifies independently serialized Cloud SQL mounts as part of first-release configuration',()=>{
    const value=native(),connection='customer-project:us-west2:primary';
    value.template.volumes=[{name:'cloudsql',cloudSqlInstance:{instances:[connection]}}];
    value.template.containers[0].volumeMounts=[{name:'cloudsql',mountPath:'/cloudsql'}];
    value.template.containers[0].env=[{name:'CLOUD_SQL_CONNECTION_NAME',value:connection}];
    expect(gcpObservedPreparedApplicationConfiguration(JSON.parse(JSON.stringify(value))).template).toMatchObject({
      volumes:[{name:'cloudsql',cloudSqlInstance:{instances:[connection]}}],containers:[{volumeMounts:[{name:'cloudsql',mountPath:'/cloudsql'}]}]});
  });
  it('executes the emitted Cloud SQL readback with its shared volume helper and rejects changed mounts',()=>{
    const value=native(),connectionName='customer-project:us-west2:primary',target=gcpBrokerTarget(),connection=target.deploymentAccess!.connection;
    value.template.volumes=[{name:'cloudsql',cloudSqlInstance:{instances:[connectionName]}}];
    value.template.containers[0].volumeMounts=[{name:'cloudsql',mountPath:'/cloudsql'}];
    value.template.containers[0].env=[{name:'CLOUD_SQL_CONNECTION_NAME',value:connectionName}];
    connection.deployment.workloads[0].public=false;
    connection.preparedResources={schemaVersion:1,project:{id:'projects/987654321',lifetimeId:'2026-10-24T00:00:00Z'},registry:{id:'projects/customer-project/locations/us-west2/repositories/images',lifetimeId:'2026-10-24T00:00:00Z',owner:'b'.repeat(64)},
      workloads:[{workload:'web',kind:'service',id:value.name,lifetimeId:value.uid,owner:'b'.repeat(64),holding:{image:`us-west2-docker.pkg.dev/customer-project/images/holding@sha256:${'e'.repeat(64)}`,
        principal:{...connection.runtimeIdentities[0].principal,serviceAccountEmail:'holding@customer-project.iam.gserviceaccount.com'} as any,configurationDigest:'d'.repeat(64),generation:'1',revision:value.name+'/revisions/holding'}}]};
    target.runtimeResources![0]={...target.runtimeResources![0],providerResourceUid:value.uid,startCommand:null,healthCheckPath:null};
    const config=gcpPreparedApplicationConfiguration({workloadKind:'web',publicAccess:false,serviceAccountEmail:value.template.serviceAccount,envVars:{CLOUD_SQL_CONNECTION_NAME:connectionName},secretVersionRefs:{},startCommand:null,healthCheckPath:null});
    target.preparedRuntime={envVars:{CLOUD_SQL_CONNECTION_NAME:connectionName},preparation:{schemaVersion:1,installationId:connection.installationId,planDigest:connection.planDigest,
      receiptDigest:canonicalJsonSha256(connection),pendingFirstRelease:['web'],firstReleaseConfigurationDigests:{web:gcpPreparedApplicationDigest(config)}}};
    const execute=new Function('value',buildGcpPreparedReleaseRuntime(target)+'\nreturn gcpObservedPreparedApplicationConfiguration(value);');
    expect(execute(value)).toEqual(config);
    value.template.containers[0].volumeMounts[0].mountPath='/different';expect(()=>execute(value)).toThrow();
  });
  it.each(['','other-project:us-west2:primary','customer-project:bad:'])('rejects unsupported prepared SQL target %s',connection=>{
    expect(()=>gcpPreparedApplicationConfiguration({workloadKind:'web',publicAccess:false,serviceAccountEmail:'runtime@customer-project.iam.gserviceaccount.com',envVars:{CLOUD_SQL_CONNECTION_NAME:connection},secretVersionRefs:{},startCommand:null,healthCheckPath:null})).toThrow();
  });
  it('retains service-wide capacity in both the reviewed first release and independent native evidence', () => {
    const value = native(); value.scaling = { maxInstanceCount: 1 };
    const expected = { scalingMode: 'AUTOMATIC', minInstanceCount: 0, maxInstanceCount: 1 };
    expect(gcpObservedPreparedApplicationConfiguration(value)).toMatchObject({ scaling: expected });
    expect(gcpPreparedApplicationConfiguration({ workloadKind: 'web', publicAccess: false,
      serviceAccountEmail: value.template.serviceAccount, envVars: {}, secretVersionRefs: {}, startCommand: null,
      healthCheckPath: null, instanceBounds: { min: 0, max: 1 } })).toMatchObject({ scaling: expected });
  });
  it.each(['missing-condition', 'missing-generation', 'missing-observed-generation', 'old-ready-revision', 'reconciling', 'holding-traffic'])('rejects %s as successful application convergence', variant => {
    const value = native();
    if (variant === 'missing-condition') delete value.terminalCondition;
    if (variant === 'missing-generation') delete value.generation;
    if (variant === 'missing-observed-generation') delete value.observedGeneration;
    if (variant === 'old-ready-revision') value.latestReadyRevision = value.name + '/revisions/web-00001-hld';
    if (variant === 'reconciling') value.reconciling = true;
    if (variant === 'holding-traffic') value.traffic = [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: 'web-00001-hld', percent: 100 }];
    expect(() => gcpObservedPreparedApplicationConfiguration(value)).toThrow();
  });
  it('never normalizes an HTTP root probe into the reviewed TCP probe', () => {
    const value = native(), expected = gcpObservedPreparedApplicationConfiguration(value);
    value.template.containers[0].startupProbe = { httpGet: { path: '', port: 8080 }, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3 };
    let observed: unknown;
    try { observed = gcpObservedPreparedApplicationConfiguration(value); } catch { return; }
    expect(observed).not.toEqual(expected);
  });
  it.each([undefined, ''])('normalizes the documented HTTP root path %s while preserving probe kind', path => {
    const value = native();
    value.template.containers[0].startupProbe = { httpGet: { ...(path === undefined ? {} : { path }) }, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3 };
    expect(gcpObservedPreparedApplicationConfiguration(value).template.containers[0]!.startupProbe).toEqual({
      httpGet: { path: '/', port: 8080 }, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3,
    });
  });
  it.each([null, false, 0])('rejects malformed HTTP probe paths: %s', path => {
    const value = native(); value.template.containers[0].startupProbe = {
      httpGet: { path }, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3,
    };
    expect(() => gcpObservedPreparedApplicationConfiguration(value)).toThrow();
  });
  it('includes prepared configuration and monotonic release state in the workflow semantic lock', () => {
    const target = gcpBrokerTarget(), hash = () => githubActionsWorkflowInputHash({ provider: 'cloudrun', target, migration: { includeStep: false } });
    const original = hash();
    target.preparedRuntime = { envVars: { SETTING: 'first' }, preparation: { schemaVersion: 1, installationId: target.deploymentAccess!.connection.installationId,
      planDigest: 'a'.repeat(64), receiptDigest: 'b'.repeat(64), pendingFirstRelease: ['web'], firstReleaseConfigurationDigests: { web: 'c'.repeat(64) } } };
    const prepared = hash(); expect(prepared).not.toBe(original);
    target.preparedRuntime.envVars.SETTING = 'second'; expect(hash()).not.toBe(prepared);
    const configured = hash(); target.preparedRuntime.preparation.pendingFirstRelease = []; target.preparedRuntime.preparation.firstReleaseConfigurationDigests = {};
    expect(hash()).not.toBe(configured);
  });
});

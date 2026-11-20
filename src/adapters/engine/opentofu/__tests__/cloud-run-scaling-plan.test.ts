import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { buildCloudRunConfiguration, gcpEngineBackend, planWithCloudRunRevisionMinimums, type GcpCloudRunServiceInput } from '../../../providers/gcp/tofu/gcp-engine.backend.js';
import { ensureEngineBinary } from '../install.js';
import { runTofu } from '../runner.js';
import { materializeWorkingDirectory } from '../workspace.js';

type Service = { template: [{ scaling: { min_instance_count?: number; max_instance_count?: number }[] }] };
type Change = { name: string; change: { actions: string[]; before: Service; after: Service } };

const cases = [
  { name: 'default', desired: {}, observed: undefined, actions: ['no-op'], expected: [] },
  { name: 'minimum', desired: { minInstances: 2 }, observed: undefined, actions: ['update'], expected: [{ min_instance_count: 2 }] },
  { name: 'maximum', desired: { maxInstances: 5 }, observed: undefined, actions: ['update'], expected: [{ max_instance_count: 5 }] },
  { name: 'capped', desired: { maxInstances: 5 }, observed: { maxInstanceCount: 5 }, actions: ['no-op'], expected: [{ max_instance_count: 5 }] },
  { name: 'reset', desired: {}, observed: { minInstanceCount: 2 }, actions: ['update'], expected: [{ min_instance_count: 0 }] },
];
const projectId = 'synthetic-project';
const region = 'us-central1';
const image = `us-docker.pkg.dev/${projectId}/app/web@sha256:${'a'.repeat(64)}`;
const email = `runtime@${projectId}.iam.gserviceaccount.com`;
const serviceId = (name: string) => `projects/${projectId}/locations/${region}/services/${name}`;
const labels = (name: string) => ({ 'managed-by': 'hypervibe', 'hv-service': name });

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-cloud-run-scaling-'));
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url!, 'http://localhost').pathname;
  const service = cases.find(({ name }) => pathname === `/${serviceId(name)}`);
  if (request.method !== 'GET' || !service) {
    response.writeHead(404).end();
    return;
  }
  // Synthetic Cloud Run v2 GET: default revisions omit template.scaling.
  // The actual provider flattens this response before planning all changes.
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
    name: serviceId(service.name), uid: 'cc53839b-1c23-48d1-b981-de94ee40689f', generation: '1',
    ingress: 'INGRESS_TRAFFIC_ALL', labels: labels(service.name),
    template: { serviceAccount: email, scaling: service.observed, containers: [{
      image, ports: [{ containerPort: 8080 }], resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: true },
    }] },
  }));
});
afterAll(() => { server.close(); vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

it('converges normalized Cloud Run revision scaling and plans requested limits with the pinned provider', async () => {
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  const installed = await ensureEngineBinary();
  if (!installed.ok) throw new Error(installed.error);

  const services: GcpCloudRunServiceInput[] = cases.map(({ name, desired }) => ({
    logicalName: name, resourceName: name, workload: 'web', public: false, initialImage: image, runtimeServiceAccountEmail: email, ...desired,
  }));
  const input = { projectId, region, services };
  const configuration = buildCloudRunConfiguration(input);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const provider = configuration.files['provider.tf.json'] as { provider: { google: object[] } };
  Object.assign(provider.provider.google[0], { cloud_run_custom_endpoint: endpoint, cloud_run_v2_custom_endpoint: endpoint });
  const work = materializeWorkingDirectory({ parent: directory, requirements: gcpEngineBackend.providerRequirements, configuration });
  // A prior state holds provider-only settings that do not appear in the API.
  const resources = cases.map(({ name }) => ({ mode: 'managed', type: 'google_cloud_run_v2_service', name,
    provider: 'provider["registry.opentofu.org/hashicorp/google"]', instances: [{ schema_version: 0, attributes: {
      id: serviceId(name), project: projectId, location: region, name, deletion_protection: false, labels: labels(name), terraform_labels: labels(name),
    } }] }));
  fs.writeFileSync(path.join(work, 'terraform.tfstate'), JSON.stringify({ version: 4, serial: 1, resources }));
  const initEnv: Record<string, string> = {};
  for (const key of ['TF_CLI_CONFIG_FILE', 'TF_PLUGIN_CACHE_DIR']) if (process.env[key]) initEnv[key] = process.env[key];
  const options = { binary: installed.binary, workingDirectory: work, redact: [], timeoutMs: 300_000 };
  const init = await runTofu({ kind: 'init' }, { ...options, env: initEnv });
  expect(init.exitCode, init.stderr || init.stdout).toBe(0);
  const env = { GOOGLE_OAUTH_ACCESS_TOKEN: 'synthetic',
    GCE_METADATA_HOST: '127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1' };
  const planFile = path.join(work, 'scaling.tfplan');
  const decisions: boolean[] = [];
  const changes = await planWithCloudRunRevisionMinimums(services, async verify => {
    if (decisions.length) {
      const rebuilt = buildCloudRunConfiguration(input);
      fs.writeFileSync(path.join(work, 'cloudrun.tf.json'), JSON.stringify(rebuilt.files['cloudrun.tf.json']));
    }
    const plan = await runTofu({ kind: 'plan', out: planFile }, { ...options, env });
    expect(plan.exitCode, plan.stderr || plan.stdout).toBe(2);
    const shown = await runTofu({ kind: 'show-plan', planFile }, { ...options, env });
    expect(shown.exitCode, shown.stderr).toBe(0);
    const candidate: { resource_changes: Change[] } = JSON.parse(shown.stdout);
    if (!decisions.length) {
      const reset = candidate.resource_changes.find(resource => resource.name === 'reset')!;
      expect(reset.change.actions).toEqual(['no-op']);
      expect(reset.change.after.template[0].scaling).toMatchObject([{ min_instance_count: 2 }]);
    }
    decisions.push(verify(candidate));
    return candidate.resource_changes;
  });
  expect(decisions).toEqual([false, true]);
  for (const { name, observed, actions, expected } of cases) {
    const { change } = changes.find(resource => resource.name === name)!;
    const previous = observed?.minInstanceCount ? [{ min_instance_count: observed.minInstanceCount }]
      : observed?.maxInstanceCount ? [{ max_instance_count: observed.maxInstanceCount }] : [];
    expect(change.before.template[0].scaling, name).toMatchObject(previous);
    expect.soft(change.actions, name).toEqual(actions);
    expect.soft(change.after.template[0].scaling, name).toMatchObject(expected);
  }
}, 300_000);

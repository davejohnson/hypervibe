import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { createCommandContext } from '../context.js';
import { createCommandRegistry } from '../commands.js';
import { runCli } from '../../interfaces/cli/run.js';
import { registerCommandRegistry } from '../../interfaces/mcp/adapter.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { compileEnvironmentTaskWorkflow } from '../../domain/services/environment-task-workflow.service.js';
import '../../application/providers.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-operation-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

function setup(provider = 'railway') {
  const ctx = createCommandContext(); const project = ctx.repos.projects.create({ name: 'operation-proof', defaultPlatform: provider });
  const operationId = randomUUID(); const acceptedAt = new Date(Date.now() - 10000).toISOString();
  const descriptor = { role: 'document-extraction', label: 'Document extraction', purpose: 'Extract an invoice through the deployed application', kind: 'anthropic', source: 'env:ANTHROPIC_KEY',
    verification: [{ kind: 'http-receipt', environment: 'production', service: 'web', path: '/operations/credential-receipt', requiredCounts: { invoiceExtracted: 1 }, maxAgeSeconds: 300 }] };
  const stored = new SpecStore().replace(project, { version: 1, project: project.name, secrets: { ANTHROPIC_API_KEY: { ownership: 'delegated', principal: 'user:owner', environments: ['production'], credential: descriptor } },
    environments: { production: { hosting: { provider }, services: { web: {} }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' } } } });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: { provider, projectId: 'exact-project', environmentId: 'exact-environment', services: { web: { serviceId: 'exact-service', url: 'https://application.example' } },
    credentialUpdates: { 'document-extraction': { state: 'accepted', planId: operationId, acceptedAt, descriptor } } } });
  const observed: any = { provider, projectId: 'exact-project', projectExists: true, environmentId: 'exact-environment', observedAt: new Date().toISOString(), partial: false,
    completeness: { project: 'complete', environment: 'complete', services: 'complete', serviceIdentities: 'complete' }, warnings: [], services: [{ name: 'web', externalId: 'exact-service', workloadKind: 'web', status: 'running', customDomains: [], config: {}, envVarKeys: ['ANTHROPIC_API_KEY'], envVarHashes: {}, url: 'https://application.example',
      deployment: { id: 'exact-new-deployment', status: 'SUCCESS', activeDeploymentIds: ['exact-new-deployment'], activeDeploymentCoverage: 'instances', configurationState: 'resolved' } }] };
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockImplementation(async () => ({ observed, warnings: [] }) as any);
  const body: any = { version: 1, role: descriptor.role, operationId, deploymentId: 'exact-new-deployment', completedAt: new Date().toISOString(), status: 'passed', counts: { invoiceExtracted: 1 }, privateEmail: 'private@example.com', secret: 'private-credential' };
  const fetch = vi.fn(async (input, init) => { expect(String(input)).toBe('https://application.example/operations/credential-receipt'); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('manual'); expect(new Headers(init?.headers).get('x-hypervibe-credential-operation')).toBe(operationId); return Response.json(body); });
  vi.stubGlobal('fetch', fetch);
  return { ctx, project, spec: stored.spec, environment, descriptor, operationId, observed, body, fetch };
}

it.each(['railway', 'cloudrun', 'ecs', 'azure-container-apps', 'fly', 'digitalocean', 'vercel'])('records an app-defined operation receipt for the exact accepted deployment on %s without executing the operation', async provider => {
  const f = setup(provider);
  const { verifyCredentialOperations, credentialOperationEvidence } = await import('../credential-operation-verification.js');
  const result = await verifyCredentialOperations(f.ctx, f.project, f.spec, f.descriptor.role);
  expect(result).toMatchObject({ state: 'verified', role: f.descriptor.role, operationId: f.operationId });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain('private-'); expect(JSON.stringify(result)).not.toContain('private@example.com');
  const audits = f.ctx.repos.audit.findByResource('credential-role', `${f.project.id}/${f.descriptor.role}`);
  expect(audits.some(row => row.action === 'credential.operation.verified')).toBe(true);
  f.fetch.mockClear();
  const count = audits.length;
  expect(await credentialOperationEvidence(f.ctx, f.project, f.spec, f.descriptor.role)).toMatchObject({ state: 'verified' });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.ctx.repos.audit.findByResource('credential-role', `${f.project.id}/${f.descriptor.role}`)).toHaveLength(count);
});

it.each(['old-deployment', 'wrong-operation', 'expired', 'failed-count', 'old-instance', 'pending-update'])('does not promote %s evidence to an application operation', async mismatch => {
  const f = setup();
  if (mismatch === 'old-deployment') f.body.deploymentId = 'old-deployment';
  if (mismatch === 'wrong-operation') f.body.operationId = randomUUID();
  if (mismatch === 'expired') f.body.completedAt = new Date(Date.now() - 3600000).toISOString();
  if (mismatch === 'failed-count') f.body.counts.invoiceExtracted = 0;
  if (mismatch === 'old-instance') f.observed.services[0].deployment.activeDeploymentIds.push('old-deployment');
  if (mismatch === 'pending-update') f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { credentialUpdates: { [f.descriptor.role]: { state: 'pending', planId: f.operationId } } });
  const { verifyCredentialOperations } = await import('../credential-operation-verification.js');
  expect(await verifyCredentialOperations(f.ctx, f.project, f.spec, f.descriptor.role)).not.toMatchObject({ state: 'verified' });
  expect(f.ctx.repos.audit.findByResource('credential-role', `${f.project.id}/${f.descriptor.role}`).filter(row => row.action === 'credential.operation.verified')).toHaveLength(0);
});

it('a newly failed declared business assertion supersedes older successful application evidence', async () => {
  const f = setup();
  const { verifyCredentialOperations, credentialOperationEvidence } = await import('../credential-operation-verification.js');
  expect(await verifyCredentialOperations(f.ctx, f.project, f.spec, f.descriptor.role)).toMatchObject({ state: 'verified' });
  f.body.counts.invoiceExtracted = 0;
  expect(await verifyCredentialOperations(f.ctx, f.project, f.spec, f.descriptor.role)).toMatchObject({ state: 'failed' });
  expect(await credentialOperationEvidence(f.ctx, f.project, f.spec, f.descriptor.role)).not.toMatchObject({ state: 'verified' });
});

it('MCP and CLI expose the same declared receipt verification path and safe outcome', async () => {
  const f = setup(); const registry = createCommandRegistry(f.ctx); let output = '';
  const code = await runCli(['health', '--project', f.project.name, '--credential', f.descriptor.role, '--json'], { registry,
    io: { writeOut: text => { output += text; }, writeErr: () => {}, readStdin: async () => '', confirm: async () => false, stdinIsTTY: false } });
  expect(code).toBe(0); expect(output).toContain('verified'); expect(output).not.toContain('private-');
  const server = new McpServer({ name: 'operation-verification', version: '1.0.0' }); registerCommandRegistry(server, registry);
  const client = new Client({ name: 'test', version: '1.0.0' }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try { const result = await client.callTool({ name: 'hv_health', arguments: { project: f.project.name, credential: f.descriptor.role } });
    expect(JSON.stringify(result)).toContain('verified'); expect(JSON.stringify(result)).not.toContain('private-');
  } finally { await client.close(); await server.close(); }
});

it.each([false, true])('reads an independently approved task artifact and checks its exact run and deployment; wrong deployment=%s', async wrongDeployment => {
  const f = setup();
  const check = { kind: 'environment-task', environment: 'production', service: 'web', task: 'verify-extraction', operationIdInput: 'credential_operation', requiredCounts: { invoiceExtracted: 1 }, maxAgeSeconds: 300 };
  const spec = new SpecStore().replace(f.project, { ...f.spec, github: { repository: 'acme/application', canonicalEnvironment: 'production', actions: {
    'verify-extraction': { kind: 'environment-task', environment: 'production', service: 'web', command: ['npm', 'run', 'verify:extraction'],
      inputs: { credential_operation: { type: 'string', flag: '--credential-operation', description: 'Reviewed rotation UUID', required: true } },
      receiptPrefix: 'OPERATION:', receiptCountKeys: ['applied', 'skipped', 'invoiceExtracted'] },
  } }, secrets: { ANTHROPIC_API_KEY: { ...f.spec.secrets.ANTHROPIC_API_KEY, credential: { ...f.descriptor, verification: [check] } } } }).spec;
  const connection = f.ctx.repos.connections.create({ provider: 'github', credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'private-management-token' }) });
  f.ctx.repos.connections.updateStatus(connection.id, 'verified');
  const workflow = '.github/workflows/hypervibe-verify-extraction.yml'; const sha = 'a'.repeat(40);
  const run = { id: 42, path: workflow, event: 'workflow_dispatch', run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: sha, head_branch: 'main', repository: { full_name: 'acme/application' }, head_repository: { full_name: 'acme/application' } };
  vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({ total_count: 1, workflow_runs: [run] } as any);
  vi.spyOn(GitHubAdapter.prototype, 'getWorkflowRun').mockResolvedValue(run as any);
  vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(compileEnvironmentTaskWorkflow('verify-extraction', spec.github!.actions['verify-extraction'] as any));
  vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunArtifacts').mockResolvedValue({ total_count: 1, artifacts: [{ id: 7, name: 'hypervibe-task-receipt-42-1', expired: false, workflow_run: { id: 42, head_sha: sha } }] } as any);
  const read = vi.spyOn(GitHubAdapter.prototype, 'readJsonArtifact').mockResolvedValue({ version: 1, status: 'completed', task: 'verify-extraction', environment: 'production', executionId: '42',
    credentialOperations: [{ ...f.body, ...(wrongDeployment ? { deploymentId: 'different-deployment' } : {}) }] });
  const { verifyCredentialOperations } = await import('../credential-operation-verification.js');
  const result = await verifyCredentialOperations(f.ctx, f.project, spec, f.descriptor.role);
  expect(result.state).toBe(wrongDeployment ? 'unknown' : 'verified');
  expect(read).toHaveBeenCalledWith('acme', 'application', 7, 'hypervibe-task-receipt.json');
  expect(f.fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('private-');
});

it('requires every recorded native database consumer to have a declared operation check', async () => {
  const f = setup();
  const descriptor = { ...f.descriptor, kind: 'database-password', database: { environment: 'production', component: 'exact-component', username: 'app', database: 'app' } };
  const spec = new SpecStore().replace(f.project, { ...f.spec, secrets: { DATABASE_PASSWORD: { ownership: 'delegated', principal: 'user:owner', environments: [], credential: descriptor } },
    environments: { production: { ...f.spec.environments.production, services: { web: {}, worker: { workloadKind: 'worker' } } } } }).spec;
  f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: { web: { serviceId: 'exact-service', url: 'https://application.example' }, worker: { serviceId: 'worker-service' } },
    credentialUpdates: { [descriptor.role]: { state: 'accepted', planId: f.operationId, acceptedAt: new Date(Date.now() - 10000).toISOString(), descriptor,
      nativeDatabase: { target: { environmentId: f.environment.id }, consumers: [{ service: 'web', externalId: 'exact-service', keys: ['DATABASE_URL'] }, { service: 'worker', externalId: 'worker-service', keys: ['DATABASE_URL'] }] } } } });
  const { verifyCredentialOperations } = await import('../credential-operation-verification.js');
  expect(await verifyCredentialOperations(f.ctx, f.project, spec, descriptor.role)).toMatchObject({ state: 'unknown' });
  expect(f.fetch).not.toHaveBeenCalled();
});

it('reads a completed cron operation receipt through a separately declared bound web receipt service', async () => {
  const f = setup('cloudrun');
  const descriptor = { ...f.descriptor,
    runtimeConsumers: [{ environment: 'production', service: 'extractor', variable: 'ANTHROPIC_API_KEY' }],
    verification: [{ ...f.descriptor.verification[0], service: 'extractor', receiptService: 'web' }] };
  const spec = new SpecStore().replace(f.project, { ...f.spec, secrets: { ANTHROPIC_API_KEY: { ...f.spec.secrets.ANTHROPIC_API_KEY, credential: descriptor } },
    environments: { production: { ...f.spec.environments.production, services: { web: {}, extractor: { workloadKind: 'cron', cronSchedule: '0 * * * *', startCommand: 'npm run extract' } } } } }).spec;
  f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: { web: { serviceId: 'exact-service', url: 'https://application.example' }, extractor: { serviceId: 'extractor-job' } },
    credentialUpdates: { [descriptor.role]: { state: 'accepted', planId: f.operationId, acceptedAt: new Date(Date.now() - 10000).toISOString(), descriptor } } });
  f.observed.services.push({ name: 'extractor', externalId: 'extractor-job', workloadKind: 'cron', status: 'unknown', deployment: { id: 'completed-execution', status: 'SUCCESS', activeDeploymentIds: [], activeDeploymentCoverage: 'instances' } });
  f.body.deploymentId = 'completed-execution';
  const { verifyCredentialOperations } = await import('../credential-operation-verification.js');
  expect(await verifyCredentialOperations(f.ctx, f.project, spec, descriptor.role)).toMatchObject({ state: 'verified' });
});

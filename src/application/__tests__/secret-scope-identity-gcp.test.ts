import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../domain/entities/project.entity.js';
import { projectSpecSchema, type ProjectSpec } from '../../domain/spec/spec.schema.js';
import { engineEnvironmentProblems } from '../../domain/services/infrastructure-engine-selection.js';
import { gcpSecretScopeDescriptor, gcpServiceIdentityEmail, gcpUnlockedSecrets, type GcpAppliedWorkload } from '../../domain/services/gcp-secret-scope.js';
import { composeGcpProjectConfiguration, runGcpProjectSetup } from '../../domain/services/gcp-project-setup.service.js';
import { buildGcpPreparationConfiguration, defaultGcpPreparationInput, projectIamAddress } from '../../adapters/providers/gcp/tofu/gcp-setup.backend.js';
import { buildSecretScopeConfiguration, readSecretScopeInput, secretExclusionCondition, secretScopePolicyProblems, type SecretScopeSetupInput } from '../../adapters/providers/gcp/tofu/secret-scope-setup.js';
import { readVerifiedSecretScope, recordAppliedWorkloads, recordVerifiedSecretScope } from '../../adapters/providers/gcp/secret-scope-state.js';
import type { EngineConfiguration } from '../../domain/ports/infrastructure-engine.port.js';
import type { EnginePlanResult } from '../../adapters/engine/opentofu/engine.js';
import { engineStatePaths, ensureEngineStateDirectories } from '../../adapters/engine/opentofu/workspace.js';
import { buildEngineInput, plannedScopeWorkloads } from '../infrastructure-engine.js';
import { gcpSecretScopeGate, prepareGcpSecretScope, RELEASE_WORKLOAD } from '../gcp-secret-scope.js';
import { delegated, generated, projectId, runtime, scopeConfiguration, scopeSpec } from './secret-scope-gcp.helpers.js';

// Contract (docs/opentofu-engine.md, "Limiting a secret to named services"): on Google Cloud a
// service that a limited secret does not name cannot read it, in its environment or through
// Secret Manager with its runtime identity. Where that cannot be made true, nothing is planned.
const deploy = `hypervibe-deploy@${projectId}.iam.gserviceaccount.com`;
const catchup = gcpServiceIdentityEmail(projectId, 'staging', 'catchup');
const reports = gcpServiceIdentityEmail(projectId, 'staging', 'reports');
const web = gcpServiceIdentityEmail(projectId, 'staging', 'web');
const SOURCE = 'hv-staging-source-key';
const SIGNING = 'hv-staging-signing-key';
const unscoped = () => scopeSpec({ SOURCE_KEY: delegated, SIGNING_KEY: generated });
const limited = (services = ['catchup']) => scopeSpec({ SOURCE_KEY: { ...delegated, services }, SIGNING_KEY: generated });

const project = { id: 'local-project', name: 'clone', policies: { cloudPreparation: { cloudrun: {
  provider: 'cloudrun', version: 'gcp-cloudrun-v2', preparedAt: '2026-01-01T00:00:00.000Z', gcpProjectId: projectId,
  deployServiceAccountEmail: deploy, runtimeServiceAccountEmail: runtime, requiredApis: [], requiredRoles: [],
  runtimeRequiredRoles: ['roles/cloudsql.client', 'roles/secretmanager.secretAccessor', 'roles/storage.objectUser', 'roles/pubsub.publisher', 'roles/pubsub.subscriber'],
} } } } as unknown as Project;
const bound = ['web', 'worker', 'catchup', 'reports'];
const environment = { id: 'env-123', projectId: project.id, name: 'staging',
  platformBindings: { services: Object.fromEntries(bound.map(name => [name, { serviceId: name }])), engine: { releaseJob: 'release-command' } } };
const ctx = { repos: { environments: { findByProjectAndName: (_: string, name: string) => name === 'staging' ? environment : null } } } as unknown as Parameters<typeof gcpSecretScopeGate>[0];
const gate = (spec: ProjectSpec, origins?: Record<string, unknown>) => gcpSecretScopeGate(ctx, project, spec, 'staging',
  { gcpProjectId: projectId, runtimeServiceAccountEmail: runtime, runtimeSecretGrantOrigins: origins });

/** Writes the project setup manifest the way a confirmed setup does. */
function saveContribution(configuration: EngineConfiguration): void {
  const paths = engineStatePaths({ provider: 'gcp', projectId: project.id, environmentId: projectId, partition: 'project-shared' });
  ensureEngineStateDirectories(paths);
  fs.writeFileSync(path.join(paths.root, 'setup-manifest.json'), JSON.stringify({ contributions: { 'prepare-secret-scope': configuration } }), { mode: 0o600 });
}

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-secret-scope-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

type Files = Record<string, { resource?: Record<string, Record<string, any>> }>;
const files = (configuration: EngineConfiguration) => configuration.files as Files;

/** What each workload runs as, and the scheduler and invoker identities of scheduled jobs. */
function identities(configuration: EngineConfiguration) {
  const generatedFiles = files(configuration);
  const jobs = generatedFiles['jobs.tf.json']!.resource!;
  const job = (name: string) => jobs.google_cloud_run_v2_job![name].template[0].template[0];
  const names = (container: { env?: Array<{ name: string }> }) => (container.env ?? []).map(entry => entry.name);
  return {
    runsAs: {
      web: generatedFiles['cloudrun.tf.json']!.resource!.google_cloud_run_v2_service!.web.template[0].service_account,
      worker: generatedFiles['workerpools.tf.json']!.resource!.google_cloud_run_v2_worker_pool!.worker.template[0].service_account,
      catchup: job('catchup').service_account, reports: job('reports').service_account, release: job('release_command').service_account,
    },
    env: {
      web: names(generatedFiles['cloudrun.tf.json']!.resource!.google_cloud_run_v2_service!.web.template[0].containers[0]),
      worker: names(generatedFiles['workerpools.tf.json']!.resource!.google_cloud_run_v2_worker_pool!.worker.template[0].containers[0]),
      catchup: names(job('catchup').containers[0]), reports: names(job('reports').containers[0]), release: names(job('release_command').containers[0]),
    },
    scheduler: (name: string) => jobs.google_cloud_scheduler_job![`${name}_schedule`].http_target[0].oauth_token[0].service_account_email,
    invoker: (name: string) => jobs.google_cloud_run_v2_job_iam_member![`${name}_invoker`].member,
    bucketMembers: Object.fromEntries(Object.entries(generatedFiles['storage.tf.json']!.resource!.google_storage_bucket_iam_member!).map(([key, value]) => [key, value.member])),
  };
}

/** The reviewed setup, as the planner and the setup command compute it from the spec and recorded workloads. */
function setupInput(spec: ProjectSpec, applied: Record<string, GcpAppliedWorkload> = {}, retained?: SecretScopeSetupInput['identities']): SecretScopeSetupInput {
  return {
    ...gcpSecretScopeDescriptor({ spec, gcpProjectId: projectId, runtimeServiceAccountEmail: runtime,
      environments: [{ name: 'staging', boundWorkloads: [...bound, RELEASE_WORKLOAD], applied }], retained }),
    projectNumber: '123456789', deployServiceAccountEmail: deploy,
    runtimeProjectRoles: ['roles/cloudsql.client', 'roles/pubsub.publisher', 'roles/pubsub.subscriber'],
  };
}

/** Workload records after the plan for this spec was applied with the given identities. */
function appliedFor(spec: ProjectSpec, serviceIdentities: Record<string, string> = {}): Record<string, GcpAppliedWorkload> {
  return plannedScopeWorkloads(buildEngineInput(spec, 'staging', { gcpProjectId: projectId, region: 'us-west1', runtimeServiceAccountEmail: runtime,
    resourceNameFor: name => name, databaseWired: true, importedSecrets: ['SOURCE_KEY'], secretVersions: { SOURCE_KEY: '1', SIGNING_KEY: '1', DATABASE_URL: '1' }, serviceIdentities }));
}

/**
 * Every project-level grant in the composed project setup that lets a member read a Secret Manager
 * resource: base setup's grants overlaid with the service identity setup.
 */
function projectReaders(scope: EngineConfiguration) {
  const composed = composeGcpProjectConfiguration({
    'prepare-base-us-central1': buildGcpPreparationConfiguration(defaultGcpPreparationInput(projectId, deploy, runtime)),
    'prepare-secret-scope': scope,
  });
  const members = Object.values((composed.files['project-setup.tf.json'] as { resource: Record<string, Record<string, any>> }).resource.google_project_iam_member!)
    .filter(grant => ['roles/secretmanager.secretAccessor', 'roles/secretmanager.admin', 'roles/owner'].includes(grant.role));
  // The generated CEL uses only operators JavaScript shares, so it can be evaluated as written.
  const allows = (grant: { condition?: Array<{ expression: string }> }, type: string, name: string) => !grant.condition?.length
    || (new Function('resource', `return ${grant.condition[0]!.expression}`) as (resource: unknown) => boolean)({ type, name });
  return (secretId: string) => {
    const version = `projects/123456789/secrets/${secretId}/versions/3`;
    return members.filter(grant => allows(grant, 'secretmanager.googleapis.com/SecretVersion', version)
      || allows(grant, 'secretmanager.googleapis.com/Secret', `projects/123456789/secrets/${secretId}`)).map(grant => grant.member as string).sort();
  };
}

describe('a spec with no secret limited to named services', () => {
  it('generates exactly the configuration it generated before service identities existed', () => {
    const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/gcp-unscoped-configuration.json', import.meta.url), 'utf8'));
    expect(JSON.parse(JSON.stringify(scopeConfiguration(unscoped())))).toEqual(expected);
  });

  it('plans without service identity setup and records nothing', () => {
    expect(gate(unscoped())).toEqual({ active: false, identities: {}, warnings: [] });
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});

describe('workloads of an environment with a limited secret', () => {
  it('runs only the named service as its own identity, with its scheduler and bucket access', () => {
    const generatedConfig = identities(scopeConfiguration(limited(), { catchup }));
    expect(generatedConfig.runsAs).toEqual({ web: runtime, worker: runtime, catchup, reports: runtime, release: runtime });
    expect(generatedConfig.env.catchup).toContain('SOURCE_KEY');
    for (const workload of ['web', 'worker', 'reports', 'release'] as const) expect(generatedConfig.env[workload]).not.toContain('SOURCE_KEY');
    // The scheduler starts the job as the job's own identity, which alone may invoke it.
    expect(generatedConfig.scheduler('catchup')).toBe(catchup);
    expect(generatedConfig.invoker('catchup')).toBe(`serviceAccount:${catchup}`);
    expect(generatedConfig.scheduler('reports')).toBe(runtime);
    // The bucket is wired into web and catchup: the shared identity keeps its grant, catchup gets its own.
    expect(generatedConfig.bucketMembers).toEqual({ storage_media_runtime: `serviceAccount:${runtime}`, storage_media_service_catchup: `serviceAccount:${catchup}` });
  });

  it('gives a service identity no bucket it is not wired to', () => {
    const spec = scopeSpec({ SOURCE_KEY: { ...delegated, services: ['catchup'] }, SIGNING_KEY: { ...generated, services: ['reports'] } });
    const generatedConfig = identities(scopeConfiguration(spec, { catchup, reports }));
    expect(generatedConfig.runsAs.reports).toBe(reports);
    expect(Object.values(generatedConfig.bucketMembers)).not.toContain(`serviceAccount:${reports}`);
  });

  it('runs the release command as the web service it borrows from, and only then with its limited secrets', () => {
    const borrowed = identities(scopeConfiguration(scopeSpec({ SOURCE_KEY: delegated, SIGNING_KEY: { ...generated, services: ['web'] } }), { web }));
    expect(borrowed.runsAs.release).toBe(web);
    expect(borrowed.env.release).toContain('SIGNING_KEY');
    const other = identities(scopeConfiguration(limited(), { catchup }));
    expect(other.runsAs.release).toBe(runtime);
    expect(other.env.release).not.toContain('SOURCE_KEY');
  });

  it('changes no data-bearing resource when an existing secret is narrowed', () => {
    const before = scopeConfiguration(unscoped());
    const after = scopeConfiguration(limited(), { catchup });
    const changed = (file: string, type: string) => Object.keys(files(after)[file]!.resource![type]!)
      .filter(key => JSON.stringify(files(after)[file]!.resource![type]![key]) !== JSON.stringify(files(before)[file]?.resource?.[type]?.[key])).sort();
    expect(files(after)['secrets.tf.json']).toEqual(files(before)['secrets.tf.json']);
    expect(files(after)['cloudsql.tf.json']).toEqual(files(before)['cloudsql.tf.json']);
    expect(files(after)['pubsub.tf.json']).toEqual(files(before)['pubsub.tf.json']);
    expect(changed('storage.tf.json', 'google_storage_bucket')).toEqual([]);
    expect(changed('storage.tf.json', 'google_storage_bucket_iam_member')).toEqual(['storage_media_service_catchup']);
    // Every workload that held the secret is updated in place; nothing else is.
    expect(changed('cloudrun.tf.json', 'google_cloud_run_v2_service')).toEqual(['web']);
    expect(changed('workerpools.tf.json', 'google_cloud_run_v2_worker_pool')).toEqual(['worker']);
    expect(changed('jobs.tf.json', 'google_cloud_run_v2_job')).toEqual(['catchup', 'release_command', 'reports']);
    expect(changed('jobs.tf.json', 'google_cloud_scheduler_job')).toEqual(['catchup_schedule']);
    expect(changed('jobs.tf.json', 'google_cloud_run_v2_job_iam_member')).toEqual(['catchup_invoker']);
    expect(Object.keys(after.resources).filter(address => !(address in before.resources))).toEqual(['google_storage_bucket_iam_member.storage_media_service_catchup']);
  });

  it('refuses shapes whose boundary cannot be enforced', () => {
    const refused = (secrets: Record<string, unknown>, hosting = {}) => projectSpecSchema.safeParse({ ...JSON.parse(JSON.stringify(unscoped())), secrets,
      environments: { staging: { ...JSON.parse(JSON.stringify(unscoped().environments.staging)), hosting: { provider: 'cloudrun', ...hosting } } } }).error?.issues.map(issue => issue.message) ?? [];
    expect(refused({ SOURCE_KEY: { ...delegated, services: ['worker'] } })).toEqual([expect.stringContaining('an on-demand worker')]);
    expect(refused({ SOURCE_KEY: { ...delegated, services: ['catchup'] } }, { gcpRuntimeSecretGrants: 'per-secret' })).toEqual([expect.stringContaining('cannot be combined with gcpRuntimeSecretGrants')]);
    expect(refused({ SOURCE_KEY: { ...delegated, services: ['catchup'] } })).toEqual([]);
    // Planning checks again, so a later schema change cannot quietly accept them.
    const spec = limited();
    const onDemand = { ...spec, secrets: { ...spec.secrets, SOURCE_KEY: { ...spec.secrets.SOURCE_KEY!, services: ['worker'] } } } as ProjectSpec;
    expect(engineEnvironmentProblems(onDemand, 'staging')).toEqual([expect.stringContaining('an on-demand worker')]);
    expect(gate(onDemand).blocked).toContain('an on-demand worker');
    // The engine itself will not build a waker for a worker that left the shared identity.
    expect(() => scopeConfiguration(unscoped(), { worker: catchup })).toThrow('must run as the shared runtime identity');
  });
});

describe('who can read a limited secret through Secret Manager', () => {
  it('leaves the shared identity able to read it while services that run as it still hold it', () => {
    // An environment that predates this record: any workload may hold the secret as the shared identity.
    const first = setupInput(limited());
    expect(first.identities.map(identity => identity.email)).toEqual([catchup]);
    expect(first.runtimeExcludedSecretIds).toEqual([]);
    expect(gcpUnlockedSecrets(limited(), 'staging', first)).toEqual(['SOURCE_KEY']);
    // Still held by web under the previous, unlimited plan.
    expect(setupInput(limited(), appliedFor(unscoped())).runtimeExcludedSecretIds).toEqual([]);
  });

  it('closes it to every identity but the named service once no other workload holds it', () => {
    const spec = scopeSpec({ SOURCE_KEY: { ...delegated, services: ['catchup'] }, SIGNING_KEY: { ...generated, services: ['reports'] } });
    const input = setupInput(spec, appliedFor(spec, { catchup, reports }));
    expect(input.runtimeExcludedSecretIds).toEqual([SIGNING, SOURCE]);
    expect(Object.fromEntries(input.identities.map(identity => [identity.service, identity.excludedSecretIds]))).toEqual({ catchup: [SIGNING], reports: [SOURCE] });
    expect(gcpUnlockedSecrets(spec, 'staging', input)).toEqual([]);

    const readers = projectReaders(buildSecretScopeConfiguration(input));
    // Deployment tooling keeps Secret Manager admin; no workload identity but the named one remains.
    expect(readers(SOURCE)).toEqual([`serviceAccount:${catchup}`, `serviceAccount:${deploy}`].sort());
    expect(readers(SIGNING)).toEqual([`serviceAccount:${deploy}`, `serviceAccount:${reports}`].sort());
    // Secrets that name no services stay readable by every workload identity, as before.
    expect(readers('hv-staging-database-url')).toEqual([catchup, deploy, runtime, reports].map(email => `serviceAccount:${email}`).sort());
  });

  it('replaces the shared identity\'s project-wide grant instead of adding a second one', () => {
    const scope = buildSecretScopeConfiguration(setupInput(limited(), appliedFor(limited(), { catchup })));
    const address = projectIamAddress(`serviceAccount:${runtime}`, 'roles/secretmanager.secretAccessor');
    const base = buildGcpPreparationConfiguration(defaultGcpPreparationInput(projectId, deploy, runtime));
    expect(base.resources[address]).toBeDefined();
    const composed = composeGcpProjectConfiguration({ base, scope });
    const grants = Object.entries((composed.files['project-setup.tf.json'] as { resource: Record<string, Record<string, any>> }).resource.google_project_iam_member!)
      .filter(([, grant]) => grant.member === `serviceAccount:${runtime}` && grant.role === 'roles/secretmanager.secretAccessor');
    expect(grants).toHaveLength(1);
    expect(`google_project_iam_member.${grants[0]![0]}`).toBe(address);
    expect(grants[0]![1].condition).toEqual([secretExclusionCondition('123456789', [SOURCE])]);
    expect(grants[0]![1].lifecycle).toEqual({ create_before_destroy: true });
  });

  it('creates each identity with deploy access and the shared identity\'s database and queue roles, not project-wide storage', () => {
    const input = setupInput(limited());
    const configuration = buildSecretScopeConfiguration({ ...input, ciReleaseServiceAccountEmail: `hypervibe-ci@${projectId}.iam.gserviceaccount.com` });
    const resource = (configuration.files['project-setup.tf.json'] as { resource: Record<string, Record<string, any>> }).resource;
    expect(Object.values(resource.google_service_account!).map(account => account.account_id)).toEqual([catchup.split('@')[0]]);
    expect(Object.values(resource.google_service_account_iam_member!).map(grant => `${grant.member} ${grant.role}`).sort()).toEqual([
      `serviceAccount:hypervibe-ci@${projectId}.iam.gserviceaccount.com roles/iam.serviceAccountUser`, `serviceAccount:${deploy} roles/iam.serviceAccountUser`]);
    expect(Object.values(resource.google_project_iam_member!).filter(grant => grant.member === `serviceAccount:${catchup}`).map(grant => grant.role).sort())
      .toEqual(['roles/cloudsql.client', 'roles/pubsub.publisher', 'roles/pubsub.subscriber', 'roles/secretmanager.secretAccessor']);
    // The saved contribution is accepted only when it is exactly what its recorded input builds.
    expect(readSecretScopeInput(configuration)?.identities).toEqual(input.identities);
    const tampered = JSON.parse(JSON.stringify(configuration)) as EngineConfiguration;
    delete Object.values((tampered.files['project-setup.tf.json'] as { resource: Record<string, Record<string, any>> }).resource.google_project_iam_member!)
      .find(grant => grant.member === `serviceAccount:${runtime}`)!.lifecycle;
    expect(readSecretScopeInput(tampered)).toBeUndefined();
  });

  it('rejects a live policy that still lets the shared identity read the secret', () => {
    const input = setupInput(limited(), appliedFor(limited(), { catchup }));
    const accessor = 'roles/secretmanager.secretAccessor';
    const reviewed = { version: 3, bindings: [
      { role: accessor, members: [`serviceAccount:${runtime}`], condition: secretExclusionCondition('123456789', [SOURCE]) },
      { role: accessor, members: [`serviceAccount:${catchup}`] },
    ] };
    expect(secretScopePolicyProblems(reviewed, input)).toEqual([]);
    const unconditional = { role: accessor, members: [`serviceAccount:${runtime}`] };
    expect(secretScopePolicyProblems({ ...reviewed, bindings: [...reviewed.bindings, unconditional] }, input)).toEqual([expect.stringContaining(runtime)]);
    expect(secretScopePolicyProblems({ version: 3, bindings: [unconditional, reviewed.bindings[1]!] }, input)).toEqual([expect.stringContaining(runtime)]);
    expect(secretScopePolicyProblems({ ...reviewed, bindings: [...reviewed.bindings, { role: 'roles/secretmanager.admin', members: [`serviceAccount:${runtime}`] }] }, input))
      .toEqual([expect.stringContaining('reads every secret')]);
  });
});

describe('planning an environment with a limited secret', () => {
  /** Stands in for a confirmed setup whose live policy was verified. */
  const verify = (input: SecretScopeSetupInput) => {
    saveContribution(buildSecretScopeConfiguration(input));
    recordVerifiedSecretScope(project.id, input);
  };

  it('stops until service identities exist and were verified', () => {
    const result = gate(limited());
    expect(result).toMatchObject({ active: true, identities: {} });
    expect(result.blocked).toContain('no verified setup exists yet');
    expect(result.blocked).toContain('secretScopeAccess="lifecycle"');
  });

  it('plans the move with a plain warning, then stops until the shared identity\'s access is removed', () => {
    verify(setupInput(limited()));
    const moving = gate(limited());
    expect(moving.blocked).toBeUndefined();
    expect(moving.identities).toEqual({ catchup });
    expect(moving.warnings).toEqual([expect.stringContaining('NOT YET ENFORCED: SOURCE_KEY (catchup)')]);

    // The plan was applied: no workload that runs as the shared identity holds the secret any more.
    recordAppliedWorkloads(project.id, environment.id, appliedFor(limited(), { catchup }));
    const pending = gate(limited());
    expect(pending.blocked).toContain('the shared runtime identity can still read it through Secret Manager');
    expect(pending.identities).toEqual({});

    verify(setupInput(limited(), appliedFor(limited(), { catchup })));
    const enforced = gate(limited());
    expect(enforced.blocked).toBeUndefined();
    expect(enforced.identities).toEqual({ catchup });
    expect(enforced.warnings).toEqual([expect.stringContaining('enforced in Google Cloud: SOURCE_KEY (catchup)')]);
  });

  it('stops when the saved setup is ahead of what was verified', () => {
    verify(setupInput(limited()));
    saveContribution(buildSecretScopeConfiguration(setupInput(limited(), appliedFor(limited(), { catchup }))));
    expect(gate(limited()).blocked).toContain('was not verified');
  });

  it('stops a plan that would give a locked secret to another service before access is widened', () => {
    recordAppliedWorkloads(project.id, environment.id, appliedFor(limited(), { catchup }));
    verify(setupInput(limited(), appliedFor(limited(), { catchup })));
    expect(gate(limited(['catchup', 'web'])).blocked).toContain('staging/web has no service identity yet');
  });

  it('stops while a per-secret grant to the shared identity is still recorded', () => {
    verify(setupInput(limited()));
    expect(gate(limited(), { [SOURCE]: { name: 'projects/1/secrets/x', createTime: 'now' } }).blocked).toContain('per-secret grants for the shared runtime identity');
  });

  it('keeps planning blocked after scoping is removed until the shared identity can read the secret again', () => {
    recordAppliedWorkloads(project.id, environment.id, appliedFor(limited(), { catchup }));
    verify(setupInput(limited(), appliedFor(limited(), { catchup })));
    expect(gate(unscoped()).blocked).toContain('no longer matches');
  });
});

describe('setting up service identities', () => {
  const engine = () => ({
    plan: vi.fn(async (input: { configuration: EngineConfiguration; planId: string }): Promise<EnginePlanResult> => {
      const segment = { id: input.planId, engine: 'opentofu' as const, planDigest: `digest-${input.planId}`, configurationDigest: 'configuration', engineVersion: '1.13.9', providerVersions: {} };
      const runtimeGrant = projectIamAddress(`serviceAccount:${runtime}`, 'roles/secretmanager.secretAccessor');
      return { ok: true, segmentId: input.planId, planFile: 'encrypted.tfplan', blockers: [], unmanagedDeletes: [], segment,
        actions: Object.entries(input.configuration.resources).map(([address, mapping]) => ({ id: mapping.actionId,
          // The base grant already exists: a condition replaces it.
          type: address === runtimeGrant ? 'replace' as const : 'create' as const, verified: true,
          resource: { kind: 'project' as const, provider: 'gcp', name: mapping.name }, reason: 'Reviewed change', metadata: { engineSegment: { ...segment, addresses: [address] } } })) };
    }),
    apply: vi.fn(async (input: { approvedAddresses: string[] }) => ({ outcomes: Object.fromEntries(input.approvedAddresses.map(address => [address, 'succeeded' as const])), diagnostics: [] })),
  });
  const prepare = (spec: ProjectSpec, confirm: boolean, observe: () => Promise<string[]> = async () => [], managed = engine()) => prepareGcpSecretScope(ctx, {
    project, spec, environmentName: 'staging', gcpProjectId: projectId, adminToken: async () => 'admin-token', confirm,
    dependencies: { projectNumber: async () => '123456789', observe, setup: params => runGcpProjectSetup(params, { engine: managed }) },
  });

  it('previews, then records the access as enforced only after the live policy was verified', async () => {
    const preview = await prepare(limited(), false);
    expect(preview).toMatchObject({ success: true, requiresConfirmation: true, summary: {
      serviceIdentities: [{ environment: 'staging', service: 'catchup', identity: catchup, cannotRead: [] }],
      sharedRuntimeIdentity: { identity: runtime, cannotRead: [] }, notYetEnforced: ['staging: SOURCE_KEY'] } });
    expect(readVerifiedSecretScope(project.id, projectId)).toBeUndefined();
    expect(gate(limited()).blocked).toContain('no verified setup exists yet');

    // Applied, but the live policy does not show the reviewed grants: still not enforced, still blocked.
    const unverified = await prepare(limited(), true, async () => [`${runtime} does not hold exactly the reviewed Secret Accessor grant.`]);
    expect(unverified).toMatchObject({ success: false, error: expect.stringContaining('could not be verified') });
    expect(gate(limited()).blocked).toContain('no verified setup exists yet');

    await prepare(limited(), false);
    expect(await prepare(limited(), true)).toMatchObject({ success: true, message: expect.stringContaining('Not yet enforced: staging: SOURCE_KEY') });
    expect(gate(limited())).toMatchObject({ identities: { catchup }, warnings: [expect.stringContaining('NOT YET ENFORCED')] });
  });

  it('narrows the shared identity\'s grant in a second reviewed step, as a replacement of that grant only', async () => {
    await prepare(limited(), false);
    await prepare(limited(), true);
    recordAppliedWorkloads(project.id, environment.id, appliedFor(limited(), { catchup }));
    const managed = engine();
    const preview = await prepare(limited(), false, undefined, managed);
    expect(preview).toMatchObject({ success: true, summary: { sharedRuntimeIdentity: { cannotRead: [SOURCE] }, notYetEnforced: [] } });
    expect((preview.actions as Array<{ type: string }>).filter(action => action.type === 'replace')).toHaveLength(1);
    // A second step that was applied but not verified must not leave plans running on the first verification.
    expect(await prepare(limited(), true, async () => ['policy changed'], managed)).toMatchObject({ success: false });
    expect(gate(limited()).blocked).toContain('was not verified');
    await prepare(limited(), false, undefined, managed);
    expect(await prepare(limited(), true, undefined, managed)).toMatchObject({ success: true, message: expect.stringContaining('every limited secret is closed') });
    expect(gate(limited())).toMatchObject({ identities: { catchup }, warnings: [expect.stringContaining('enforced in Google Cloud')] });
  });

  it('refuses a replacement of any grant the setup does not own', async () => {
    const managed = engine();
    const plan = managed.plan.getMockImplementation()!;
    managed.plan.mockImplementation(async input => {
      const planned = await plan(input);
      return { ...planned, actions: planned.actions.map(action => action.resource.name.startsWith('Identity for') ? { ...action, type: 'replace' as const } : action) };
    });
    expect(await prepare(limited(), false, undefined, managed)).toMatchObject({ success: false, error: expect.stringContaining('outside this approval') });
  });

  it('has nothing to set up when no secret names services', async () => {
    expect(await prepare(unscoped(), false)).toMatchObject({ success: false, error: expect.stringContaining('nothing to set up') });
  });
});

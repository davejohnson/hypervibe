import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AZURE_CI_ACTIONS } from '../../adapters/providers/azure/azure-ci-roles.js';
import { AZURE_APP_ROLES, AZURE_ROLES } from '../../adapters/providers/azure/azure-setup.client.js';
import { buildAzureEnvironmentConfiguration, type AzureEngineInput } from '../../adapters/providers/azure/tofu/azure-engine.config.js';
import { engineEnvironmentProblems } from '../../domain/services/infrastructure-engine-selection.js';
import { credentialRuntimeServices } from '../../domain/services/credential-runtime-consumers.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { projectSpecSchema, type ProjectSpec } from '../../domain/spec/spec.schema.js';
import {
  azureEngineLayout, azureEngineProblems, azureEnvironmentSecretKeys, azureSharedIdentityReach, azureSecretServices, buildAzureEngineInput, buildAzureSharedInput, leftoverRoleAssignments,
  type AzureEngineContext,
} from '../infrastructure-engine-azure.js';
import { releaseAzureEngineServices } from '../infrastructure-engine-azure-release.js';

// Contract: on Azure a secret that names services is an access boundary. Each named service runs as its own
// managed identity; the identity the other workloads share holds no role that reaches the secret.
const connection = { tenantId: '11111111-2222-3333-4444-555555555555', subscriptionId: '66666666-7777-8888-9999-000000000000', resourceGroup: 'hv-clone',
  location: 'eastus2', deployPrincipalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', clientSecret: 'client-secret-value-1',
  clientSecretExpiresAt: '2027-11-12T00:00:00Z' };
const project = { id: 'proj1', name: 'clone' };
const delegated = { ownership: 'delegated', principal: 'source system administrator', environments: ['test'] };
const generated = { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, environments: ['test'] };
const layout = azureEngineLayout(project, 'test', 'ENV1', connection);
const group = `/subscriptions/${connection.subscriptionId}/resourceGroups/${connection.resourceGroup}`;

interface Options { ci?: boolean; image?: boolean; imported?: readonly string[]; environment?: Record<string, unknown>; other?: boolean }

function document(secrets: Record<string, unknown>, options: Options = {}) {
  const services = {
    web: { public: true, healthCheckPath: '/health' },
    worker: { workloadKind: 'worker', startCommand: 'clone work' },
    queue: { workloadKind: 'worker', startCommand: 'clone queue', onDemand: { pendingWorkQuery: "SELECT count(*) FROM jobs WHERE status = 'queued'" } },
    catchup: { workloadKind: 'cron', cronSchedule: '*/15 * * * *', startCommand: 'clone catchup' },
  };
  return { version: 1, project: 'clone', ...(options.ci ? { gitRemoteUrl: 'https://github.com/example/clone.git' } : {}),
    environments: { test: {
      hosting: { provider: 'azure', engine: 'opentofu' }, envVars: { PORT: '3000', LOG_LEVEL: 'info' },
      ...(options.ci ? { deploy: { strategy: 'branch', branch: 'main' } } : {}),
      database: { provider: 'azure-postgres', version: 17 },
      storage: {
        documents: { provider: 'azureblob', type: 'bucket', region: 'eastus2', injectInto: ['web'] },
        exports: { provider: 'azureblob', type: 'bucket', region: 'eastus2', injectInto: ['catchup'] },
      },
      services, ...options.environment,
    }, ...(options.other ? { other: { hosting: { provider: 'azure', engine: 'opentofu' }, services } } : {}) }, secrets };
}

const parse = (secrets: Record<string, unknown>, options: Options = {}) => projectSpecSchema.parse(document(secrets, options));

function engineInput(spec: ProjectSpec, options: Options = {}): AzureEngineInput {
  const keys = azureEnvironmentSecretKeys(spec, 'test', [...(options.imported ?? [])]);
  return buildAzureEngineInput(spec, 'test', { connection: connection as never, ...layout, environment: { id: 'ENV1' } },
    { secretKeys: keys.all, ...(options.image === false ? {} : { image: 'hvcloneshared123456.azurecr.io/app@sha256:abc' }) });
}

const configuration = (secrets: Record<string, unknown>, options: Options = {}) => buildAzureEnvironmentConfiguration(engineInput(parse(secrets, options), options));

interface Assignment { scope: string; role_definition_id: string; principal_id: string; principal_type: string }
interface Workload {
  identity: Array<{ type: string; identity_ids: string[] }>; registry: Array<{ identity: string }>; depends_on: string[];
  secret: Array<{ name: string; key_vault_secret_id: string; identity: string }>;
  template: Array<{ container: Array<{ env: Array<{ name: string; value?: string; secret_name?: string }> }>; custom_scale_rule?: Array<{ authentication: Array<{ secret_name: string }> }> }>;
}

/** The generated resources, read the way an auditor would: who is attached where, and what each identity may reach. */
function generatedAccess(config: ReturnType<typeof buildAzureEnvironmentConfiguration>) {
  const files = config.files as Record<string, { resource?: Record<string, Record<string, any>> }>;
  const all = (type: string) => Object.assign({}, ...Object.values(files).map((file) => file.resource?.[type] ?? {})) as Record<string, any>;
  const assignments = all('azurerm_role_assignment') as Record<string, Assignment>;
  const workloads = { ...all('azurerm_container_app'), ...all('azurerm_container_app_job') } as Record<string, Workload>;
  const identityKey = (reference: string) => /^\$\{azurerm_user_assigned_identity\.([a-z0-9_]+)\.(?:id|principal_id|client_id)\}$/.exec(reference)?.[1] ?? `unparsed:${reference}`;
  /** Every identity whose token code inside the workload can obtain. */
  const attached = (workload: string) => workloads[workload]!.identity.flatMap((block) => block.identity_ids).map(identityKey);
  const held = (identity: string) => Object.entries(assignments).filter(([, assignment]) => identityKey(assignment.principal_id) === identity)
    .map(([name, assignment]) => ({ name, scope: assignment.scope, role: assignment.role_definition_id.split('/').pop()! }));
  const secretId = (key: string) => `${layout.vault.id}/secrets/test--${key.toLowerCase().replace(/_/g, '-')}`;
  /** Any role at the secret itself or at a scope containing it: the vault, the resource group, the subscription. */
  const covering = (identity: string, key: string) => held(identity).filter(({ scope }) => {
    const target = secretId(key).toLowerCase();
    return target === scope.toLowerCase() || target.startsWith(`${scope.toLowerCase().replace(/\/$/, '')}/`);
  });
  const canRead = (workload: string, key: string) => attached(workload).some((identity) => covering(identity, key).length > 0);
  const container = (workload: string) => workloads[workload]!.template[0]!.container[0]!;
  const env = (workload: string) => container(workload).env.map((entry) => entry.name).sort();
  const secretNames = (workload: string) => workloads[workload]!.secret.map((entry) => entry.name).sort();
  return { files, assignments, workloads, identities: all('azurerm_user_assigned_identity') as Record<string, { name: string }>, sleeps: all('time_sleep') as Record<string, { depends_on: string[]; triggers?: Record<string, string> }>,
    identityKey, attached, held, covering, canRead, env, secretNames, container, secretId };
}

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/azure-environment-before-secret-scope.json', import.meta.url), 'utf8')) as Record<'plain' | 'ci' | 'noImage', unknown>;
const everywhere = { SOURCE_KEY: delegated, SIGNING_KEY: generated, PLAIN: delegated };
const narrowed = { ...everywhere, SOURCE_KEY: { ...delegated, services: ['catchup'] } };
const WORKLOADS = ['web', 'worker', 'queue', 'catchup'] as const;

describe('an Azure environment that limits no secret', () => {
  // The fixture was generated by the code at 060dd723, before service identities existed.
  it.each([
    ['plain', { imported: ['IMPORTED_KEY'] }], ['ci', { ci: true }], ['noImage', { image: false }],
  ] as const)('generates exactly the configuration it did before (%s)', (name, options) => {
    const config = configuration(everywhere, options);
    expect(JSON.parse(JSON.stringify(config))).toEqual(fixture[name]);
    // Same order too: nothing for a plan to report.
    expect(JSON.stringify(config)).toBe(JSON.stringify(fixture[name]));
  });

  it('is unchanged by a secret limited in another environment only', () => {
    const elsewhere = { ...everywhere, OTHER_KEY: { ...delegated, environments: ['other'], services: ['web'] } };
    const spec = parse(elsewhere, { other: true });
    expect(azureSecretServices(spec, 'test')).toEqual({});
    expect(azureSecretServices(spec, 'other')).toEqual({ OTHER_KEY: ['web'] });
    expect(JSON.stringify(buildAzureEnvironmentConfiguration(engineInput(spec)))).toBe(JSON.stringify(configuration(everywhere)));
    expect(engineInput(spec)).not.toHaveProperty('secretServices');
  });
});

describe('a secret limited to named services on Azure', () => {
  it('is accepted, and reported for the named services only', () => {
    const spec = parse(narrowed);
    expect(azureEngineProblems(spec, 'test')).toEqual([]);
    expect(engineEnvironmentProblems(spec, 'test')).toEqual([]);
    expect(credentialRuntimeServices(spec, 'test', 'SOURCE_KEY')).toEqual(['catchup']);
    expect(credentialRuntimeServices(spec, 'test', 'PLAIN')).toEqual(['catchup', 'queue', 'web', 'worker']);
    expect(engineInput(spec).secretServices).toEqual({ SOURCE_KEY: ['catchup'] });
  });

  it('puts the secret only in the named workload', () => {
    const access = generatedAccess(configuration(narrowed));
    expect(access.env('catchup')).toContain('SOURCE_KEY');
    expect(access.secretNames('catchup')).toContain('source-key');
    for (const workload of ['web', 'worker', 'queue']) {
      expect(access.env(workload)).not.toContain('SOURCE_KEY');
      expect(access.secretNames(workload)).not.toContain('source-key');
      // Unlimited secrets still reach everyone.
      expect(access.env(workload)).toEqual(expect.arrayContaining(['DATABASE_URL', 'PLAIN', 'SIGNING_KEY']));
    }
    expect(access.env('catchup')).toEqual(expect.arrayContaining(['DATABASE_URL', 'PLAIN', 'SIGNING_KEY']));
    // Nothing but the job and its identity's role refers to the limited secret.
    const rest = structuredClone(access.files) as Record<string, any>;
    delete rest['jobs.tf.json'].resource.azurerm_container_app_job.catchup;
    delete rest['base.tf.json'].resource.azurerm_role_assignment.app_catchup_secret_source_key;
    expect(JSON.stringify(rest)).not.toContain('source-key');
  });

  it('gives no identity attached to an unnamed workload a role that reaches the secret', () => {
    const access = generatedAccess(configuration(narrowed));
    for (const workload of ['web', 'worker', 'queue']) {
      expect(access.attached(workload)).toEqual(['runtime']);
      expect(access.canRead(workload, 'SOURCE_KEY')).toBe(false);
    }
    expect(access.covering('runtime', 'SOURCE_KEY')).toEqual([]);
    // The shared identity keeps exactly what the unnamed workloads still need.
    expect(access.held('runtime').map(({ name }) => name).sort()).toEqual(['runtime_pull', 'runtime_storage', 'secret_database_url', 'secret_hv_waker_url', 'secret_plain', 'secret_signing_key']);
  });

  it('lets the named workload read it through its own identity, attached to nothing else', () => {
    const access = generatedAccess(configuration(narrowed));
    expect(access.attached('catchup')).toEqual(['app_catchup']);
    expect(access.canRead('catchup', 'SOURCE_KEY')).toBe(true);
    expect(access.covering('app_catchup', 'SOURCE_KEY')).toEqual([{ name: 'app_catchup_secret_source_key', scope: access.secretId('SOURCE_KEY'), role: AZURE_ROLES.keyVaultSecretsUser }]);
    for (const workload of ['web', 'worker', 'queue']) expect(access.attached(workload)).not.toContain('app_catchup');
    expect(access.identities.app_catchup!.name).toBe('hv-clone-test-catchup-id');
    expect(Object.keys(access.identities).sort()).toEqual(['app_catchup', 'runtime']);
  });

  it('leaves no role, on any identity, at a scope wider than one secret, registry or storage account', () => {
    for (const options of [{}, { ci: true }]) {
      const access = generatedAccess(configuration({ ...narrowed, SIGNING_KEY: { ...generated, services: ['web', 'queue'] } }, options));
      const runtimeIdentities = Object.keys(access.identities).filter((identity) => identity !== 'ci');
      expect(runtimeIdentities.sort()).toEqual(['app_catchup', 'app_queue', 'app_web', 'runtime']);
      for (const identity of runtimeIdentities) {
        for (const { name, scope, role } of access.held(identity)) {
          // Only the three data roles setup lets the deploy identity assign: no Contributor, no identity or role administration.
          expect(AZURE_APP_ROLES, name).toContain(role);
          if (role === AZURE_ROLES.keyVaultSecretsUser) expect(scope, name).toMatch(new RegExp(`^${layout.vault.id}/secrets/test--[a-z0-9-]+$`));
          else if (role === AZURE_ROLES.acrPull) expect(scope, name).toMatch(new RegExp(`^${group}/providers/Microsoft.ContainerRegistry/registries/[a-z0-9]+$`));
          else expect(scope, name).toBe('${azurerm_storage_account.files.id}');
        }
      }
      // Every role assignment belongs to a known identity; none slips past the checks above.
      for (const [name, assignment] of Object.entries(access.assignments)) expect(Object.keys(access.identities), name).toContain(access.identityKey(assignment.principal_id));
      for (const key of ['SOURCE_KEY', 'SIGNING_KEY']) {
        const allowed = key === 'SOURCE_KEY' ? ['catchup'] : ['queue', 'web'];
        expect(WORKLOADS.filter((workload) => access.canRead(workload, key)).sort()).toEqual(allowed);
        expect(Object.keys(access.identities).filter((identity) => access.covering(identity, key).length).sort()).toEqual(allowed.map((service) => `app_${service}`));
      }
    }
  });

  it('attaches exactly one identity to each workload and uses it for pulls, secrets and AZURE_CLIENT_ID', () => {
    const access = generatedAccess(configuration({ ...narrowed, SIGNING_KEY: { ...generated, services: ['web', 'queue'] } }, { ci: true }));
    const expected = { web: 'app_web', worker: 'runtime', queue: 'app_queue', catchup: 'app_catchup' };
    for (const workload of WORKLOADS) {
      const identity = expected[workload];
      const block = access.workloads[workload]!;
      expect(block.identity).toEqual([{ type: 'UserAssigned', identity_ids: [`\${azurerm_user_assigned_identity.${identity}.id}`] }]);
      expect(block.registry).toHaveLength(2);
      for (const entry of [...block.registry, ...block.secret]) expect(access.identityKey(entry.identity)).toBe(identity);
      expect(access.container(workload).env.find((entry) => entry.name === 'AZURE_CLIENT_ID')!.value).toBe(`\${azurerm_user_assigned_identity.${identity}.client_id}`);
      // Each secret the workload references is one its identity may read: the first revision can start.
      for (const entry of block.secret) {
        expect(access.held(identity).map(({ scope }) => scope), `${workload} ${entry.name}`).toContain(`${layout.vault.id}/secrets/${entry.key_vault_secret_id.split('/secrets/')[1]}`);
      }
      // Both registries stay pullable.
      expect(access.held(identity).filter(({ role }) => role === AZURE_ROLES.acrPull)).toHaveLength(2);
    }
  });

  it('keeps the CI identity off every workload and without a way to read secrets or attach identities', () => {
    const access = generatedAccess(configuration(narrowed, { ci: true }));
    for (const workload of WORKLOADS) expect(access.attached(workload)).not.toContain('ci');
    expect(access.held('ci').map(({ name }) => name).sort()).toEqual(['ci_build', 'ci_job_catchup', 'ci_queue', 'ci_web', 'ci_worker']);
    for (const key of ['SOURCE_KEY', 'PLAIN']) expect(access.covering('ci', key)).toEqual([]);
    const actions = [...AZURE_CI_ACTIONS.release, ...AZURE_CI_ACTIONS.build].join(' ');
    expect(actions).not.toMatch(/listSecrets|\*|Microsoft\.ManagedIdentity|Microsoft\.Authorization|Microsoft\.KeyVault/i);
  });

  it('keeps an on-demand worker scaling when it is named: its own identity reads the scale rule login', () => {
    const access = generatedAccess(configuration({ ...everywhere, SOURCE_KEY: { ...delegated, services: ['queue', 'worker'] } }));
    expect(access.attached('queue')).toEqual(['app_queue']);
    expect(access.workloads.queue!.template[0]!.custom_scale_rule![0]!.authentication).toEqual([{ secret_name: 'hv-waker-url', trigger_parameter: 'connection' }]);
    expect(access.secretNames('queue')).toContain('hv-waker-url');
    expect(access.covering('app_queue', 'HV_WAKER_URL')).toHaveLength(1);
    expect(access.env('queue')).not.toContain('HV_WAKER_URL');
    // A named worker that does not scale on demand has no use for that login.
    expect(access.secretNames('worker')).not.toContain('hv-waker-url');
    expect(access.covering('app_worker', 'HV_WAKER_URL')).toEqual([]);
  });

  it('gives a service identity the storage role only when the service uses storage', () => {
    const access = generatedAccess(configuration({ ...everywhere, SOURCE_KEY: { ...delegated, services: ['catchup', 'worker'] } }));
    expect(access.held('app_catchup').map(({ name }) => name)).toContain('app_catchup_storage');
    expect(access.held('app_worker').map(({ name }) => name).sort()).toEqual(['app_worker_pull', 'app_worker_secret_database_url', 'app_worker_secret_plain', 'app_worker_secret_signing_key', 'app_worker_secret_source_key']);
  });

  it('starts a named workload only after its own roles have applied', () => {
    const access = generatedAccess(configuration(narrowed));
    expect(access.workloads.catchup!.depends_on).toEqual(['time_sleep.roles_app_catchup']);
    const own = access.held('app_catchup').map(({ name }) => `azurerm_role_assignment.${name}`);
    expect(access.sleeps.roles_app_catchup!.depends_on.sort()).toEqual(own.sort());
    expect(access.sleeps.roles_app_catchup!.triggers).toEqual({ roles: access.held('app_catchup').map(({ name }) => name).join(',') });
    expect(access.workloads.web!.depends_on).toEqual(['time_sleep.roles']);
    expect(access.sleeps.roles!.depends_on.sort()).toEqual(access.held('runtime').map(({ name }) => `azurerm_role_assignment.${name}`).sort());
  });

  it('holds no role on a limited secret before the workloads exist', () => {
    const access = generatedAccess(configuration(narrowed, { image: false }));
    expect(Object.keys(access.identities)).toEqual(['runtime']);
    expect(Object.keys(access.assignments).filter((name) => name.includes('source_key'))).toEqual([]);
  });

  it('refuses a limited secret it cannot isolate', () => {
    const token = parse({ ...everywhere, NPM_TOKEN: { ...delegated, services: ['web'] } });
    expect(azureEngineProblems(token, 'test')).toEqual([expect.stringContaining('Secret NPM_TOKEN is a package token')]);
    const waker = parse({ ...everywhere, HV_WAKER_URL: { ...delegated, services: ['web'] } });
    expect(azureEngineProblems(waker, 'test')).toEqual([expect.stringContaining('Secret HV_WAKER_URL is the read-only login')]);
    expect(azureEngineProblems(parse({ ...everywhere, NPM_TOKEN: delegated }), 'test')).toEqual([]);
    const input = engineInput(parse(narrowed));
    for (const key of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'HV_WAKER_URL']) {
      expect(() => buildAzureEnvironmentConfiguration({ ...input, secretServices: { [key]: ['web'] } })).toThrow(`Secret ${key} cannot be limited to named services on Azure.`);
    }
  });

  it('refuses two named services that would share one identity', () => {
    const input = engineInput(parse(narrowed));
    const twin = { ...input.jobs![0]!, logicalName: 'catch-up', resourceName: 'hv-clone-test-catch-up' };
    const first = { ...input.jobs![0]!, logicalName: 'catch_up' };
    expect(() => buildAzureEnvironmentConfiguration({ ...input, jobs: [first, twin], secretServices: { SOURCE_KEY: ['catch_up', 'catch-up'] } })).toThrow(/need distinct names/);
  });
});

describe('the release command on Azure', () => {
  // Azure has no release command yet, so nothing borrows a service's configuration or identity.
  const withRelease = { environment: { migrations: { mode: 'releaseCommand', command: 'clone migrate' } } };

  it('is refused in planning and at release, with or without a limited secret', async () => {
    for (const secrets of [everywhere, narrowed]) {
      const spec = parse(secrets, withRelease);
      expect(azureEngineProblems(spec, 'test')).toContain('migrations.mode="releaseCommand" is not yet supported on Azure.');
      const released = await releaseAzureEngineServices({} as never, { project: project as never, spec, environmentName: 'test', specRevision: 1 });
      expect(released).toEqual({ blocked: 'Release commands are not available on Azure yet; run migrations when the app starts instead.' });
    }
  });

  it('adds no workload beyond the declared services, so a limited secret has no extra holder', () => {
    const access = generatedAccess(buildAzureEnvironmentConfiguration(engineInput(parse(narrowed, withRelease))));
    expect(Object.keys(access.workloads).sort()).toEqual([...WORKLOADS].sort());
    expect(WORKLOADS.filter((workload) => access.canRead(workload, 'SOURCE_KEY'))).toEqual(['catchup']);
  });
});

describe('narrowing a secret every service already holds', () => {
  const before = configuration(everywhere, { ci: true });
  const after = configuration(narrowed, { ci: true });
  const addressed = (config: typeof before) => {
    const files = config.files as Record<string, { resource?: Record<string, Record<string, unknown>> }>;
    const found: Record<string, unknown> = {};
    for (const file of Object.values(files)) for (const [type, instances] of Object.entries(file.resource ?? {})) for (const [name, body] of Object.entries(instances)) found[`${type}.${name}`] = body;
    return found;
  };
  const was = addressed(before);
  const now = addressed(after);
  const changed = Object.keys(now).filter((address) => address in was && JSON.stringify(now[address]) !== JSON.stringify(was[address])).sort();

  it('adds the service identity and its roles, and removes the shared identity\'s role on the secret', () => {
    expect(Object.keys(now).filter((address) => !(address in was)).sort()).toEqual([
      'azurerm_role_assignment.app_catchup_ci_pull', 'azurerm_role_assignment.app_catchup_pull', 'azurerm_role_assignment.app_catchup_secret_database_url',
      'azurerm_role_assignment.app_catchup_secret_plain', 'azurerm_role_assignment.app_catchup_secret_signing_key', 'azurerm_role_assignment.app_catchup_secret_source_key',
      'azurerm_role_assignment.app_catchup_storage', 'azurerm_user_assigned_identity.app_catchup', 'time_sleep.roles_app_catchup',
    ]);
    expect(Object.keys(was).filter((address) => !(address in now))).toEqual(['azurerm_role_assignment.secret_source_key']);
    // Every generated resource is mapped to a plan action, the new ones included.
    expect(Object.keys(after.resources)).toEqual(expect.arrayContaining(Object.keys(now)));
    expect(after.resources['azurerm_user_assigned_identity.app_catchup']).toEqual({ actionId: 'identity:service:catchup', kind: 'service', name: 'catchup identity' });
  });

  it('updates the workloads in place and touches nothing that holds data', () => {
    // The wait's list of roles changes too; OpenTofu reports no action for a dependency-only change.
    expect(changed).toEqual(['azurerm_container_app.queue', 'azurerm_container_app.web', 'azurerm_container_app.worker', 'azurerm_container_app_job.catchup', 'time_sleep.roles']);
    for (const address of changed.filter((entry) => entry.startsWith('azurerm_container_app'))) {
      const { identity, registry, secret, template, depends_on, ...rest } = now[address] as Record<string, unknown>;
      const { identity: _i, registry: _r, secret: _s, template: _t, depends_on: _d, ...restBefore } = was[address] as Record<string, unknown>;
      // Name, resource group and app environment (what would replace an app) are untouched.
      expect(rest).toEqual(restBefore);
      expect([identity, registry, secret, template, depends_on].every(Boolean)).toBe(true);
    }
    const { depends_on: _before, ...sleepBefore } = was['time_sleep.roles'] as Record<string, unknown>;
    const { depends_on: _after, triggers, ...sleepAfter } = now['time_sleep.roles'] as Record<string, unknown>;
    expect(sleepAfter).toEqual(sleepBefore);
    // With a limit, the shared wait follows the shared identity's role set: it waits again when a limit is added
    // or removed, so unnamed apps never start on a role that has not applied yet.
    expect(sleepBefore).not.toHaveProperty('triggers');
    expect(triggers).toEqual({ roles: expect.not.stringContaining('secret_source_key') });
    expect((triggers as { roles: string }).roles).toContain('secret_plain');
    const dataBearing = Object.entries(after.resources).filter(([, mapping]) => mapping.dataBearing).map(([address]) => address).sort();
    expect(dataBearing).toEqual(['azurerm_storage_account.files', 'azurerm_storage_container.documents', 'azurerm_storage_container.exports']);
    for (const address of dataBearing) expect(now[address]).toEqual(was[address]);
    expect(now['azurerm_user_assigned_identity.runtime']).toEqual(was['azurerm_user_assigned_identity.runtime']);
    // The engine never manages a Key Vault secret, and the database server lives in the shared state, which no secret reaches.
    expect(Object.keys(now).filter((address) => /key_vault|postgresql/.test(address))).toEqual([]);
    const shared = (secrets: Record<string, unknown>) => buildAzureSharedInput(parse(secrets, { ci: true }), { connection: connection as never, shared: layout.shared as never, project: project as never }, ['test']);
    expect(shared(narrowed)).toEqual(shared(everywhere));
  });

  it('blocks the plan while the shared identity holds a role in Azure that reaches the secret', () => {
    const input = engineInput(parse(narrowed));
    const role = (id: string) => `/subscriptions/x/providers/Microsoft.Authorization/roleDefinitions/${id}`;
    const secretsUser = '4633458b-17de-408a-b874-0445c86b69e6';
    const secret = `${layout.vault.id}/secrets/test--source-key`;
    const reach = (scope: string, id = secretsUser, removing: string[] = []) => azureSharedIdentityReach(input, [{ scope, roleDefinitionId: role(id) }], removing);
    // Its own per-secret role is fine only while this plan removes it.
    expect(reach(secret, secretsUser, ['azurerm_role_assignment.secret_source_key'])).toEqual([]);
    expect(reach(secret)).toEqual([expect.stringContaining('Key Vault Secrets User')]);
    // Vault, resource group and subscription all cover the secret.
    for (const scope of [layout.vault.id, group, `/subscriptions/${connection.subscriptionId}`]) expect(reach(scope.toUpperCase())).toHaveLength(1);
    expect(reach(group, '00482a5a-887f-4fb3-b363-3b7fe8e74483')).toEqual([expect.stringContaining('Key Vault Administrator')]);
    expect(reach(group, 'f1a07417-d97a-45cb-824c-7a7467783830')).toEqual([expect.stringContaining('Managed Identity Operator')]);
    // Roles that do not reach it: another secret, another vault, image pull on the group.
    expect(reach(`${layout.vault.id}/secrets/test--plain`)).toEqual([]);
    expect(reach(`${group}/providers/Microsoft.KeyVault/vaults/other`)).toEqual([]);
    expect(reach(group, '7f951dda-4ed3-4680-a7ca-43fe172d538d')).toEqual([]);
    // Nothing is checked, and nothing blocks, for a spec that limits no secret.
    expect(azureSharedIdentityReach(engineInput(parse(everywhere)), [{ scope: group, roleDefinitionId: role(secretsUser) }], [])).toEqual([]);
  });

  it('never takes over the shared identity\'s role on the secret as the service identity\'s', async () => {
    const requests: string[] = [];
    const principals: Record<string, string> = { 'hv-clone-test-runtime': 'p-runtime', 'hv-clone-test-catchup-id': 'p-catchup' };
    const assignment = (id: string, principalId: string, scope: string, role: string) => ({ id, properties: { principalId, scope, roleDefinitionId: `/subscriptions/x/providers/Microsoft.Authorization/roleDefinitions/${role}` } });
    const sourceKey = `${layout.vault.id}/secrets/test--source-key`;
    const fetchImpl = (async (url: string) => {
      requests.push(url);
      const identity = /userAssignedIdentities\/([^?]+)\?/.exec(url)?.[1];
      if (identity) return new Response(JSON.stringify({ properties: { principalId: principals[identity] } }), { status: principals[identity] ? 200 : 404 });
      const principal = /principalId%20eq%20'([^']+)'/.exec(url)?.[1];
      return new Response(JSON.stringify({ value: principal === 'p-runtime'
        ? [assignment('/ra/runtime-source', 'p-runtime', sourceKey, AZURE_ROLES.keyVaultSecretsUser)]
        : [assignment('/ra/catchup-plain', 'p-catchup', `${layout.vault.id}/secrets/test--plain`, AZURE_ROLES.keyVaultSecretsUser)] }), { status: 200 });
    }) as unknown as typeof fetch;
    const context = { connection, prefix: layout.prefix, environment: { id: 'ENV1' }, tokens: { get: async () => 'token', fetchImpl } } as unknown as AzureEngineContext;
    const creating = ['azurerm_role_assignment.app_catchup_secret_source_key', 'azurerm_role_assignment.app_catchup_secret_plain', 'azurerm_role_assignment.ci_web'];
    const action = { id: 'identity:service:catchup', type: 'create', resource: { kind: 'service', name: 'catchup identity', provider: 'azure' },
      metadata: { engineSegment: { id: 'opentofu:p', engine: 'opentofu', planDigest: 'd', addresses: creating } } } as unknown as PlanAction;
    const found = await leftoverRoleAssignments(context, engineInput(parse(narrowed, { ci: true }), { ci: true }), [action]);
    // The runtime identity holds a role with the same scope and role as the one planned for catchup; it is not adopted.
    expect(found).toEqual({ adopt: { 'azurerm_role_assignment.app_catchup_secret_plain': '/ra/catchup-plain' } });
    expect(requests.filter((url) => url.includes('userAssignedIdentities')).map((url) => /userAssignedIdentities\/([^?]+)/.exec(url)![1])).toEqual(['hv-clone-test-catchup-id']);
  });
});

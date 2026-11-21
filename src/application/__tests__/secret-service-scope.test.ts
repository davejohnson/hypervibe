import { describe, expect, it } from 'vitest';
import { projectSpecSchema, type ProjectSpec } from '../../domain/spec/spec.schema.js';
import { engineEnvironmentProblems } from '../../domain/services/infrastructure-engine-selection.js';
import { credentialRuntimeServices } from '../../domain/services/credential-runtime-consumers.js';
import { secretServiceScopeProblems, secretServicesFor } from '../../domain/services/secret-service-scope.js';
import { buildCloudRunConfiguration } from '../../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { buildEngineInput } from '../infrastructure-engine.js';
import { azureEngineProblems } from '../infrastructure-engine-azure.js';

// Contract (docs/development/connections.md): a secret that names services reaches
// only those services. Where hosting cannot do that, the spec is refused; it is
// never accepted and then given to every service.
const runtime = 'runtime@demo-project.iam.gserviceaccount.com';
const delegated = { ownership: 'delegated', principal: 'source system administrator', environments: ['staging'] };
const generated = { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, environments: ['staging'] };

function document(secrets: Record<string, unknown>, provider = 'cloudrun', hosting: Record<string, unknown> = {}) {
  return { version: 1, project: 'clone', environments: { staging: {
    hosting: { provider, ...hosting },
    services: {
      web: {}, worker: { workloadKind: 'worker' },
      catchup: { workloadKind: 'cron', cronSchedule: '*/15 * * * *', startCommand: 'clone catchup' },
    },
    ...(provider === 'cloudrun' ? { migrations: { mode: 'releaseCommand', command: 'clone migrate' } } : {}),
  } }, secrets };
}

const parse = (secrets: Record<string, unknown>, provider?: string, hosting?: Record<string, unknown>) => projectSpecSchema.parse(document(secrets, provider, hosting));
const issues = (secrets: Record<string, unknown>, provider?: string) =>
  (projectSpecSchema.safeParse(document(secrets, provider)).error?.issues ?? []).map(issue => ({ path: issue.path.join('.'), message: issue.message }));

function engineInput(spec: ProjectSpec) {
  return buildEngineInput(spec, 'staging', {
    gcpProjectId: 'demo-project', region: 'us-west1', runtimeServiceAccountEmail: runtime, resourceNameFor: name => name,
    databaseWired: true, importedSecrets: ['SOURCE_KEY'], secretVersions: { SOURCE_KEY: '3', SIGNING_KEY: '1', DATABASE_URL: '2' },
  });
}

/** Environment variable names of every workload in the generated OpenTofu configuration. */
function generatedEnv(spec: ProjectSpec, extra: Record<string, unknown> = {}) {
  const config = buildCloudRunConfiguration({ ...engineInput(spec), runtimeServiceAccountEmail: runtime, environmentId: 'env-123', ...extra } as Parameters<typeof buildCloudRunConfiguration>[0]);
  const files = config.files as Record<string, any>;
  const names = (container: { env?: Array<{ name: string }> }) => (container.env ?? []).map(entry => entry.name).sort();
  const jobs = files['jobs.tf.json'].resource.google_cloud_run_v2_job;
  return { config, files, env: {
    web: names(files['cloudrun.tf.json'].resource.google_cloud_run_v2_service.web.template[0].containers[0]),
    worker: names(files['workerpools.tf.json'].resource.google_cloud_run_v2_worker_pool.worker.template[0].containers[0]),
    catchup: names(jobs.catchup.template[0].template[0].containers[0]),
    release: names(jobs.release_command.template[0].template[0].containers[0]),
  } };
}

describe('declaring the services a secret reaches', () => {
  it('accepts named services on both kinds of secret and leaves an existing declaration unchanged', () => {
    const spec = parse({ SOURCE_KEY: { ...delegated, services: ['catchup'] }, SIGNING_KEY: { ...generated, services: ['web', 'worker'] }, PLAIN: delegated });
    expect(spec.secrets.SOURCE_KEY!.services).toEqual(['catchup']);
    expect(spec.secrets.SIGNING_KEY!.services).toEqual(['web', 'worker']);
    expect('services' in spec.secrets.PLAIN!).toBe(false);
  });

  it('rejects an empty or repeated list', () => {
    expect(issues({ SOURCE_KEY: { ...delegated, services: [] } })).toEqual([expect.objectContaining({ path: 'secrets.SOURCE_KEY.services' })]);
    expect(issues({ SIGNING_KEY: { ...generated, services: ['web', 'web'] } })).toEqual([{ path: 'secrets.SIGNING_KEY.services', message: 'services cannot contain duplicates' }]);
  });

  it('names the secret, the service and the environment when a service is not declared there', () => {
    const document_ = document({ SOURCE_KEY: { ...delegated, environments: ['staging', 'production'], services: ['catchup'] } }) as any;
    document_.environments.production = { hosting: { provider: 'cloudrun' }, services: { web: {} } };
    const result = projectSpecSchema.safeParse(document_);
    expect(result.error?.issues.map(issue => issue.message)).toEqual([
      'delegated secret "SOURCE_KEY" names service "catchup", which environment "production" does not declare',
    ]);
    expect(issues({ SIGNING_KEY: { ...generated, services: ['api'] } })).toEqual([{ path: 'secrets.SIGNING_KEY.services',
      message: 'Hypervibe-owned secret "SIGNING_KEY" names service "api", which environment "staging" does not declare' }]);
  });

  it.each(['railway', 'azure'])('refuses named services on %s instead of giving the secret to every service', (provider) => {
    expect(projectSpecSchema.safeParse(document({ SOURCE_KEY: delegated }, provider)).success).toBe(true);
    const found = issues({ SOURCE_KEY: { ...delegated, services: ['catchup'] } }, provider);
    expect(found).toEqual([{ path: 'secrets.SOURCE_KEY.services', message: expect.stringContaining(`hosting provider "${provider}" does not support yet`) }]);
    expect(issues({ SIGNING_KEY: { ...generated, services: ['web'] } }, provider)).toHaveLength(1);
  });

  it('refuses named services on a tracked credential and on a secret with no runtime environment', () => {
    const credential = { role: 'source-api', label: 'Source API key', purpose: 'Reads the source system', kind: 'opaque', source: 'env:PRIVATE_INPUT' };
    const tracked = projectSpecSchema.safeParse(document({ SOURCE_KEY: { ...delegated, services: ['catchup'], credential } }));
    expect(tracked.error?.issues.map(issue => issue.message).filter(message => message.includes('credential tracking'))).toHaveLength(1);
    expect(issues({ SOURCE_KEY: { ownership: 'delegated', principal: 'owner', githubActions: { repository: true }, services: ['catchup'] } }))
      .toContainEqual({ path: 'secrets.SOURCE_KEY.services', message: 'services limits runtime injection and requires at least one runtime environment' });
  });
});

describe('a secret limited to named services on Cloud Run', () => {
  it('gives an unscoped secret to every service and the release command, as before', () => {
    const { env } = generatedEnv(parse({ SOURCE_KEY: delegated, SIGNING_KEY: generated }));
    for (const workload of ['web', 'worker', 'catchup', 'release'] as const) {
      expect(env[workload]).toEqual(expect.arrayContaining(['DATABASE_URL', 'SIGNING_KEY', 'SOURCE_KEY']));
    }
  });

  it('generates the same configuration when the list names every service', () => {
    const everywhere = generatedEnv(parse({ SOURCE_KEY: delegated, SIGNING_KEY: generated })).files;
    const named = generatedEnv(parse({ SOURCE_KEY: { ...delegated, services: ['catchup', 'web', 'worker'] }, SIGNING_KEY: { ...generated, services: ['worker', 'web', 'catchup'] } })).files;
    expect(named).toEqual(everywhere);
  });

  it('removes a narrowed secret from the other services and from the release command', () => {
    const before = engineInput(parse({ SOURCE_KEY: delegated, SIGNING_KEY: generated }));
    const spec = parse({ SOURCE_KEY: { ...delegated, services: ['catchup'] }, SIGNING_KEY: { ...generated, services: ['web', 'worker'] } });
    const after = engineInput(spec);
    const keys = (input: typeof after, name: string) => Object.keys(input.services.find(service => service.logicalName === name)!.secretEnv ?? {}).sort();
    expect(keys(before, 'web')).toEqual(['DATABASE_URL', 'SIGNING_KEY', 'SOURCE_KEY']);
    expect(keys(after, 'web')).toEqual(['DATABASE_URL', 'SIGNING_KEY']);
    expect(keys(after, 'worker')).toEqual(['DATABASE_URL', 'SIGNING_KEY']);
    expect(keys(after, 'catchup')).toEqual(['DATABASE_URL', 'SOURCE_KEY']);
    // The release command borrows the web service's configuration.
    expect(Object.keys(after.releaseJob!.secretEnv ?? {}).sort()).toEqual(['DATABASE_URL', 'SIGNING_KEY']);

    const { env, files } = generatedEnv(spec);
    expect(env.web).not.toContain('SOURCE_KEY');
    expect(env.worker).not.toContain('SOURCE_KEY');
    expect(env.release).not.toContain('SOURCE_KEY');
    expect(env.catchup).toContain('SOURCE_KEY');
    expect(env.catchup).not.toContain('SIGNING_KEY');
    expect(env.web).toContain('SIGNING_KEY');
    // Nothing but the scheduled job's block refers to the narrowed secret.
    const withoutJob = structuredClone(files);
    delete withoutJob['jobs.tf.json'].resource.google_cloud_run_v2_job.catchup;
    expect(JSON.stringify(withoutJob)).not.toContain('hv-staging-source-key');
  });

  it('keeps the release command off a secret limited to a service other than the one it borrows', () => {
    const spec = parse({ SOURCE_KEY: { ...delegated, services: ['worker'] } });
    const { env } = generatedEnv(spec);
    expect(env.worker).toContain('SOURCE_KEY');
    expect(env.release).toEqual(env.web);
    expect(env.release).not.toContain('SOURCE_KEY');
  });

  it('refuses per-secret grants to the shared identity together with a limited secret', () => {
    // gcpRuntimeSecretGrants grants each referenced secret to the one shared identity; a limited secret must never be granted to it.
    const result = projectSpecSchema.safeParse(document({ SOURCE_KEY: { ...delegated, services: ['catchup'] } }, 'cloudrun', { gcpRuntimeSecretGrants: 'per-secret' }));
    expect(result.error?.issues.map(issue => issue.message)).toEqual([expect.stringContaining('cannot be combined with gcpRuntimeSecretGrants')]);
    expect(projectSpecSchema.safeParse(document({ SOURCE_KEY: delegated }, 'cloudrun', { gcpRuntimeSecretGrants: 'per-secret' })).success).toBe(true);
  });

  it('reports the services that hold a secret', () => {
    const spec = parse({ SOURCE_KEY: { ...delegated, services: ['catchup'] }, PLAIN: delegated });
    expect(secretServicesFor(spec, 'staging', 'SOURCE_KEY')).toEqual(['catchup']);
    expect(credentialRuntimeServices(spec, 'staging', 'SOURCE_KEY')).toEqual(['catchup']);
    expect(credentialRuntimeServices(spec, 'staging', 'PLAIN')).toEqual(['catchup', 'web', 'worker']);
    expect(engineEnvironmentProblems(spec, 'staging')).toEqual([]);
  });
});

describe('planning a spec that reached a provider without service scoping', () => {
  // The schema refuses these specs; planners check again so a later schema change cannot widen a secret.
  const unvalidated = (provider: string) => {
    const spec = parse({ SOURCE_KEY: delegated, PLAIN: delegated }, provider);
    return { ...spec, secrets: { ...spec.secrets, SOURCE_KEY: { ...spec.secrets.SOURCE_KEY!, services: ['catchup'] } } } as ProjectSpec;
  };

  it.each([['azure', azureEngineProblems]] as const)('blocks the %s plan', (provider, problems) => {
    const expected = expect.stringContaining('Secret SOURCE_KEY is limited to named services');
    expect(problems(unvalidated(provider), 'staging')).toContainEqual(expected);
    expect(engineEnvironmentProblems(unvalidated(provider), 'staging')).toContainEqual(expected);
    expect(problems(parse({ SOURCE_KEY: delegated }, provider), 'staging').join(' ')).not.toContain('named services');
  });

  it('stops Railway from resolving the secret to every service', () => {
    const spec = unvalidated('railway');
    expect(secretServiceScopeProblems(spec, 'staging')).toHaveLength(1);
    expect(() => credentialRuntimeServices(spec, 'staging', 'SOURCE_KEY')).toThrow(/limited to named services/);
    expect(credentialRuntimeServices(spec, 'staging', 'PLAIN')).toEqual(['catchup', 'web', 'worker']);
  });
});

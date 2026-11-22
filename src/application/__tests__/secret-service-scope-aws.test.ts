import fs from 'fs';
import { describe, expect, it } from 'vitest';
import { projectSpecSchema, type ProjectSpec } from '../../domain/spec/spec.schema.js';
import { awsEngineBackend } from '../../adapters/providers/aws/tofu/aws-engine.backend.js';
import { buildAwsBuildConfiguration, buildAwsConfiguration, type AwsEngineInput } from '../../adapters/providers/aws/tofu/aws-engine.config.js';
import { awsWorkloadRoleArn } from '../../adapters/providers/aws/aws-secret-scope.js';
import { awsEngineProblems, buildAwsEngineInput } from '../infrastructure-engine-aws.js';

const account = '111122223333';
const region = 'us-west-2';
const prefix = 'hv-clone-preview';
const image = `${account}.dkr.ecr.${region}.amazonaws.com/${prefix}@sha256:${'a'.repeat(64)}`;
const delegated = { ownership: 'delegated', principal: 'source system administrator', environments: ['preview'] };
const generated = { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, environments: ['preview'] };

/** A varied AWS environment: public web, private web or CI, worker, on-demand worker, scheduled job, bucket, database. */
function document(secrets: Record<string, unknown>, variant: 'ci' | 'private-web' = 'ci', extra: Record<string, unknown> = {}) {
  return { version: 1, project: 'clone', gitRemoteUrl: 'https://github.com/owner/clone.git', environments: { preview: {
    hosting: { provider: 'aws', region },
    ...(variant === 'ci' ? { deploy: { strategy: 'branch', branch: 'main' } } : {}),
    database: { provider: 'rds' },
    storage: { uploads: { type: 'bucket', provider: 's3', region, injectInto: ['web'], versioning: true } },
    envVars: { LOG_LEVEL: 'info' }, ...extra,
    services: {
      web: { healthCheckPath: '/healthz' },
      ...(variant === 'private-web' ? { internal: { public: false } } : {}),
      worker: { workloadKind: 'worker', startCommand: 'clone work' },
      mailer: { workloadKind: 'worker', startCommand: 'clone mail', onDemand: {
        pendingWorkQuery: 'SELECT count(*) FROM outbox WHERE sent_at IS NULL', nextWorkAtQuery: 'SELECT min(send_at) FROM outbox WHERE sent_at IS NULL' } },
      catchup: { workloadKind: 'cron', cronSchedule: '*/15 * * * *', startCommand: 'clone catchup' },
    },
  } }, secrets };
}

const parse = (secrets: Record<string, unknown>, variant?: 'ci' | 'private-web') => projectSpecSchema.parse(document(secrets, variant));
const context = {
  prefix, parameterPath: '/hypervibe/env-123/', environment: { id: 'env-123', platformBindings: { aws: { imageUri: image } } },
  connection: { accountId: account, region }, shared: { clusterArn: `arn:aws:rds:${region}:${account}:cluster:hv-clone-shared-postgres` },
  database: { name: 'app_preview' },
};

/** The generated OpenTofu configuration of the environment and of its image build, as a plan would compare them. */
function generate(spec: ProjectSpec) {
  const input = buildAwsEngineInput(spec, 'preview', context as never, { secretKeys: ['SIGNING_KEY', 'SOURCE_KEY', 'PLAIN', 'DATABASE_URL'] });
  return JSON.parse(JSON.stringify({ environment: awsEngineBackend.buildConfiguration(input), build: buildAwsBuildConfiguration(input) }));
}

// Contract (docs/development/connections.md): a secret that names services reaches only those
// services. On AWS that is an access boundary: the other workloads' roles cannot read the
// parameter, start a task that holds it, or hand its role to anything.

// Generated from the code at 060dd723, before AWS could limit a secret. Never regenerate it from current code.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/aws-unscoped-secrets.configuration.json', import.meta.url), 'utf8'));
const unscoped = { SOURCE_KEY: delegated, SIGNING_KEY: generated, PLAIN: delegated };
const parameter = (key: string) => `arn:aws:ssm:${region}:${account}:parameter/hypervibe/env-123/${key}`;

type Statement = { Sid?: string; Effect: string; Action?: string | string[]; Resource?: string | string[]; NotAction?: unknown; NotResource?: unknown; Condition?: Record<string, Record<string, unknown>> };
type Role = { key: string; name: string; arn: string; trusted: string[]; statements: Statement[] };
type Workload = { name: string; family: string; roleKeys: string[]; secretNames: string[]; parameterArns: string[] };
type Generated = ReturnType<typeof generate>;

const list = <T,>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
/** IAM wildcard matching: `*` any run of characters, `?` one. */
const matches = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test(value);
/** The Allow statements that cover one action on one resource. */
const granting = (role: Role, action: string, resource: string) => role.statements.filter((statement) => statement.Effect === 'Allow'
  && list(statement.Action).some((pattern) => matches(pattern, action)) && list(statement.Resource).some((pattern) => matches(pattern, resource)));

/** Every IAM role in the generated configuration with its parsed trust and inline policy. */
function rolesOf(configuration: Generated): Record<string, Role> {
  const roles: Record<string, Role> = {};
  for (const file of [configuration.environment.files['base.tf.json'], configuration.environment.files['ci.tf.json'], configuration.build.files['builds.tf.json']]) {
    for (const [key, role] of Object.entries<any>(file?.resource.aws_iam_role ?? {})) {
      const policies = Object.values<any>(file.resource.aws_iam_role_policy).filter((policy) => policy.role === `\${aws_iam_role.${key}.id}`);
      const trust = JSON.parse(role.assume_role_policy).Statement as Array<{ Principal: { Service?: string | string[]; Federated?: string } }>;
      roles[key] = { key, name: role.name, arn: `arn:aws:iam::${account}:role${role.path}${role.name}`,
        trusted: trust.flatMap((statement) => [...list(statement.Principal.Service), ...list(statement.Principal.Federated)]).sort(),
        statements: policies.flatMap((policy) => JSON.parse(policy.policy).Statement as Statement[]) };
    }
  }
  return roles;
}

const roleKey = (reference: string) => /^\$\{aws_iam_role\.(\w+)\.arn\}$/.exec(reference)![1]!;

/** Every container the configuration runs: its task and execution role and the parameters wired into it. */
function workloadsOf(configuration: Generated): Record<string, Workload> {
  const resource = configuration.environment.files['tasks.tf.json'].resource;
  const workloads: Record<string, Workload> = {};
  for (const [name, definition] of Object.entries<any>(resource.aws_ecs_task_definition ?? {})) {
    const secrets = JSON.parse(definition.container_definitions).flatMap((container: any) => container.secrets) as Array<{ name: string; valueFrom: string }>;
    workloads[name] = { name, family: definition.family, roleKeys: [roleKey(definition.execution_role_arn), roleKey(definition.task_role_arn)],
      secretNames: secrets.map((secret) => secret.name).sort(), parameterArns: secrets.map((secret) => secret.valueFrom) };
  }
  for (const [name, service] of Object.entries<any>(resource.aws_ecs_express_gateway_service ?? {})) {
    const secrets = service.primary_container.flatMap((container: any) => container.secret) as Array<{ name: string; value_from: string }>;
    workloads[name] = { name, family: service.service_name, roleKeys: [roleKey(service.execution_role_arn), roleKey(service.task_role_arn)],
      secretNames: secrets.map((secret) => secret.name).sort(), parameterArns: secrets.map((secret) => secret.value_from) };
  }
  return workloads;
}

const READS = ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParameterHistory', 'ssm:GetParametersByPath'];
/** Whether the role's own policy lets it read the parameter (by name, by history, or by listing its path). */
const reads = (role: Role, arn: string) => READS.some((action) => granting(role, action, arn).length > 0)
  || [arn.replace(/\/[^/]+$/, ''), arn.replace(/[^/]+$/, '')].some((path) => granting(role, 'ssm:GetParametersByPath', path).length > 0);

/**
 * Whether credentials for the role can end up holding the parameter: by reading it, by handing a role
 * that can to an AWS service, or by starting a task that is wired to it or runs as such a role.
 */
function reaches(roles: Record<string, Role>, workloads: Record<string, Workload>, start: string, arn: string, seen = new Set<string>()): boolean {
  if (seen.has(start)) return false;
  seen.add(start);
  const role = roles[start]!;
  if (reads(role, arn)) return true;
  for (const other of Object.values(roles)) {
    if (other.key !== start && granting(role, 'iam:PassRole', other.arn).length && reaches(roles, workloads, other.key, arn, seen)) return true;
  }
  for (const workload of Object.values(workloads)) {
    const definition = `arn:aws:ecs:${region}:${account}:task-definition/${workload.family}`;
    const startable = ['ecs:RunTask', 'ecs:StartTask'].some((action) => [definition, `${definition}:1`].some((resource) => granting(role, action, resource).length > 0));
    if (startable && (workload.parameterArns.includes(arn) || workload.roleKeys.some((key) => reaches(roles, workloads, key, arn, seen)))) return true;
  }
  return false;
}

/** All a role held by app code may do. Anything else (starting tasks, passing roles, schedules, scaling) is refused. */
const CONTAINER_ACTIONS = new Set([
  'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'ssm:GetParameter', 'ssm:GetParameters', 'kms:Decrypt',
  'ecr:GetAuthorizationToken', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability',
  's3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket',
]);

/** Every string in the configuration that mentions a role, with the address it sits in. */
function roleReferences(configuration: Generated): Array<{ address: string; role: string }> {
  const found: Array<{ address: string; role: string }> = [];
  for (const [type, entries] of Object.entries<any>(configuration.environment.files['tasks.tf.json'].resource)) {
    for (const [name, body] of Object.entries(entries)) {
      for (const match of JSON.stringify(body).matchAll(/aws_iam_role\.(\w+)\.arn/g)) found.push({ address: `${type}.${name}`, role: match[1]! });
    }
  }
  return found;
}

/**
 * The boundary, checked on the parsed policies of a generated configuration. `scopes` is what the spec declares;
 * `outside` names, per secret, the roles no container holds that may still lead to it (the scheduler's role, CI).
 */
function expectBoundary(configuration: Generated, scopes: Record<string, string[]>, outside: Record<string, string[]>) {
  const roles = rolesOf(configuration);
  const workloads = workloadsOf(configuration);
  const held = new Set(Object.values(workloads).flatMap((workload) => workload.roleKeys));
  for (const key of held) {
    const role = roles[key]!;
    // Only ECS can run a container as this role, and the role can do nothing but a container's own work.
    expect(role.trusted, key).toEqual(['ecs-tasks.amazonaws.com']);
    for (const statement of role.statements) {
      expect(statement.Effect, key).toBe('Allow');
      expect(statement.NotAction ?? statement.NotResource, key).toBeUndefined();
      for (const action of list(statement.Action)) expect(CONTAINER_ACTIONS.has(action), `${key} may ${action}`).toBe(true);
      // Decryption is usable only inside a Parameter Store read, which the role's parameter list limits.
      if (list(statement.Action).includes('kms:Decrypt')) expect(statement.Condition).toEqual({ StringEquals: { 'kms:ViaService': `ssm.${region}.amazonaws.com` } });
    }
    // Parameters are listed one by one, and they are exactly those wired into the workloads that run as the role.
    const listed = role.statements.filter((statement) => list(statement.Action).some((action) => action.startsWith('ssm:'))).flatMap((statement) => list(statement.Resource)).sort();
    const wired = [...new Set(Object.values(workloads).filter((workload) => workload.roleKeys.includes(key)).flatMap((workload) => workload.parameterArns))].sort();
    expect(listed, key).toEqual(wired);
  }
  for (const [secret, services] of Object.entries(scopes)) {
    const arn = parameter(secret);
    for (const workload of Object.values(workloads)) {
      const targeted = services.includes(workload.name);
      expect(workload.secretNames.includes(secret), `${workload.name} is wired to ${secret}`).toBe(targeted);
      expect(workload.roleKeys[0], workload.name).toBe(workload.roleKeys[1]);
      for (const key of workload.roleKeys) {
        expect(reads(roles[key]!, arn), `${workload.name} (${key}) reads ${secret}`).toBe(targeted);
        expect(reaches(roles, workloads, key, arn), `${workload.name} (${key}) reaches ${secret}`).toBe(targeted);
      }
    }
    // No other role reads it at all, and the only others that lead to it are ones no container can hold.
    const readers = Object.values(roles).filter((role) => reads(role, arn)).map((role) => role.key).sort();
    expect(readers, secret).toEqual(services.map((service) => workloads[service]!.roleKeys[0]!).sort());
    const leading = Object.keys(roles).filter((key) => !readers.includes(key) && reaches(roles, workloads, key, arn)).sort();
    expect(leading, secret).toEqual([...(outside[secret] ?? [])].sort());
    for (const key of leading) {
      expect(held.has(key), key).toBe(false);
      expect(roles[key]!.trusted, key).not.toContain('ecs-tasks.amazonaws.com');
    }
  }
  return { roles, workloads };
}

describe('an AWS environment whose secrets name no services', () => {
  it('generates exactly the configuration it did before secrets could name services', () => {
    expect(awsEngineProblems(parse(unscoped), 'preview')).toEqual([]);
    expect({ ci: generate(parse(unscoped)), privateWeb: generate(parse(unscoped, 'private-web')) }).toEqual(fixture);
  });

  it('is the arrangement the boundary check refuses: one role every container holds reads every secret and starts every task', () => {
    const configuration = generate(parse(unscoped));
    const roles = rolesOf(configuration);
    const workloads = workloadsOf(configuration);
    expect(Object.keys(roles).sort()).toEqual(['build', 'ci', 'runtime']);
    expect([...new Set(Object.values(workloads).flatMap((workload) => workload.roleKeys))]).toEqual(['runtime']);
    expect(reads(roles.runtime!, parameter('SOURCE_KEY'))).toBe(true);
    expect(granting(roles.runtime!, 'ecs:RunTask', `arn:aws:ecs:${region}:${account}:task-definition/${prefix}-catchup:1`)).toHaveLength(1);
    expect(granting(roles.runtime!, 'iam:PassRole', roles.runtime!.arn)).toHaveLength(1);
    expect(() => expectBoundary(configuration, { SOURCE_KEY: ['catchup'] }, {})).toThrow();
  });
});

describe('a secret limited to named services on AWS', () => {
  const scoped = { SOURCE_KEY: { ...delegated, services: ['catchup'] }, SIGNING_KEY: { ...generated, services: ['web', 'mailer'] }, PLAIN: delegated };
  const scopes = { SOURCE_KEY: ['catchup'], SIGNING_KEY: ['mailer', 'web'] };

  it('is accepted, and wires each secret only into the services it names', () => {
    const spec = parse(scoped);
    expect(awsEngineProblems(spec, 'preview')).toEqual([]);
    const workloads = workloadsOf(generate(spec));
    expect(Object.fromEntries(Object.values(workloads).map((workload) => [workload.name, workload.secretNames]))).toEqual({
      web: ['DATABASE_URL', 'PLAIN', 'SIGNING_KEY'], worker: ['DATABASE_URL', 'PLAIN'],
      mailer: ['DATABASE_URL', 'PLAIN', 'SIGNING_KEY'], catchup: ['DATABASE_URL', 'PLAIN', 'SOURCE_KEY'],
    });
  });

  it('gives each named service its own role and keeps every other role from reading or reaching the secret', () => {
    const configuration = generate(parse(scoped));
    // The scheduler's role starts the scheduled job that holds SOURCE_KEY; CI hands the named services' roles back to ECS on release.
    const { roles, workloads } = expectBoundary(configuration, scopes, { SOURCE_KEY: ['ci', 'control'], SIGNING_KEY: ['ci'] });
    expect(Object.keys(roles).sort()).toEqual(['build', 'ci', 'control', 'runtime', 'service_catchup', 'service_mailer', 'service_web']);
    expect(Object.fromEntries(Object.values(workloads).map((workload) => [workload.name, workload.roleKeys[0]]))).toEqual({
      web: 'service_web', worker: 'runtime', mailer: 'service_mailer', catchup: 'service_catchup' });
    expect(roles.service_catchup).toMatchObject({ name: `${prefix}-catchup-rt`, arn: `arn:aws:iam::${account}:role/hypervibe/app/${prefix}-catchup-rt` });
    // The shared role lost the limited secrets and everything but a container's own work.
    expect(roles.runtime!.statements.find((statement) => statement.Sid === 'Secrets')!.Resource).toEqual([parameter('PLAIN'), parameter('DATABASE_URL')]);
    expect(roles.runtime!.statements.map((statement) => statement.Sid)).toEqual(['Logs', 'Secrets', 'DecryptSecrets', 'PullImages', 'Storage']);
    // Every per-service role keeps the environment's buckets, logs and image pull.
    for (const key of ['service_catchup', 'service_mailer', 'service_web']) {
      expect(roles[key]!.statements.map((statement) => statement.Sid)).toEqual(['Logs', 'Secrets', 'DecryptSecrets', 'PullImages', 'Storage']);
      expect(roles[key]!.statements.find((statement) => statement.Sid === 'Storage')).toEqual(roles.runtime!.statements.find((statement) => statement.Sid === 'Storage'));
    }
    const base = configuration.environment.files['base.tf.json'].resource.aws_iam_role;
    for (const role of Object.values<any>(base)) expect(role).toMatchObject({ path: '/hypervibe/app/', permissions_boundary: `arn:aws:iam::${account}:policy/hypervibe/hypervibe-app-boundary` });
  });

  it('moves starting tasks, wakers and schedules to a role only AWS schedulers can assume', () => {
    const configuration = generate(parse(scoped));
    const roles = rolesOf(configuration);
    const control = roles.control!;
    expect(control.trusted).toEqual(['events.amazonaws.com', 'scheduler.amazonaws.com', 'states.amazonaws.com']);
    expect(READS.flatMap((action) => control.statements.filter((statement) => list(statement.Action).some((pattern) => matches(pattern, action))))).toEqual([]);
    const family = `arn:aws:ecs:${region}:${account}:task-definition/${prefix}-catchup`;
    const statement = (sid: string) => control.statements.find((entry) => entry.Sid === sid)!;
    // It starts only the scheduled job, and hands ECS only that job's role.
    expect(statement('RunTasks')).toMatchObject({ Action: 'ecs:RunTask', Resource: [family, `${family}:*`] });
    for (const other of ['web', 'worker', 'mailer']) expect(granting(control, 'ecs:RunTask', `arn:aws:ecs:${region}:${account}:task-definition/${prefix}-${other}:1`)).toEqual([]);
    expect(statement('PassTaskRoles')).toEqual({ Sid: 'PassTaskRoles', Effect: 'Allow', Action: 'iam:PassRole', Resource: [roles.service_catchup!.arn],
      Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } });
    expect(statement('PassSelf').Resource).toBe(control.arn);
    expect(statement('StartWakers').Resource).toEqual([`arn:aws:states:${region}:${account}:stateMachine:${prefix}-mailer-waker`]);
    expect(Object.values(roles).filter((role) => granting(role, 'iam:PassRole', roles.service_web!.arn).length).map((role) => role.key)).toEqual(['ci']);
    // Schedules, the waker and its event run as it; containers never do.
    const references = roleReferences(configuration);
    const startedBy = (type: string) => [...new Set(references.filter((reference) => reference.address.startsWith(`${type}.`)).map((reference) => reference.role))];
    for (const type of ['aws_scheduler_schedule', 'aws_sfn_state_machine', 'aws_cloudwatch_event_target']) expect(startedBy(type), type).toEqual(['control']);
    expect(startedBy('aws_ecs_task_definition').sort()).toEqual(['runtime', 'service_catchup', 'service_mailer']);
    expect(startedBy('aws_ecs_express_gateway_service')).toEqual(['service_web']);
    expect(configuration.environment.files['tasks.tf.json'].resource.aws_ecs_express_gateway_service.web.depends_on).toContain('aws_iam_role_policy.service_web');
  });

  it('lets a CI release hand ECS exactly the roles of the workloads it releases, and expects each workload on its own role', () => {
    const spec = parse(scoped);
    const configuration = generate(spec);
    const roles = rolesOf(configuration);
    const pass = roles.ci!.statements.find((statement) => statement.Sid === 'PassRuntimeRole')!;
    expect(pass.Resource).toEqual([roles.service_catchup!.arn, roles.service_mailer!.arn, roles.runtime!.arn, roles.service_web!.arn].sort());
    expect(pass.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } });
    expect(READS.filter((action) => roles.ci!.statements.some((statement) => list(statement.Action).some((pattern) => matches(pattern, action))))).toEqual([]);
    expect(READS.filter((action) => roles.build!.statements.some((statement) => list(statement.Action).some((pattern) => matches(pattern, action)) && list(statement.Resource).some((pattern) => matches(pattern, parameter('SOURCE_KEY')))))).toEqual([]);
    // The release check refuses a task definition whose roles are not the one the spec gives the workload.
    for (const workload of Object.values(workloadsOf(configuration))) {
      expect(awsWorkloadRoleArn(spec, 'preview', { accountId: account, prefix }, workload.name, workload.family), workload.name).toBe(roles[workload.roleKeys[0]!]!.arn);
    }
    expect(awsWorkloadRoleArn(parse(unscoped), 'preview', { accountId: account, prefix }, 'catchup', `${prefix}-catchup`)).toBe(fixtureRuntimeArn);
  });

  it('holds for a private web service and an environment with no schedules', () => {
    expectBoundary(generate(parse({ SOURCE_KEY: { ...delegated, services: ['internal'] }, PLAIN: delegated }, 'private-web')), { SOURCE_KEY: ['internal'] }, {});
    const plain = projectSpecSchema.parse({ version: 1, project: 'clone', environments: { preview: { hosting: { provider: 'aws', region },
      services: { web: {}, worker: { workloadKind: 'worker' } } } }, secrets: { SOURCE_KEY: { ...delegated, services: ['worker'] } } });
    const configuration = generate(plain);
    const { roles } = expectBoundary(configuration, { SOURCE_KEY: ['worker'] }, {});
    // Nothing is scheduled, so no role exists that could start a task.
    expect(Object.keys(roles).sort()).toEqual(['build', 'runtime', 'service_worker']);
  });

  it('creates no workload roles before the first image, and still keeps the shared role off the limited secret', () => {
    const input = buildAwsEngineInput(parse(scoped), 'preview', { ...context, environment: { id: 'env-123', platformBindings: {} } } as never, { secretKeys: ['SOURCE_KEY', 'PLAIN'] });
    const statements = JSON.parse((buildAwsConfiguration(input).files['base.tf.json'] as any).resource.aws_iam_role_policy.runtime.policy).Statement as Statement[];
    expect(statements.find((statement) => statement.Sid === 'Secrets')!.Resource).toEqual([parameter('PLAIN')]);
    expect(Object.keys((buildAwsConfiguration(input).files['base.tf.json'] as any).resource.aws_iam_role)).toEqual(['runtime']);
  });
});

const fixtureRuntimeArn = `arn:aws:iam::${account}:role/hypervibe/app/${prefix}-runtime`;

describe('the release command on AWS', () => {
  const scoped = { SOURCE_KEY: { ...delegated, services: ['worker'] } };

  it('is refused in planning, so no task ever borrows a service’s role or secrets to run it', () => {
    const migration = projectSpecSchema.parse(document(scoped, 'private-web', { migrations: { mode: 'releaseCommand', command: 'clone migrate' } }));
    expect(awsEngineProblems(migration, 'preview')).toContain('migrations.mode="releaseCommand" is not yet supported on AWS.');
    const perService = projectSpecSchema.parse(document(scoped, 'private-web'));
    (perService.environments.preview!.services.web as { releaseCommand?: string }).releaseCommand = 'clone migrate';
    expect(awsEngineProblems(perService, 'preview')).toContain('Service web: release commands are not yet supported by the OpenTofu engine.');
  });

  it('has no task definition in the generated configuration: only the declared services run', () => {
    const spec = parse(scoped);
    const configuration = generate(spec);
    expect(Object.keys(workloadsOf(configuration)).sort()).toEqual(Object.keys(spec.environments.preview!.services).sort());
    expect(JSON.stringify(configuration)).not.toMatch(/release[_-]command|migrate/i);
  });
});

describe('limiting a secret every service already holds, on a live AWS environment', () => {
  const addresses = (configuration: Generated['environment']) => {
    const found: Record<string, unknown> = {};
    for (const file of Object.values<any>(configuration.files)) {
      for (const [type, entries] of Object.entries<any>(file.resource ?? {})) for (const [name, body] of Object.entries(entries)) found[`${type}.${name}`] = body;
    }
    return found;
  };

  it('adds roles and updates workloads in place, and changes no data-bearing resource', () => {
    const before = generate(parse(unscoped));
    const after = generate(parse({ ...unscoped, SOURCE_KEY: { ...delegated, services: ['catchup'] } }));
    expect(before).toEqual(fixture.ci);
    const was = addresses(before.environment);
    const now = addresses(after.environment);
    expect(Object.keys(was).filter((address) => !(address in now))).toEqual([]);
    expect(Object.keys(now).filter((address) => !(address in was)).sort()).toEqual([
      'aws_iam_role.control', 'aws_iam_role.service_catchup',
      // Each role's inline policy and managed attachments become exclusive, so nothing added outside Hypervibe can widen them.
      'aws_iam_role_policies_exclusive.control', 'aws_iam_role_policies_exclusive.runtime', 'aws_iam_role_policies_exclusive.service_catchup',
      'aws_iam_role_policy.control', 'aws_iam_role_policy.service_catchup',
      'aws_iam_role_policy_attachments_exclusive.control', 'aws_iam_role_policy_attachments_exclusive.runtime', 'aws_iam_role_policy_attachments_exclusive.service_catchup']);
    const base = (after.environment.files['base.tf.json'] as { resource: Record<string, Record<string, { policy_arns?: string[]; policy_names?: string[] }>> }).resource;
    for (const key of ['control', 'runtime', 'service_catchup']) {
      expect(base.aws_iam_role_policy_attachments_exclusive![key]!.policy_arns).toEqual([]);
      expect(base.aws_iam_role_policies_exclusive![key]!.policy_names).toEqual([`\${aws_iam_role_policy.${key}.name}`]);
    }
    const changed = Object.keys(was).filter((address) => JSON.stringify(was[address]) !== JSON.stringify(now[address])).sort();
    expect(changed).toEqual([
      'aws_cloudwatch_event_target.mailer_waker',
      'aws_ecs_express_gateway_service.web',
      'aws_ecs_task_definition.catchup', 'aws_ecs_task_definition.mailer', 'aws_ecs_task_definition.worker',
      'aws_iam_role.runtime', 'aws_iam_role_policy.ci', 'aws_iam_role_policy.runtime',
      'aws_scheduler_schedule.catchup', 'aws_scheduler_schedule.mailer_waker', 'aws_scheduler_schedule.mailer_waker_next',
      'aws_sfn_state_machine.mailer_waker',
    ]);
    // Nothing that holds data changes: buckets, the database login secrets, the waker's login.
    for (const [address, mapping] of Object.entries<any>(after.environment.resources)) {
      if (mapping.dataBearing || ['storage', 'database', 'secret'].includes(mapping.kind) || /^aws_(s3_bucket|secretsmanager_secret|rds_|db_|ssm_parameter)/.test(address)) expect(changed, address).not.toContain(address);
    }
    expect(Object.keys(now).filter((address) => /^aws_(s3_bucket|secretsmanager_secret)/.test(address)).sort()).toEqual([
      'aws_s3_bucket.uploads', 'aws_s3_bucket_lifecycle_configuration.uploads', 'aws_s3_bucket_ownership_controls.uploads',
      'aws_s3_bucket_public_access_block.uploads', 'aws_s3_bucket_versioning.uploads',
      'aws_secretsmanager_secret.database_query', 'aws_secretsmanager_secret.mailer_waker']);
    // A changed resource keeps the names AWS identifies it by, so nothing but a task definition is replaced
    // (a task definition is immutable: any change registers a new revision of the same family).
    for (const address of changed) {
      for (const field of ['name', 'family', 'service_name', 'path', 'cluster', 'permissions_boundary']) {
        expect((now[address] as Record<string, unknown>)[field], `${address}.${field}`).toEqual((was[address] as Record<string, unknown>)[field]);
      }
    }
    // The image build (registry, source bucket, CodeBuild) is untouched, and so is every mapping that existed.
    expect(after.build).toEqual(before.build);
    for (const [address, mapping] of Object.entries(before.environment.resources)) expect(after.environment.resources[address], address).toEqual(mapping);
    // What changed in the shared role: it is now only for containers, and reads only the secrets no declaration limits.
    const roles = rolesOf(after);
    expect(roles.runtime!.trusted).toEqual(['ecs-tasks.amazonaws.com']);
    expect(reads(roles.runtime!, parameter('SOURCE_KEY'))).toBe(false);
    expect(reads(roles.runtime!, parameter('SIGNING_KEY'))).toBe(true);
    expectBoundary(after, { SOURCE_KEY: ['catchup'] }, { SOURCE_KEY: ['ci', 'control'] });
  });

  it('returns to the single shared role when the limit is removed again', () => {
    expect(generate(parse(unscoped))).toEqual(fixture.ci);
  });
});

describe('what AWS cannot keep apart is refused', () => {
  it('refuses to limit a package token, which the image build reads rather than a service', () => {
    const spec = parse(unscoped);
    const tokens = { ...spec, secrets: { ...spec.secrets, NPM_TOKEN: { ...spec.secrets.PLAIN!, services: ['web'] } } } as ProjectSpec;
    expect(awsEngineProblems(tokens, 'preview')).toEqual([
      'Secret NPM_TOKEN is a package token read by the image build, not by a running service, so it cannot be limited to named services. Remove "services" from it.']);
  });

  it('refuses to generate a configuration in which two services would share a role or task definition', () => {
    const task = (logicalName: string, resourceName: string) => ({ logicalName, resourceName, initialImageUri: image });
    const input: AwsEngineInput = { accountId: account, region, prefix, environmentId: 'env-123', parameterPath: '/hypervibe/env-123/', secretKeys: ['SOURCE_KEY'],
      workers: [task('my-svc', `${prefix}-my-svc`), task('my_svc', `${prefix}-my_svc`)] };
    expect(() => buildAwsConfiguration({ ...input, secretScopes: { SOURCE_KEY: ['my-svc'] } })).toThrow('Services my-svc and my_svc would both be named "my_svc" on AWS');
    expect(() => buildAwsConfiguration({ ...input, workers: [task('one', `${prefix}-same`), task('two', `${prefix}-same`)], secretScopes: { SOURCE_KEY: ['one'] } }))
      .toThrow(`Services one and two would both be named "${prefix}-same" on AWS`);
    // Without a limited secret nothing changes for such a spec.
    expect(() => buildAwsConfiguration(input)).not.toThrow();
  });
});

import { z } from 'zod';

/**
 * The canonical desired-state document ("spec") for a project — the single
 * source of truth that hv_plan diffs against observed infrastructure and
 * hv_apply converges toward.
 *
 * One spec per project, with a section per environment. Apply runs against
 * one environment at a time.
 */

export const serviceSpecSchema = z.object({
  workloadKind: z.enum(['web', 'worker', 'cron'], {
    errorMap: () => ({ message: "workloadKind 'job' was removed; use 'worker' (always-on) or 'cron' (scheduled, requires cronSchedule). See README migration notes." }),
  }).default('web'),
  startCommand: z.string().min(1).optional(),
  releaseCommand: z.string().min(1).optional(),
  healthCheckPath: z.string().min(1).optional(),
  cronSchedule: z.string().min(1).optional(),
  timeZone: z.string().min(1).optional(),
  public: z.boolean().optional(),
}).superRefine((service, ctx) => {
  if (service.workloadKind === 'cron' && !service.cronSchedule) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cron services require cronSchedule',
      path: ['cronSchedule'],
    });
  }
});

export const databaseSpecSchema = z.object({
  provider: z.enum(['supabase', 'cloudsql', 'railway']),
  engine: z.literal('postgres').default('postgres'),
  /**
   * Optional one-shot bootstrap/seed command. hv_plan emits a visible database
   * seed action. hv_apply runs it inside the deployed service environment and
   * records the successful command hash in the database component bindings so
   * it does not run again unless changed.
   */
  seedCommand: z.string().min(1).optional(),
});

export const deploySpecSchema = z.object({
  strategy: z.enum(['branch', 'manual']).default('manual'),
  trigger: z.enum(['ci', 'native']).optional(),
  /** Git branch used as the source ref. Defaults to main for staging and production. */
  branch: z.string().min(1).optional(),
  /** CI branch deploys default to true for staging and false for production. */
  autoDeploy: z.boolean().optional(),
  /** Production promotion source label, usually staging. Used for workflow guidance. */
  promoteFrom: z.string().min(1).optional(),
});

export const collaborationLabelSpecSchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/, 'label color must be a 6-character hex value without #').optional(),
  description: z.string().max(100).optional(),
}).strict();

export const collaborationSpecSchema = z.object({
  provider: z.literal('github').default('github'),
  enabled: z.boolean().default(true),
  /** GitHub repository owner/name. Defaults to the project gitRemoteUrl. */
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repository must be owner/name').optional(),
  /** Environment whose hv_plan should include project-level repo collaboration actions. */
  canonicalEnvironment: z.string().min(1).optional(),
  issues: z.object({
    enabled: z.boolean().default(true),
    labels: z.array(collaborationLabelSpecSchema).default([]),
    templates: z.boolean().default(true),
  }).default({}),
  pullRequests: z.object({
    targetBranch: z.string().min(1).default('main'),
    requirePr: z.boolean().default(true),
    requireReview: z.boolean().default(true),
    requiredReviewers: z.number().int().min(1).max(6).default(1),
    dismissStaleReviews: z.boolean().default(false),
    requireCodeOwnerReviews: z.boolean().default(false),
    requireStatusChecks: z.boolean().default(false),
    statusChecks: z.array(z.string().min(1)).default([]),
    strictStatusChecks: z.boolean().default(true),
    enforceAdmins: z.boolean().default(false),
  }).default({}),
  collaborators: z.array(z.object({
    username: z.string().min(1),
    permission: z.enum(['pull', 'triage', 'push', 'maintain', 'admin']).default('push'),
  }).strict()).default([]),
}).default({});

export const envFileSpecSchema = z.object({
  /**
   * runtime: include high-confidence app runtime keys from .env (default).
   * all: include every non-provider key from .env.
   * explicit: include only keys listed in include.
   * off: never load .env for deploy planning/apply.
   */
  mode: z.enum(['runtime', 'all', 'explicit', 'off']).default('runtime'),
  /** Exact .env keys to include in addition to the mode's defaults. */
  include: z.array(z.string().min(1)).default([]),
  /** Exact .env keys to omit even if the mode or include list would select them. */
  exclude: z.array(z.string().min(1)).default([]),
}).default({});

export const delegatedSecretSpecSchema = z.object({
  /** Delegated values are supplied explicitly at plan time and never stored in the spec. */
  ownership: z.literal('delegated').default('delegated'),
  /** Non-secret identity that documents who is responsible for supplying and rotating the value. */
  principal: z.string().min(1),
  /** Environments in which this secret must be injected. */
  environments: z.array(z.string().min(1)).min(1),
  /** Missing or unaccepted values block convergence until the principal supplies a secretRef. */
  required: z.boolean().default(true),
  /** Never replace an accepted live value from a local env file or ordinary envVars input. */
  driftPolicy: z.literal('preserve').default('preserve'),
}).strict();

export const migrationsSpecSchema = z.object({
  mode: z.enum(['none', 'releaseCommand', 'tool']),
  runInDeploy: z.boolean().optional(),
  command: z.string().min(1).optional(),
});

export const domainRegistrationSpecSchema = z.object({
  provider: z.literal('cloudflare').default('cloudflare'),
  register: z.boolean().default(true),
  accountId: z.string().min(1).optional(),
  years: z.number().int().min(1).max(10).optional(),
  autoRenew: z.boolean().optional(),
  privacyMode: z.enum(['redaction', 'off']).optional(),
});

export const iosTestflightGroupSpecSchema = z.object({
  internal: z.boolean().default(false),
  publicLinkEnabled: z.boolean().optional(),
  publicLinkLimit: z.number().int().min(1).max(10000).optional(),
  feedbackEnabled: z.boolean().optional(),
  hasAccessToAllBuilds: z.boolean().optional(),
  testers: z.array(z.string().email()).default([]),
});

/**
 * iOS identity + TestFlight desired state. Capabilities and tester
 * membership converge additively (never disabled/removed); extras on the
 * live side are reported as unmanaged. Build upload, review submission,
 * and App Store metadata stay imperative (hv_testflight_*, hv_appstore_*).
 */
export const iosSpecSchema = z.object({
  bundleId: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/, 'bundleId must be a reverse-DNS identifier'),
  /** Name used when registering the bundle ID; defaults to the project name at plan time. */
  appName: z.string().min(1).optional(),
  platform: z.enum(['IOS', 'MAC_OS']).default('IOS'),
  /** ASC capability types, e.g. PUSH_NOTIFICATIONS, ICLOUD, SIGN_IN_WITH_APPLE. */
  capabilities: z.array(z.string().min(1)).default([]),
  testflight: z.object({
    groups: z.record(z.string().min(1), iosTestflightGroupSpecSchema).default({}),
  }).optional(),
}).superRefine((ios, ctx) => {
  for (const [name, group] of Object.entries(ios.testflight?.groups ?? {})) {
    if (group.publicLinkLimit !== undefined && !group.publicLinkEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'publicLinkLimit requires publicLinkEnabled',
        path: ['testflight', 'groups', name, 'publicLinkLimit'],
      });
    }
    if (group.internal && group.publicLinkEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'internal groups cannot have a public link',
        path: ['testflight', 'groups', name, 'publicLinkEnabled'],
      });
    }
  }
});

/**
 * A named message queue. Backend follows the hosting provider: Cloud Run
 * environments get real Pub/Sub topics + subscriptions; Railway environments
 * are postgres-backed (pg-boss model — queues ride the declared database,
 * hypervibe wires env vars and apps own the tables).
 */
export const queueSpecSchema = z.object({
  /** Subscriber ack deadline in seconds (Pub/Sub only; ignored on the postgres backend). */
  ackDeadlineSeconds: z.number().int().min(10).max(600).optional(),
}).strict();

/**
 * Named, durable object storage. The name is both the provider display name
 * used by Railway variable references. Each selected service receives the
 * conventional AWS S3 variable names, so one bucket may target each service.
 */
export const storageSpecSchema = z.object({
  provider: z.literal('railway'),
  type: z.literal('bucket'),
  /** Railway bucket regions are immutable after the bucket instance is created. */
  region: z.enum(['sjc', 'iad', 'ams', 'sin']),
  /** Services that receive this bucket's generated runtime variables. */
  injectInto: z.array(z.string().min(1)).min(1),
}).strict();

export const environmentSpecSchema = z.object({
  hosting: z.object({
    /** Hosting provider name; validated against the adapter registry at spec_set time. */
    provider: z.string().min(1),
    region: z.string().min(1).optional(),
  }),
  services: z.record(z.string().min(1), serviceSpecSchema).default({}),
  database: databaseSpecSchema.optional(),
  domain: z.string().min(1).optional(),
  domainRegistration: domainRegistrationSpecSchema.optional(),
  email: z.object({ enabled: z.boolean() }).default({ enabled: false }),
  envVars: z.record(z.string()).default({}),
  envFile: envFileSpecSchema.optional(),
  deploy: deploySpecSchema.optional(),
  migrations: migrationsSpecSchema.optional(),
  ios: iosSpecSchema.optional(),
  queues: z.record(
    z.string().regex(/^[a-z][a-z0-9-]{0,60}$/, 'queue names: lowercase alphanumeric and dashes, starting with a letter'),
    queueSpecSchema
  ).optional(),
  storage: z.record(
    z.string().regex(/^[a-z][a-z0-9-]{0,60}$/, 'storage names: lowercase alphanumeric and dashes, starting with a letter'),
    storageSpecSchema
  ).optional(),
  /** Autofix agent log watches, synced on hv_apply. */
  autofix: z.object({
    enabled: z.boolean(),
    /** Services to watch (default: all services in this environment). */
    services: z.array(z.string().min(1)).optional(),
  }).optional(),
}).superRefine((environment, ctx) => {
  if (environment.domainRegistration && !environment.domain) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'domainRegistration requires domain',
      path: ['domainRegistration'],
    });
  }
  if (environment.queues && Object.keys(environment.queues).length > 0
    && environment.hosting.provider === 'railway' && !environment.database) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'railway queues are postgres-backed (pg-boss model): declare spec.database',
      path: ['queues'],
    });
  }
  const storageByService = new Map<string, string>();
  for (const [storageName, storage] of Object.entries(environment.storage ?? {})) {
    for (const serviceName of storage.injectInto) {
      if (!environment.services[serviceName]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `storage target service "${serviceName}" is not declared in this environment`,
          path: ['storage', storageName, 'injectInto'],
        });
      }
      const existing = storageByService.get(serviceName);
      if (existing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `service "${serviceName}" cannot receive both "${existing}" and "${storageName}" because bucket wiring uses the standard AWS_* variable names`,
          path: ['storage', storageName, 'injectInto'],
        });
      } else {
        storageByService.set(serviceName, storageName);
      }
    }
  }
});

export const projectSpecSchema = z.object({
  version: z.literal(1),
  project: z.string().min(1),
  gitRemoteUrl: z.string().min(1).optional(),
  collaboration: collaborationSpecSchema.optional(),
  secrets: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'secret names must be valid environment variable names'),
    delegatedSecretSpecSchema
  ).default({}),
  environments: z.record(z.string().min(1), environmentSpecSchema),
}).superRefine((spec, ctx) => {
  for (const [key, secret] of Object.entries(spec.secrets)) {
    const seen = new Set<string>();
    for (const environmentName of secret.environments) {
      if (seen.has(environmentName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" lists environment "${environmentName}" more than once`,
          path: ['secrets', key, 'environments'],
        });
        continue;
      }
      seen.add(environmentName);

      const environment = spec.environments[environmentName];
      if (!environment) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" targets unknown environment "${environmentName}"`,
          path: ['secrets', key, 'environments'],
        });
        continue;
      }
      if (Object.keys(environment.services).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" requires at least one service in environment "${environmentName}"`,
          path: ['secrets', key, 'environments'],
        });
      }
      if (key in environment.envVars) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot also be declared in environments.${environmentName}.envVars`,
          path: ['environments', environmentName, 'envVars', key],
        });
      }
      if (environment.envFile?.include.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot be selected through environments.${environmentName}.envFile.include`,
          path: ['environments', environmentName, 'envFile', 'include'],
        });
      }
    }
  }
});

export type ServiceSpec = z.infer<typeof serviceSpecSchema>;
export type DatabaseSpec = z.infer<typeof databaseSpecSchema>;
export type IosSpec = z.infer<typeof iosSpecSchema>;
export type QueueSpec = z.infer<typeof queueSpecSchema>;
export type StorageSpec = z.infer<typeof storageSpecSchema>;
export type IosTestflightGroupSpec = z.infer<typeof iosTestflightGroupSpecSchema>;
export type DomainRegistrationSpec = z.infer<typeof domainRegistrationSpecSchema>;
export type EnvFileSpec = z.infer<typeof envFileSpecSchema>;
export type DelegatedSecretSpec = z.infer<typeof delegatedSecretSpecSchema>;
export type CollaborationSpec = z.infer<typeof collaborationSpecSchema>;
export type EnvironmentSpec = z.infer<typeof environmentSpecSchema>;
export type ProjectSpec = z.infer<typeof projectSpecSchema>;

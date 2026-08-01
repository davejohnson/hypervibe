import { z } from 'zod';

/**
 * The canonical desired-state document ("spec") for a project — the single
 * source of truth that hv_plan diffs against observed infrastructure and
 * hv_apply converges toward.
 *
 * One spec per project, with a section per environment. Apply runs against
 * one environment at a time.
 */

const environmentVariableNameSchema = z.string().regex(
  /^[A-Za-z_][A-Za-z0-9_]*$/,
  'environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores'
);

const DATABASE_ENV_ALIAS_SOURCES = [
  'DATABASE_URL',
  'DIRECT_URL',
] as const;

export const databaseEnvAliasSourceSchema = z.enum(DATABASE_ENV_ALIAS_SOURCES);

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
  /**
   * Per-service compatibility aliases for Hypervibe-managed database URLs.
   * Only names and canonical sources are persisted; resolved values remain
   * inside the encrypted plan/provider boundary.
   */
  databaseEnvAliases: z.record(
    environmentVariableNameSchema,
    databaseEnvAliasSourceSchema
  ).optional(),
}).superRefine((service, ctx) => {
  if (service.workloadKind === 'cron' && !service.cronSchedule) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cron services require cronSchedule',
      path: ['cronSchedule'],
    });
  }
});

export const providerIdSchema = z.string().regex(
  /^[a-z][a-z0-9-]*$/,
  'provider ids must be lowercase slugs starting with a letter'
);

export const databaseSpecSchema = z.object({
  provider: providerIdSchema,
  engine: z.literal('postgres').default('postgres'),
  /**
   * Optional one-shot bootstrap/seed command. hv_plan emits a visible database
   * seed action. hv_apply runs it inside the deployed service environment and
   * records the successful command hash in the database component bindings so
   * it does not run again unless changed.
   */
  seedCommand: z.string().min(1).optional(),
});

export const cacheSpecSchema = z.object({
  provider: providerIdSchema,
  engine: z.literal('redis').default('redis'),
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
  }).strict().default({}),
  collaborators: z.array(z.object({
    username: z.string().min(1),
    permission: z.enum(['pull', 'triage', 'push', 'maintain', 'admin']).default('push'),
  }).strict()).default([]),
}).default({});

const automationIdSchema = z.string().regex(
  /^[a-z][a-z0-9-]{0,62}$/,
  'automation ids must be lowercase slugs starting with a letter'
);

const fiveFieldCronSchema = z.string().superRefine((value, ctx) => {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'schedule.cron must use five-field POSIX cron: minute hour day-of-month month day-of-week',
    });
    return;
  }
  const allowed = /^[0-9A-Za-z*?,\/-]+$/;
  if (fields.some((field) => !allowed.test(field)) || fields.some((field) => /[?]/.test(field))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'schedule.cron contains syntax GitHub Actions does not support; use POSIX numbers/names with *, comma, dash, and slash',
    });
  }
  if (/^@(yearly|monthly|weekly|daily|hourly|reboot)$/i.test(value.trim())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'GitHub Actions does not support cron aliases such as @daily; use five fields',
    });
  }
});

const ianaTimezoneSchema = z.string().min(1).superRefine((value, ctx) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'schedule.timezone must be a valid IANA timezone such as UTC or America/Vancouver',
    });
  }
});

export const githubScheduleSpecSchema = z.object({
  /** GitHub Actions uses five-field POSIX cron. */
  cron: fiveFieldCronSchema,
  /** IANA timezone used by the workflow's schedule guard. Defaults to UTC. */
  timezone: ianaTimezoneSchema.default('UTC'),
}).strict();

const githubAutomationTriggersSchema = z.object({
  pullRequest: z.boolean().default(false),
  push: z.array(z.string().min(1)).default([]),
  schedule: githubScheduleSpecSchema.optional(),
  manual: z.boolean().default(true),
}).strict().default({});

const githubAutomationRuntimeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('node'),
    version: z.string().min(1).default('22'),
    installCommand: z.string().min(1).default('npm ci'),
  }).strict(),
  z.object({
    kind: z.literal('python'),
    version: z.string().min(1).default('3.13'),
    installCommand: z.string().min(1).default('python -m pip install -r requirements.txt'),
  }).strict(),
]);

const githubFailureArtifactPathSchema = z.string().min(1).superRefine((value, ctx) => {
  const unsafe = value.trim() !== value
    || /[\r\n\0]/.test(value)
    || value.startsWith('/')
    || value.split('/').includes('..')
    || /(^|\/)\.git(?:\/|$)/i.test(value)
    || /(^|\/)\.env(?:\.|\/|$)/i.test(value)
    || /(^|\/)(?:secret|secrets|credentials)(?:\.|\/|$)/i.test(value)
    || ['.', '*', '**', '**/*'].includes(value);
  if (unsafe) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'failure artifact paths must be narrow relative result paths and cannot target credentials, .env, .git, or the whole workspace',
    });
  }
});

const githubFailureArtifactPatternSchema = z.string().min(1).superRefine((value, ctx) => {
  const literalPrefix = value.endsWith('*') ? value.slice(0, -1) : value;
  const unsafe = value.trim() !== value
    || /[\r\n\0/\\]/.test(value)
    || value.includes('${{')
    || literalPrefix.length < 3
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\*)?$/.test(value);
  if (unsafe) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'failure artifact patterns must be a narrow artifact name or identifier-shaped prefix ending in *',
    });
  }
});

const githubAiAgentSchema = z.object({
  provider: z.literal('openai').default('openai'),
  model: z.literal('gpt-5.6-sol').default('gpt-5.6-sol'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).default('high'),
}).strict().default({});

export const githubCheckAutomationSpecSchema = z.object({
  kind: z.literal('check'),
  enabled: z.boolean().default(true),
  category: z.enum([
    'test',
    'lint',
    'typecheck',
    'build',
    'dependency-audit',
    'performance',
    'accessibility',
  ]),
  triggers: githubAutomationTriggersSchema,
  runtime: githubAutomationRuntimeSchema,
  commands: z.array(z.string().min(1)).min(1),
  failureArtifacts: z.array(githubFailureArtifactPathSchema).default([]),
}).strict();

export const githubAutofixAutomationSpecSchema = z.object({
  kind: z.literal('autofix'),
  enabled: z.boolean().default(true),
  /** Check automation ids whose completed failed runs may produce a patch. */
  sources: z.array(automationIdSchema).min(1),
  agent: githubAiAgentSchema,
  draftPullRequest: z.literal(true).default(true),
}).strict();

export const githubPullRequestReviewAutomationSpecSchema = z.object({
  kind: z.literal('pull-request-review'),
  enabled: z.boolean().default(true),
  agent: githubAiAgentSchema,
}).strict();

export const githubCodeAuditAutomationSpecSchema = z.object({
  kind: z.literal('code-audit'),
  enabled: z.boolean().default(true),
  schedule: githubScheduleSpecSchema,
  agent: githubAiAgentSchema,
  /** Stable issue-per-finding lifecycle; line numbers are deliberately excluded from fingerprints. */
  findings: z.object({
    createIssues: z.literal(true).default(true),
    closeAfterCleanRuns: z.literal(1).default(1),
  }).strict().default({}),
}).strict();

export const githubAutomationSpecSchema = z.discriminatedUnion('kind', [
  githubCheckAutomationSpecSchema,
  githubAutofixAutomationSpecSchema,
  githubPullRequestReviewAutomationSpecSchema,
  githubCodeAuditAutomationSpecSchema,
]);

const githubCollaborationSpecSchema = z.object({
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
  }).strict().default({}),
  collaborators: z.array(z.object({
    username: z.string().min(1),
    permission: z.enum(['pull', 'triage', 'push', 'maintain', 'admin']).default('push'),
  }).strict()).default([]),
}).strict().default({});

export const githubSpecSchema = z.object({
  enabled: z.boolean().default(true),
  /** GitHub repository owner/name. Defaults to the project gitRemoteUrl. */
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repository must be owner/name').optional(),
  /** Environment whose hv_plan owns project-level GitHub infrastructure. */
  canonicalEnvironment: z.string().min(1).optional(),
  collaboration: githubCollaborationSpecSchema,
  actions: z.record(automationIdSchema, githubAutomationSpecSchema).default({}),
  /** Existing workflow names that autofix may consume but Hypervibe does not own. */
  externalWorkflows: z.record(automationIdSchema, z.object({
    workflowName: z.string().min(1),
    /** Exact artifact name or narrow trailing-wildcard pattern. Optional only for legacy spec readability. */
    failureArtifactPattern: githubFailureArtifactPatternSchema.optional(),
    failureArtifacts: z.array(githubFailureArtifactPathSchema).default([]),
  }).strict()).default({}),
  dependencies: z.object({
    alerts: z.boolean().default(false),
    securityUpdates: z.boolean().default(false),
    versionUpdates: z.array(z.object({
      ecosystem: z.string().min(1),
      directory: z.string().startsWith('/').default('/'),
      interval: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
      targetBranch: z.string().min(1).optional(),
    }).strict()).default([]),
  }).strict().default({}),
  security: z.object({
    codeScanning: z.boolean().default(false),
    secretScanning: z.boolean().default(false),
    pushProtection: z.boolean().default(false),
  }).strict().default({}),
}).strict().superRefine((github, ctx) => {
  for (const [id, automation] of Object.entries(github.actions)) {
    if (automation.kind === 'check') {
      const triggers = automation.triggers;
      if (!triggers.manual && !triggers.pullRequest && triggers.push.length === 0 && !triggers.schedule) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'check automation requires at least one trigger',
          path: ['actions', id, 'triggers'],
        });
      }
    }
    if (automation.kind !== 'autofix') continue;
    const seen = new Set<string>();
    for (const source of automation.sources) {
      if (seen.has(source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `autofix source "${source}" is listed more than once`,
          path: ['actions', id, 'sources'],
        });
      }
      seen.add(source);
      const managed = github.actions[source];
      const external = github.externalWorkflows[source];
      if (!managed && !external) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `autofix source "${source}" is not a managed check or external workflow`,
          path: ['actions', id, 'sources'],
        });
      } else if (managed && managed.kind !== 'check') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `autofix source "${source}" must reference a check automation`,
          path: ['actions', id, 'sources'],
        });
      } else if (automation.enabled && managed?.kind === 'check' && !managed.enabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `enabled autofix source "${source}" references a disabled check`,
          path: ['actions', id, 'sources'],
        });
      } else if (automation.enabled && external && external.failureArtifacts.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `external workflow "${source}" must declare at least one failure artifact before autofix can consume it`,
          path: ['externalWorkflows', source, 'failureArtifacts'],
        });
      }
    }
  }
  if (github.security.pushProtection && !github.security.secretScanning) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'pushProtection requires secretScanning',
      path: ['security', 'pushProtection'],
    });
  }
});

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

const runtimeEnvVarNameSchema = z.string().regex(
  /^[A-Za-z_][A-Za-z0-9_]*$/,
  'runtime environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores'
);

const repositoryRelativePathSchema = z.string().min(1).refine(
  (value) => (
    !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.split(/[\\/]/).includes('..')
  ),
  'must be a repository-relative path without parent-directory traversal'
);

export const iosReleaseSigningSpecSchema = z.discriminatedUnion('provider', [
  z.object({
    /** The project build command owns signing and explicitly names any secrets it needs. */
    provider: z.literal('project'),
  }).strict(),
  z.object({
    /** Hypervibe installs existing Match assets read-only before invoking the project build. */
    provider: z.literal('match'),
    gitBranch: z.string().min(1).regex(
      /^[A-Za-z0-9._/-]+$/,
      'gitBranch contains unsupported characters'
    ).default('main'),
  }).strict(),
]);

const appStoreReleaseSecretNames = [
  'APP_STORE_CONNECT_KEY_ID',
  'APP_STORE_CONNECT_ISSUER_ID',
  'APP_STORE_CONNECT_PRIVATE_KEY',
];

const matchSigningSecretNames = [
  'MATCH_GIT_URL',
  'MATCH_PASSWORD',
  'MATCH_GIT_BASIC_AUTHORIZATION',
];

export const iosReleaseSpecSchema = z.object({
  /** Server services whose successful deployment evidence gates this mobile release. */
  services: z.array(z.string().min(1)).min(1),
  trigger: z.enum(['manual', 'after-server-deploy']).default('after-server-deploy'),
  build: z.object({
    workingDirectory: repositoryRelativePathSchema.default('.'),
    command: z.string().min(1).refine(
      (value) => !value.includes('${{'),
      'build command cannot contain GitHub expression interpolation'
    ),
    ipaPath: repositoryRelativePathSchema.refine(
      (value) => value.toLowerCase().endsWith('.ipa'),
      'ipaPath must end in .ipa'
    ),
    /** Existing GitHub environment secret names needed only by the project build command. */
    requiredSecrets: z.array(runtimeEnvVarNameSchema).default([]),
  }).strict(),
  signing: iosReleaseSigningSpecSchema.default({ provider: 'project' }),
  testflight: z.object({
    /** Names declared under ios.testflight.groups. */
    groups: z.array(z.string().min(1)).min(1),
    usesNonExemptEncryption: z.boolean().default(false),
    submitForBetaReview: z.boolean().default(false),
    /** Accepted only while existing specs migrate to Hypervibe's managed release runtime. */
    scriptPath: repositoryRelativePathSchema.refine(
      (value) => value === 'scripts/hypervibe-ios-release.mjs',
      'TestFlight submission is managed by Hypervibe; custom scriptPath values are not supported'
    ).optional(),
  }).strict(),
}).strict();

/**
 * iOS identity + TestFlight desired state. Capabilities and tester
 * membership converge additively (never disabled/removed); extras on the
 * live side are reported as unmanaged. Release builds/uploads/distribution
 * run in isolated build/release jobs tied to server deploy evidence.
 * Hypervibe owns signing preparation and TestFlight submission when their
 * managed providers are selected; projects retain build commands and metadata.
 * Final App Store review remains an explicit, release-gated Hypervibe command.
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
  release: iosReleaseSpecSchema.optional(),
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
  for (const [index, groupName] of (ios.release?.testflight.groups ?? []).entries()) {
    if (!ios.testflight?.groups[groupName]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `release TestFlight group "${groupName}" is not declared under ios.testflight.groups`,
        path: ['release', 'testflight', 'groups', index],
      });
    }
  }

  const buildSecretNames = new Set(ios.release?.build.requiredSecrets ?? []);
  const reservedSecretNames = [
    ...appStoreReleaseSecretNames,
    ...(ios.release?.signing.provider === 'match' ? matchSigningSecretNames : []),
  ];
  for (const name of reservedSecretNames) {
    if (!buildSecretNames.has(name)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${name} is reserved for the Hypervibe-managed release boundary`,
      path: ['release', 'build', 'requiredSecrets'],
    });
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
  injectInto: z.array(z.string().min(1)),
}).strict();

export const stripePriceEnvBindingSpecSchema = z.object({
  /**
   * Stripe product id (prod_...) or product name. Name matching is exact
   * unless match="contains" is explicitly selected for legacy catalogs.
   */
  product: z.string().min(1),
  match: z.enum(['exact', 'contains']).default('exact'),
  interval: z.enum(['day', 'week', 'month', 'year']),
  currency: z.string().regex(/^[A-Za-z]{3}$/, 'currency must be a three-letter code').transform((value) => value.toLowerCase()).optional(),
  nickname: z.string().min(1).optional(),
  lookupKey: z.string().min(1).optional(),
}).strict();

const stripeCatalogIdSchema = z.string().regex(
  /^[a-z][a-z0-9-]{0,62}$/,
  'Stripe catalog ids must be lowercase slugs starting with a letter'
);

export const stripeCatalogPriceSpecSchema = z.object({
  /** Integer amount in the currency's minor unit (for example cents). */
  unitAmount: z.number().int().nonnegative(),
  currency: z.string()
    .regex(/^[A-Za-z]{3}$/, 'currency must be a three-letter code')
    .transform((value) => value.toLowerCase())
    .default('usd'),
  interval: z.enum(['month', 'year']),
  /** Hosting variable receiving this environment's provider price id. */
  envVar: runtimeEnvVarNameSchema,
}).strict();

export const stripeCatalogProductSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  prices: z.record(stripeCatalogIdSchema, stripeCatalogPriceSpecSchema),
}).strict().superRefine((product, ctx) => {
  if (Object.keys(product.prices).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stripe catalog products require at least one recurring price',
      path: ['prices'],
    });
  }
});

export const stripeCatalogSpecSchema = z.object({
  products: z.record(stripeCatalogIdSchema, stripeCatalogProductSpecSchema),
}).strict().superRefine((catalog, ctx) => {
  if (Object.keys(catalog.products).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stripe catalog requires at least one product',
      path: ['products'],
    });
  }
  const envVars = new Map<string, string>();
  for (const [productId, product] of Object.entries(catalog.products)) {
    for (const [priceId, price] of Object.entries(product.prices)) {
      const owner = `${productId}.${priceId}`;
      const existing = envVars.get(price.envVar);
      if (existing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe catalog prices "${existing}" and "${owner}" both manage ${price.envVar}`,
          path: ['products', productId, 'prices', priceId, 'envVar'],
        });
      } else {
        envVars.set(price.envVar, owner);
      }
    }
  }
});

export const STRIPE_DEFAULT_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.created',
  'customer.updated',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
] as const;

export const stripeWebhookSpecSchema = z.object({
  /** Public HTTPS endpoint that receives Stripe events. */
  url: z.string().url().refine(
    (value) => value.toLowerCase().startsWith('https://'),
    'Stripe webhook URLs must use HTTPS'
  ),
  /** Exactly one service receives this endpoint's signing value. */
  service: z.string().min(1),
  /** Hosting variable that receives the signing value returned at endpoint creation. */
  envVar: runtimeEnvVarNameSchema.default('STRIPE_WEBHOOK_SECRET'),
  /** Stripe events delivered to this endpoint. */
  events: z.array(z.string().min(1)).min(1).default([...STRIPE_DEFAULT_WEBHOOK_EVENTS]),
}).strict().superRefine((webhook, ctx) => {
  const seen = new Set<string>();
  for (const [index, event] of webhook.events.entries()) {
    if (seen.has(event)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Stripe webhook event "${event}" is listed more than once`,
        path: ['events', index],
      });
    }
    seen.add(event);
  }
});

export const stripeEnvironmentSyncSpecSchema = z.object({
  /**
   * Stripe connection scope. Defaults to this Hypervibe environment name,
   * allowing development/staging/production to use isolated Stripe sandboxes.
   */
  environment: z.string().min(1).optional(),
  /** Services receiving the managed Stripe variables. Defaults to every service. */
  services: z.array(z.string().min(1)).min(1).optional(),
  /**
   * Opt-in runtime credential projection. Values come from the encrypted
   * scoped Stripe connection and never enter the committed spec or plan.
   */
  credentials: z.object({
    secretKeyEnvVar: runtimeEnvVarNameSchema.default('STRIPE_SECRET_KEY'),
    publishableKeyEnvVar: runtimeEnvVarNameSchema.optional(),
  }).strict().optional(),
  /** Hypervibe-owned SaaS product and recurring-price catalog for this environment. */
  catalog: stripeCatalogSpecSchema.optional(),
  /**
   * Removed compatibility field. It remains in the parser only so old specs
   * receive an actionable migration error instead of an unknown-key message.
   */
  prices: z.record(runtimeEnvVarNameSchema, stripePriceEnvBindingSpecSchema).optional(),
  /**
   * Named Stripe webhook endpoints. Hypervibe owns each endpoint lifecycle,
   * projects its creation-only signing value to one service, and records only
   * provider identity plus a value hash in bindings.
   */
  webhooks: z.record(z.string().min(1), stripeWebhookSpecSchema).default({}),
}).strict().superRefine((stripe, ctx) => {
  if (
    !stripe.credentials
    && !stripe.catalog
    && Object.keys(stripe.webhooks).length === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stripe environment sync requires credentials, a price binding, and/or a webhook',
    });
  }
  if (stripe.prices !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'payments.stripe.prices selectors have been removed. Declare owned recurring prices under payments.stripe.catalog.products and put envVar on each price.',
      path: ['prices'],
    });
  }
  if (
    stripe.credentials?.publishableKeyEnvVar
    && stripe.credentials.publishableKeyEnvVar === stripe.credentials.secretKeyEnvVar
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stripe secret and publishable keys must use different runtime environment variable names',
      path: ['credentials'],
    });
  }
  if (stripe.credentials) {
    for (const key of [
      stripe.credentials.secretKeyEnvVar,
      ...(stripe.credentials.publishableKeyEnvVar ? [stripe.credentials.publishableKeyEnvVar] : []),
    ]) {
      const catalogEnvVars = new Set(
        Object.values(stripe.catalog?.products ?? {})
          .flatMap((product) => Object.values(product.prices).map((price) => price.envVar))
      );
      if (catalogEnvVars.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe runtime credential variable "${key}" cannot also be a catalog price binding`,
          path: ['catalog'],
        });
      }
    }
  }

  const webhookUrls = new Map<string, string>();
  const webhookSlots = new Map<string, string>();
  for (const [name, webhook] of Object.entries(stripe.webhooks)) {
    const existingUrl = webhookUrls.get(webhook.url);
    if (existingUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Stripe webhooks "${existingUrl}" and "${name}" use the same URL`,
        path: ['webhooks', name, 'url'],
      });
    } else {
      webhookUrls.set(webhook.url, name);
    }

    const slot = `${webhook.service}\0${webhook.envVar}`;
    const existingSlot = webhookSlots.get(slot);
    if (existingSlot) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Stripe webhooks "${existingSlot}" and "${name}" both manage ${webhook.envVar} on service "${webhook.service}"`,
        path: ['webhooks', name, 'envVar'],
      });
    } else {
      webhookSlots.set(slot, name);
    }
  }
});

export const paymentsSpecSchema = z.object({
  stripe: stripeEnvironmentSyncSpecSchema.optional(),
}).strict();

export const environmentSpecSchema = z.object({
  hosting: z.object({
    /** Hosting provider name; validated against the adapter registry at spec_set time. */
    provider: z.string().min(1),
    region: z.string().min(1).optional(),
  }),
  services: z.record(z.string().min(1), serviceSpecSchema).default({}),
  database: databaseSpecSchema.optional(),
  cache: cacheSpecSchema.optional(),
  domain: z.string().min(1).optional(),
  domainRegistration: domainRegistrationSpecSchema.optional(),
  email: z.object({ enabled: z.boolean() }).default({ enabled: false }),
  envVars: z.record(z.string()).default({}),
  /** Explicitly documents that a shared runtime key does not apply here. */
  envVarExceptions: z.array(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'exception keys must be valid environment variable names')
  ).optional(),
  /**
   * Durable, explicit tombstones for provider variables that Hypervibe should
   * delete. Variables merely omitted from envVars remain untouched.
   */
  removeEnvVars: z.array(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'retired keys must be valid environment variable names')
  ).optional(),
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
  payments: paymentsSpecSchema.optional(),
  /** Kept only to produce an actionable migration error for old specs. */
  autofix: z.unknown().optional(),
}).superRefine((environment, ctx) => {
  if (environment.autofix !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'environments.*.autofix has been removed. Use hv_errors action="list" or action="summary" for live runtime errors; use github.actions.<id> kind="autofix" to repair failed GitHub workflow checks.',
      path: ['autofix'],
    });
  }
  if (environment.domainRegistration && !environment.domain) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'domainRegistration requires domain',
      path: ['domainRegistration'],
    });
  }
  if (environment.ios?.release) {
    for (const [index, serviceName] of environment.ios.release.services.entries()) {
      if (!environment.services[serviceName]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `iOS release gate targets unknown service "${serviceName}"`,
          path: ['ios', 'release', 'services', index],
        });
      }
    }
    if (
      environment.deploy?.strategy !== 'branch'
      || (environment.deploy.trigger ?? 'ci') !== 'ci'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ios.release requires deploy.strategy="branch" and deploy.trigger="ci" so mobile releases can consume server deploy evidence',
        path: ['ios', 'release'],
      });
    }
  }
  if (environment.queues && Object.keys(environment.queues).length > 0
    && environment.hosting.provider === 'railway'
    && (!environment.database || environment.database.engine !== 'postgres')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'railway queues are postgres-backed (pg-boss model): declare a postgres spec.database',
      path: ['queues'],
    });
  }
  const databaseAliasKeys = new Set<string>();
  for (const [serviceName, service] of Object.entries(environment.services)) {
    for (const [alias, source] of Object.entries(service.databaseEnvAliases ?? {})) {
      databaseAliasKeys.add(alias);
      if (!environment.database) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `service "${serviceName}" declares databaseEnvAliases but this environment has no database`,
          path: ['services', serviceName, 'databaseEnvAliases'],
        });
      }
      if ((DATABASE_ENV_ALIAS_SOURCES as readonly string[]).includes(alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `database alias "${alias}" cannot replace a canonical managed database variable`,
          path: ['services', serviceName, 'databaseEnvAliases', alias],
        });
      }
      if (alias in environment.envVars) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `database alias "${alias}" cannot also be declared in envVars`,
          path: ['services', serviceName, 'databaseEnvAliases', alias],
        });
      }
      if (environment.envFile?.include.includes(alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `database alias "${alias}" cannot also be selected through envFile.include`,
          path: ['services', serviceName, 'databaseEnvAliases', alias],
        });
      }
      if (environment.removeEnvVars?.includes(alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `database alias "${alias}" cannot also be retired`,
          path: ['services', serviceName, 'databaseEnvAliases', alias],
        });
      }
    }
  }
  const retiredKeys = new Set<string>();
  for (const key of environment.removeEnvVars ?? []) {
    if (retiredKeys.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `retired environment variable "${key}" is listed more than once`,
        path: ['removeEnvVars'],
      });
    }
    retiredKeys.add(key);
    if (key in environment.envVars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `retired environment variable "${key}" cannot also be declared in envVars`,
        path: ['removeEnvVars'],
      });
    }
    if (environment.envFile?.include.includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `retired environment variable "${key}" cannot also be selected through envFile.include`,
        path: ['removeEnvVars'],
      });
    }
  }
  const exceptionKeys = new Set<string>();
  for (const key of environment.envVarExceptions ?? []) {
    if (exceptionKeys.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `environment variable exception "${key}" is listed more than once`,
        path: ['envVarExceptions'],
      });
    }
    exceptionKeys.add(key);
    if (key in environment.envVars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `environment variable exception "${key}" cannot also be declared in envVars`,
        path: ['envVarExceptions'],
      });
    }
    if (environment.envFile?.include.includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `environment variable exception "${key}" cannot also be selected through envFile.include`,
        path: ['envVarExceptions'],
      });
    }
    if (environment.removeEnvVars?.includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `environment variable exception "${key}" cannot also be retired`,
        path: ['envVarExceptions'],
      });
    }
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
  const stripe = environment.payments?.stripe;
  if (stripe) {
    const catalogEnvVars = Object.values(stripe.catalog?.products ?? {})
      .flatMap((product) => Object.values(product.prices).map((price) => price.envVar));
    const hasRuntimeProjection = Boolean(stripe.credentials) || catalogEnvVars.length > 0;
    const targetServices = stripe.services
      ?? (hasRuntimeProjection ? Object.keys(environment.services) : []);
    if (hasRuntimeProjection && targetServices.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Stripe runtime environment sync requires at least one target service',
        path: ['payments', 'stripe', 'services'],
      });
    }
    const seenServices = new Set<string>();
    for (const serviceName of targetServices) {
      if (seenServices.has(serviceName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe environment sync service "${serviceName}" is listed more than once`,
          path: ['payments', 'stripe', 'services'],
        });
      }
      seenServices.add(serviceName);
      if (!environment.services[serviceName]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe environment sync targets unknown service "${serviceName}"`,
          path: ['payments', 'stripe', 'services'],
        });
      }
    }

    for (const [webhookName, webhook] of Object.entries(stripe.webhooks)) {
      if (!environment.services[webhook.service]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe webhook "${webhookName}" targets unknown service "${webhook.service}"`,
          path: ['payments', 'stripe', 'webhooks', webhookName, 'service'],
        });
      }
      if (
        targetServices.includes(webhook.service)
        && (
          catalogEnvVars.includes(webhook.envVar)
          || stripe.credentials?.secretKeyEnvVar === webhook.envVar
          || stripe.credentials?.publishableKeyEnvVar === webhook.envVar
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe webhook "${webhookName}" cannot manage ${webhook.envVar} on service "${webhook.service}" because Stripe runtime sync also manages that variable`,
          path: ['payments', 'stripe', 'webhooks', webhookName, 'envVar'],
        });
      }
    }

    const managedKeys = new Set([
      ...catalogEnvVars,
      ...(stripe.credentials
        ? [
          stripe.credentials.secretKeyEnvVar,
          ...(stripe.credentials.publishableKeyEnvVar ? [stripe.credentials.publishableKeyEnvVar] : []),
        ]
        : []),
      ...Object.values(stripe.webhooks).map((webhook) => webhook.envVar),
    ]);
    for (const key of managedKeys) {
      if (databaseAliasKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe-managed environment variable "${key}" cannot also be a managed database alias`,
          path: ['payments', 'stripe'],
        });
      }
      if (key in environment.envVars) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe-managed environment variable "${key}" cannot also be declared in envVars`,
          path: ['envVars', key],
        });
      }
      if (environment.envVarExceptions?.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe-managed environment variable "${key}" cannot also be an environment variable exception`,
          path: ['envVarExceptions'],
        });
      }
      if (environment.envFile?.include.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe-managed environment variable "${key}" cannot also be selected through envFile.include`,
          path: ['envFile', 'include'],
        });
      }
      if (environment.removeEnvVars?.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe-managed environment variable "${key}" cannot also be retired`,
          path: ['removeEnvVars'],
        });
      }
    }
  }
});

export const projectSpecSchema = z.object({
  version: z.literal(1),
  project: z.string().min(1),
  gitRemoteUrl: z.string().min(1).optional(),
  github: githubSpecSchema.optional(),
  /** @deprecated Use github.collaboration. Accepted for one compatibility period. */
  collaboration: collaborationSpecSchema.optional(),
  secrets: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'secret names must be valid environment variable names'),
    delegatedSecretSpecSchema
  ).default({}),
  environments: z.record(z.string().min(1), environmentSpecSchema),
}).superRefine((spec, ctx) => {
  if (spec.github && spec.collaboration) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Use github.collaboration; github and legacy top-level collaboration cannot both be declared',
      path: ['collaboration'],
    });
  }
  if (spec.github?.canonicalEnvironment && !spec.environments[spec.github.canonicalEnvironment]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `github.canonicalEnvironment targets unknown environment "${spec.github.canonicalEnvironment}"`,
      path: ['github', 'canonicalEnvironment'],
    });
  }
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
      if (environment.envVarExceptions?.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot also be an environment variable exception in "${environmentName}"`,
          path: ['environments', environmentName, 'envVarExceptions'],
        });
      }
      if (environment.envFile?.include.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot be selected through environments.${environmentName}.envFile.include`,
          path: ['environments', environmentName, 'envFile', 'include'],
        });
      }
      if (environment.removeEnvVars?.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot also be retired in environment "${environmentName}"`,
          path: ['environments', environmentName, 'removeEnvVars'],
        });
      }
      const databaseAliasServices = Object.entries(environment.services)
        .filter(([, service]) => key in (service.databaseEnvAliases ?? {}))
        .map(([serviceName]) => serviceName);
      if (databaseAliasServices.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot also be a managed database alias on service(s): ${databaseAliasServices.join(', ')}`,
          path: ['secrets', key],
        });
      }
      const stripe = environment.payments?.stripe;
      const catalogEnvVars = Object.values(stripe?.catalog?.products ?? {})
        .flatMap((product) => Object.values(product.prices).map((price) => price.envVar));
      const stripeManagedKeys = new Set([
        ...catalogEnvVars,
        ...(stripe?.credentials
          ? [
            stripe.credentials.secretKeyEnvVar,
            ...(stripe.credentials.publishableKeyEnvVar ? [stripe.credentials.publishableKeyEnvVar] : []),
          ]
          : []),
        ...Object.values(stripe?.webhooks ?? {}).map((webhook) => webhook.envVar),
      ]);
      if (stripeManagedKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot also be managed by Stripe environment sync in "${environmentName}"`,
          path: ['secrets', key],
        });
      }
    }
  }
});

export type ServiceSpec = z.infer<typeof serviceSpecSchema>;
export type DatabaseSpec = z.infer<typeof databaseSpecSchema>;
export type IosSpec = z.infer<typeof iosSpecSchema>;
export type IosReleaseSpec = z.infer<typeof iosReleaseSpecSchema>;
export type QueueSpec = z.infer<typeof queueSpecSchema>;
export type StorageSpec = z.infer<typeof storageSpecSchema>;
export type StripePriceEnvBindingSpec = z.infer<typeof stripePriceEnvBindingSpecSchema>;
export type StripeCatalogPriceSpec = z.infer<typeof stripeCatalogPriceSpecSchema>;
export type StripeCatalogProductSpec = z.infer<typeof stripeCatalogProductSpecSchema>;
export type StripeCatalogSpec = z.infer<typeof stripeCatalogSpecSchema>;
export type StripeWebhookSpec = z.infer<typeof stripeWebhookSpecSchema>;
export type StripeEnvironmentSyncSpec = z.infer<typeof stripeEnvironmentSyncSpecSchema>;
export type PaymentsSpec = z.infer<typeof paymentsSpecSchema>;
export type IosTestflightGroupSpec = z.infer<typeof iosTestflightGroupSpecSchema>;
export type DomainRegistrationSpec = z.infer<typeof domainRegistrationSpecSchema>;
export type EnvFileSpec = z.infer<typeof envFileSpecSchema>;
export type DelegatedSecretSpec = z.infer<typeof delegatedSecretSpecSchema>;
export type CollaborationSpec = z.infer<typeof collaborationSpecSchema>;
export type GitHubScheduleSpec = z.infer<typeof githubScheduleSpecSchema>;
export type GitHubAutomationSpec = z.infer<typeof githubAutomationSpecSchema>;
export type GitHubSpec = z.infer<typeof githubSpecSchema>;
export type EnvironmentSpec = z.infer<typeof environmentSpecSchema>;
export type ProjectSpec = z.infer<typeof projectSpecSchema>;

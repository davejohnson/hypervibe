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
});

export const deploySpecSchema = z.object({
  strategy: z.enum(['branch', 'manual']).default('manual'),
  trigger: z.enum(['ci', 'native']).optional(),
  branch: z.string().min(1).optional(),
});

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
  deploy: deploySpecSchema.optional(),
  migrations: migrationsSpecSchema.optional(),
  ios: iosSpecSchema.optional(),
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
});

export const projectSpecSchema = z.object({
  version: z.literal(1),
  project: z.string().min(1),
  gitRemoteUrl: z.string().min(1).optional(),
  environments: z.record(z.string().min(1), environmentSpecSchema),
});

export type ServiceSpec = z.infer<typeof serviceSpecSchema>;
export type DatabaseSpec = z.infer<typeof databaseSpecSchema>;
export type IosSpec = z.infer<typeof iosSpecSchema>;
export type IosTestflightGroupSpec = z.infer<typeof iosTestflightGroupSpecSchema>;
export type DomainRegistrationSpec = z.infer<typeof domainRegistrationSpecSchema>;
export type EnvironmentSpec = z.infer<typeof environmentSpecSchema>;
export type ProjectSpec = z.infer<typeof projectSpecSchema>;

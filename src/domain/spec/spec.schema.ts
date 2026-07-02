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
  workloadKind: z.enum(['web', 'worker', 'cron', 'job']).default('web'),
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
export type DomainRegistrationSpec = z.infer<typeof domainRegistrationSpecSchema>;
export type EnvironmentSpec = z.infer<typeof environmentSpecSchema>;
export type ProjectSpec = z.infer<typeof projectSpecSchema>;

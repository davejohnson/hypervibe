import { z } from 'zod';

export const environmentConfigClassificationSchema = z.enum([
  'shared_required',
  'environment_specific',
  'managed_integration',
  'obsolete_or_misconfigured',
  'uncertain',
]);

export const environmentConfigRecommendedActionSchema = z.enum([
  'supply_delegated_secret',
  'declare_delegated_secret',
  'set_environment_value',
  'configure_managed_integration',
  'keep_environment_specific',
  'retire_key',
  'investigate',
]);

export const environmentConfigAdviceSchema = z.object({
  summary: z.string().min(1).max(1_000),
  decisions: z.array(z.object({
    candidateId: z.string().min(1).max(80),
    classification: environmentConfigClassificationSchema,
    severity: z.enum(['critical', 'warning', 'info']),
    confidence: z.enum(['high', 'medium', 'low']),
    valueSensitivity: z.enum(['secret', 'public_identifier', 'non_secret', 'unknown']),
    rationale: z.string().min(1).max(600),
    recommendedAction: environmentConfigRecommendedActionSchema,
  }).strict()).max(250),
}).strict();

export type EnvironmentConfigAdvice = z.infer<typeof environmentConfigAdviceSchema>;
export type EnvironmentConfigDecision = EnvironmentConfigAdvice['decisions'][number];

const declarationSchema = z.enum(['ordinary', 'delegated', 'retired', 'unmanaged']);

export const environmentConfigAdvisorCandidateSchema = z.object({
  id: z.string().min(1).max(80),
  service: z.string().min(1).max(200),
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200),
  presentIn: z.array(z.string().min(1).max(200)).max(8),
  missingFrom: z.array(z.string().min(1).max(200)).max(8),
  declarations: z.record(z.string().min(1).max(200), declarationSchema),
}).strict();

export const environmentConfigAdvisorRequestSchema = z.object({
  comparisonEnvironments: z.array(z.string().min(1).max(200)).min(2).max(8),
  environmentFeatures: z.record(z.string().min(1).max(200), z.object({
    provider: z.string().min(1).max(100),
    database: z.boolean(),
    cache: z.boolean(),
    storage: z.boolean(),
    queues: z.boolean(),
    payments: z.boolean(),
    email: z.boolean(),
  }).strict()),
  candidates: z.array(environmentConfigAdvisorCandidateSchema).min(1).max(250),
}).strict();

export type EnvironmentConfigAdvisorCandidate = z.infer<typeof environmentConfigAdvisorCandidateSchema>;
export type EnvironmentConfigAdvisorRequest = z.infer<typeof environmentConfigAdvisorRequestSchema>;

export type EnvironmentConfigAdvisorResult = {
  model: string;
  advice: EnvironmentConfigAdvice;
};

export interface IEnvironmentConfigAdvisor {
  analyzeEnvironmentConfiguration(
    request: EnvironmentConfigAdvisorRequest
  ): Promise<EnvironmentConfigAdvisorResult>;
}

export const ENVIRONMENT_CONFIG_ADVICE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 1_000 },
    decisions: {
      type: 'array',
      maxItems: 250,
      items: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', minLength: 1, maxLength: 80 },
          classification: {
            type: 'string',
            enum: [
              'shared_required',
              'environment_specific',
              'managed_integration',
              'obsolete_or_misconfigured',
              'uncertain',
            ],
          },
          severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          valueSensitivity: {
            type: 'string',
            enum: ['secret', 'public_identifier', 'non_secret', 'unknown'],
          },
          rationale: { type: 'string', minLength: 1, maxLength: 600 },
          recommendedAction: {
            type: 'string',
            enum: [
              'supply_delegated_secret',
              'declare_delegated_secret',
              'set_environment_value',
              'configure_managed_integration',
              'keep_environment_specific',
              'retire_key',
              'investigate',
            ],
          },
        },
        required: [
          'candidateId',
          'classification',
          'severity',
          'confidence',
          'valueSensitivity',
          'rationale',
          'recommendedAction',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'decisions'],
  additionalProperties: false,
} as const;

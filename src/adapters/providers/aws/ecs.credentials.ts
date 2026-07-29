import { z } from 'zod';

const awsRegion = z
  .string()
  .regex(
    /^[a-z]{2}(?:-[a-z]+)+-\d$/,
    'AWS region must look like us-east-1'
  )
  .refine(
    (value) => !value.startsWith('cn-') && !value.startsWith('us-gov-'),
    'This adapter currently supports the commercial AWS partition only'
  );
const iamRoleArn = z.string().regex(
  /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/,
  'AWS IAM role must be a full commercial-partition role ARN'
);
const ecrRepositoryArn = z.string().regex(
  /^arn:aws:ecr:[a-z0-9-]+:\d{12}:repository\/[a-z0-9][a-z0-9._/-]*$/,
  'ECR repository must be a full commercial-partition repository ARN'
);
const targetGroupArn = z.string().regex(
  /^arn:aws:elasticloadbalancing:[a-z0-9-]+:\d{12}:targetgroup\/[A-Za-z0-9-]+\/[a-f0-9]+$/,
  'Target group must be a full commercial-partition target-group ARN'
);
const publicUrl = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return (
    ['http:', 'https:'].includes(parsed.protocol)
    && parsed.pathname === '/'
    && !parsed.search
    && !parsed.hash
    && !parsed.username
    && !parsed.password
  );
}, 'AWS public URL must be an HTTP(S) origin without a path, query, credentials, or fragment');

export const EcsCredentialsSchema = z.object({
  accessKeyId: z
    .string()
    .min(16, 'AWS IAM access key ID is required')
    .describe('AWS IAM access key ID for Hypervibe and managed CI'),
  secretAccessKey: z
    .string()
    .min(1, 'AWS IAM secret access key is required')
    .describe('AWS IAM secret access key for Hypervibe and managed CI'),
  region: awsRegion.default('us-east-1'),
  ecrRepositoryArn,
  ecrRepositoryUri: z
    .string()
    .regex(
      /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]*$/,
      'ECR repository URI must be the full private repository URI'
    ),
  subnetIds: z
    .array(z.string().regex(/^subnet-[a-f0-9]+$/, 'Invalid AWS subnet ID'))
    .min(1, 'At least one existing subnet ID is required')
    .max(16, 'AWS ECS supports at most 16 subnets per service')
    .refine(
      (values) => new Set(values).size === values.length,
      'AWS subnet IDs must be unique'
    ),
  securityGroupIds: z
    .array(z.string().regex(/^sg-[a-f0-9]+$/, 'Invalid AWS security group ID'))
    .min(1, 'At least one existing security group ID is required')
    .max(5, 'AWS ECS supports at most 5 security groups per service')
    .refine(
      (values) => new Set(values).size === values.length,
      'AWS security group IDs must be unique'
    ),
  assignPublicIp: z.boolean().default(false),
  executionRoleArn: iamRoleArn,
  taskRoleArn: iamRoleArn.optional(),
  targetGroupArn: targetGroupArn.optional(),
  publicUrl: publicUrl.optional(),
  containerPort: z.number().int().min(1).max(65535).default(8080),
  cpu: z.enum(['256', '512', '1024', '2048', '4096']).default('256'),
  memory: z
    .enum([
      '512',
      '1024',
      '2048',
      '3072',
      '4096',
      '5120',
      '6144',
      '7168',
      '8192',
      '9216',
      '10240',
      '11264',
      '12288',
      '13312',
      '14336',
      '15360',
      '16384',
      '17408',
      '18432',
      '19456',
      '20480',
      '21504',
      '22528',
      '23552',
      '24576',
      '25600',
      '26624',
      '27648',
      '28672',
      '29696',
      '30720',
    ])
    .default('512'),
}).superRefine((credentials, context) => {
  const repository = parseAwsArn(credentials.ecrRepositoryArn);
  const executionRole = parseAwsArn(credentials.executionRoleArn);
  const taskRole = credentials.taskRoleArn
    ? parseAwsArn(credentials.taskRoleArn)
    : null;
  const targetGroup = credentials.targetGroupArn
    ? parseAwsArn(credentials.targetGroupArn)
    : null;
  const uriMatch = credentials.ecrRepositoryUri.match(
    /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/(.+)$/
  );
  const expectedRepositoryName =
    credentials.ecrRepositoryArn.split(':repository/')[1];

  for (const [label, arn] of [
    ['execution role', executionRole],
    ['task role', taskRole],
    ['target group', targetGroup],
  ] as const) {
    if (arn && arn.accountId !== repository.accountId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `AWS ${label} must belong to ECR account ${repository.accountId}`,
      });
    }
  }
  if (
    repository.region !== credentials.region
    || (targetGroup && targetGroup.region !== credentials.region)
    || uriMatch?.[2] !== credentials.region
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'AWS ECR, target group, repository URI, and configured region must match',
    });
  }
  if (
    uriMatch?.[1] !== repository.accountId
    || uriMatch?.[3] !== expectedRepositoryName
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'AWS ECR repository ARN and repository URI must identify the same repository',
    });
  }
  if (!validFargateSize(credentials.cpu, credentials.memory)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `AWS Fargate does not support cpu=${credentials.cpu} with memory=${credentials.memory}`,
    });
  }
  if (credentials.publicUrl && !credentials.targetGroupArn) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'AWS publicUrl requires targetGroupArn',
    });
  }
});

export type EcsCredentials = z.infer<typeof EcsCredentialsSchema>;

function parseAwsArn(value: string): {
  region: string;
  accountId: string;
} {
  const [, , , region = '', accountId = ''] = value.split(':');
  return { region, accountId };
}

function validFargateSize(cpu: string, memory: string): boolean {
  const value = Number(memory);
  switch (cpu) {
    case '256':
      return [512, 1024, 2048].includes(value);
    case '512':
      return [1024, 2048, 3072, 4096].includes(value);
    case '1024':
      return value >= 2048 && value <= 8192 && value % 1024 === 0;
    case '2048':
      return value >= 4096 && value <= 16384 && value % 1024 === 0;
    case '4096':
      return value >= 8192 && value <= 30720 && value % 1024 === 0;
    default:
      return false;
  }
}

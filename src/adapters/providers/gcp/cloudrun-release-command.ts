import { hashEnvValue } from '../../../domain/ports/observe.port.js';

/** Versioned provider metadata key for the non-secret release-command digest. */
export const CLOUD_RUN_RELEASE_COMMAND_HASH_ANNOTATION = 'hypervibe.dev/release-command-sha256-v1';

/** Provider-resolved source commit that produced the deployed immutable image. */
export const CLOUD_RUN_SOURCE_COMMIT_ANNOTATION = 'hypervibe.dev/source-commit-sha-v1';

export function cloudRunReleaseCommandHash(command: string): string {
  return hashEnvValue(command.trim());
}

/** Deterministic Cloud Run Job id that remains collision-safe after the 63-character limit. */
export function cloudRunMigrationJobName(serviceName: string): string {
  const normalized = serviceName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) throw new Error('Cloud Run migration jobs require a service name');

  const suffix = '-migration';
  if (`${normalized}${suffix}`.length <= 63) return `${normalized}${suffix}`;

  const hashSuffix = `-${hashEnvValue(normalized).slice(0, 10)}${suffix}`;
  const prefix = normalized
    .slice(0, 63 - hashSuffix.length)
    .replace(/-+$/g, '');
  return `${prefix}${hashSuffix}`;
}

type CloudRunReleaseJobShape = {
  name?: string;
  template?: {
    template?: {
      containers?: Array<Record<string, unknown>>;
      volumes?: Array<Record<string, unknown>>;
      serviceAccount?: string;
      serviceAccountName?: string;
      vpcAccess?: Record<string, unknown>;
      maxRetries?: number;
      timeout?: string;
    };
  };
};

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) {
    const entries = value.map(comparable);
    return entries.every((entry) => (
      entry !== null
      && typeof entry === 'object'
      && typeof (entry as Record<string, unknown>).name === 'string'
    ))
      ? entries.sort((left, right) => (
          String((left as Record<string, unknown>).name)
            .localeCompare(String((right as Record<string, unknown>).name))
        ))
      : entries;
  }
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, comparable(entry)])
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function sameOptionalList(left: unknown, right: unknown): boolean {
  const normalizedLeft = Array.isArray(left) && left.length === 0 ? undefined : left;
  const normalizedRight = Array.isArray(right) && right.length === 0 ? undefined : right;
  return same(normalizedLeft, normalizedRight);
}

/**
 * Return the first release-job field that did not converge to the reviewed
 * candidate. Provider-populated output fields are ignored; every executable
 * input is compared before the job may run.
 */
export function cloudRunReleaseJobConfigurationMismatch(
  observedValue: unknown,
  expectedResourceName: string,
  expectedValue: unknown
): string | null {
  const observed = observedValue as CloudRunReleaseJobShape;
  const expectedSpec = expectedValue as CloudRunReleaseJobShape;
  if (observed.name !== expectedResourceName) return 'resource identity';
  const actualTask = observed.template?.template;
  const expectedTask = expectedSpec.template?.template;
  if (!actualTask || !expectedTask) return 'task';
  if (actualTask.containers?.length !== 1 || expectedTask.containers?.length !== 1) {
    return 'task containers';
  }
  const actualContainer = actualTask.containers[0]!;
  const expectedContainer = expectedTask.containers[0]!;
  for (const field of ['image', 'command', 'args'] as const) {
    if (!same(actualContainer[field], expectedContainer[field])) return `container ${field}`;
  }
  for (const field of ['env', 'volumeMounts'] as const) {
    if (!sameOptionalList(actualContainer[field], expectedContainer[field])) return `container ${field}`;
  }
  const actualResources = actualContainer.resources as Record<string, unknown> | undefined;
  const expectedResources = expectedContainer.resources as Record<string, unknown> | undefined;
  if (actualResources?.cpuIdle !== undefined) return 'container resources.cpuIdle';
  if (!same(actualResources?.limits, expectedResources?.limits)) return 'container resource limits';
  if (!sameOptionalList(actualTask.volumes, expectedTask.volumes)) return 'task volumes';
  const actualServiceAccount = actualTask.serviceAccount ?? actualTask.serviceAccountName;
  const expectedServiceAccount = expectedTask.serviceAccount ?? expectedTask.serviceAccountName;
  if (actualServiceAccount !== expectedServiceAccount) return 'task serviceAccount';
  for (const field of ['vpcAccess', 'maxRetries', 'timeout'] as const) {
    if (!same(actualTask[field], expectedTask[field])) return `task ${field}`;
  }
  return null;
}

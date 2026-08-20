import { Buffer } from 'node:buffer';

export interface FlyServiceBinding {
  version: 1;
  organizationSlug: string;
  appId: string;
  appName: string;
  machineId?: string;
}

export interface FlyEnvironmentBinding {
  version: 1;
  organizationSlug: string;
  projectName: string;
  environmentName: string;
}

const SERVICE_PREFIX = 'flyapp:v1:';
const ENVIRONMENT_PREFIX = 'flyenv:v1:';

function validIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

export function formatFlyOrganizationBinding(organizationSlug: string): string {
  if (!/^(?:personal|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/.test(organizationSlug)) {
    throw new Error(`Invalid Fly.io organization slug "${organizationSlug}".`);
  }
  return `flyorg:${organizationSlug}`;
}

export function parseFlyOrganizationBinding(value: string): string {
  const match = /^flyorg:(personal|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/.exec(
    value.trim()
  );
  if (!match) {
    throw new Error(
      `Invalid Fly.io organization binding "${value}". Expected flyorg:<organization-slug>.`
    );
  }
  return match[1]!;
}

export function formatFlyEnvironmentBinding(
  input: Omit<FlyEnvironmentBinding, 'version'>
): string {
  parseFlyOrganizationBinding(formatFlyOrganizationBinding(input.organizationSlug));
  for (const [label, value] of [
    ['project name', input.projectName],
    ['environment name', input.environmentName],
  ] as const) {
    if (!value.trim() || value !== value.trim() || value.length > 255) {
      throw new Error(`Invalid Fly.io ${label} "${value}".`);
    }
  }
  const encoded = Buffer.from(JSON.stringify({ version: 1, ...input }), 'utf8')
    .toString('base64url');
  return `${ENVIRONMENT_PREFIX}${encoded}`;
}

export function parseFlyEnvironmentBinding(value: string): FlyEnvironmentBinding {
  if (!value.startsWith(ENVIRONMENT_PREFIX)) {
    throw new Error(
      `Invalid Fly.io environment binding "${value}". Expected ${ENVIRONMENT_PREFIX}<binding>.`
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(value.slice(ENVIRONMENT_PREFIX.length), 'base64url').toString('utf8')
    );
  } catch {
    throw new Error('Invalid Fly.io environment binding payload.');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Invalid Fly.io environment binding payload.');
  }
  const candidate = decoded as Record<string, unknown>;
  if (
    candidate.version !== 1
    || typeof candidate.organizationSlug !== 'string'
    || typeof candidate.projectName !== 'string'
    || typeof candidate.environmentName !== 'string'
  ) {
    throw new Error('Invalid Fly.io environment binding fields.');
  }
  const normalized: FlyEnvironmentBinding = {
    version: 1,
    organizationSlug: candidate.organizationSlug,
    projectName: candidate.projectName,
    environmentName: candidate.environmentName,
  };
  if (formatFlyEnvironmentBinding(normalized) !== value) {
    throw new Error('Fly.io environment binding is not canonical.');
  }
  return normalized;
}

export function formatFlyServiceBinding(
  input: Omit<FlyServiceBinding, 'version'>
): string {
  parseFlyOrganizationBinding(formatFlyOrganizationBinding(input.organizationSlug));
  for (const [label, value] of [
    ['app ID', input.appId],
    ['app name', input.appName],
    ...(input.machineId ? [['Machine ID', input.machineId] as const] : []),
  ] as const) {
    if (!validIdentity(value)) {
      throw new Error(`Invalid Fly.io ${label} "${value}".`);
    }
  }
  const encoded = Buffer.from(JSON.stringify({ version: 1, ...input }), 'utf8')
    .toString('base64url');
  return `${SERVICE_PREFIX}${encoded}`;
}

export function parseFlyServiceBinding(value: string): FlyServiceBinding {
  if (!value.startsWith(SERVICE_PREFIX)) {
    throw new Error(
      `Invalid Fly.io service binding "${value}". Expected ${SERVICE_PREFIX}<binding>.`
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(value.slice(SERVICE_PREFIX.length), 'base64url').toString('utf8')
    );
  } catch {
    throw new Error('Invalid Fly.io service binding payload.');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Invalid Fly.io service binding payload.');
  }
  const candidate = decoded as Record<string, unknown>;
  if (
    candidate.version !== 1
    || typeof candidate.organizationSlug !== 'string'
    || typeof candidate.appId !== 'string'
    || typeof candidate.appName !== 'string'
    || (candidate.machineId !== undefined && typeof candidate.machineId !== 'string')
  ) {
    throw new Error('Invalid Fly.io service binding fields.');
  }
  const normalized: FlyServiceBinding = {
    version: 1,
    organizationSlug: candidate.organizationSlug,
    appId: candidate.appId,
    appName: candidate.appName,
    ...(candidate.machineId ? { machineId: candidate.machineId } : {}),
  };
  const roundTrip = formatFlyServiceBinding(normalized);
  if (roundTrip !== value) {
    throw new Error('Fly.io service binding is not canonical.');
  }
  return normalized;
}

import { z } from 'zod';

const DigitalOceanAuthenticationSchema = z.object({
  apiToken: z
    .string({ required_error: 'DigitalOcean personal access token is required' })
    .min(1, 'DigitalOcean personal access token is required'),
}).strict();

const LEGACY_CONFIGURATION_FIELDS = new Set([
  'region',
  'appRegion',
  'appInstanceSize',
  'databaseSize',
  'postgresVersion',
  'valkeyVersion',
]);

export const DigitalOceanCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(([key]) => !LEGACY_CONFIGURATION_FIELDS.has(key))
  );
}, DigitalOceanAuthenticationSchema);

export type DigitalOceanCredentials = z.infer<
  typeof DigitalOceanCredentialsSchema
>;

export interface DigitalOceanRuntimeCredentials extends DigitalOceanCredentials {
  region: string;
  appRegion: string;
  appInstanceSize: string;
  databaseSize: string;
  postgresVersion: string;
  valkeyVersion: string;
}

const DEFAULTS: Omit<DigitalOceanRuntimeCredentials, 'apiToken'> = {
  region: 'nyc3',
  appRegion: 'nyc',
  appInstanceSize: 'apps-s-1vcpu-0.5gb',
  databaseSize: 'db-s-1vcpu-1gb',
  postgresVersion: '17',
  valkeyVersion: '8',
};

export function parseDigitalOceanRuntimeCredentials(input: unknown): DigitalOceanRuntimeCredentials {
  const authentication = DigitalOceanCredentialsSchema.parse(input);
  const legacy = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const configured = Object.fromEntries(
    Object.entries(DEFAULTS).map(([key, fallback]) => [
      key,
      typeof legacy[key] === 'string' && (legacy[key] as string).trim()
        ? (legacy[key] as string).trim()
        : fallback,
    ])
  ) as Omit<DigitalOceanRuntimeCredentials, 'apiToken'>;
  return { ...authentication, ...configured };
}

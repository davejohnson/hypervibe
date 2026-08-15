import type { StorageCredentials } from '../ports/storage.port.js';

export const S3_STORAGE_RUNTIME_ENV_KEYS = [
  'AWS_ENDPOINT_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_S3_BUCKET_NAME',
  'AWS_DEFAULT_REGION',
  'AWS_S3_URL_STYLE',
] as const;

export function s3StorageRuntimeEnv(credentials: StorageCredentials): Record<string, string> {
  return {
    AWS_ENDPOINT_URL: credentials.endpoint,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    ...(credentials.sessionToken ? { AWS_SESSION_TOKEN: credentials.sessionToken } : {}),
    AWS_S3_BUCKET_NAME: credentials.bucket,
    AWS_DEFAULT_REGION: credentials.region,
    AWS_S3_URL_STYLE: credentials.urlStyle,
  };
}

export function railwayStorageRuntimeEnv(name: string): Record<string, string> {
  const ref = (key: string) => `\${{${name}.${key}}}`;
  return {
    AWS_ENDPOINT_URL: ref('ENDPOINT'),
    AWS_ACCESS_KEY_ID: ref('ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: ref('SECRET_ACCESS_KEY'),
    AWS_S3_BUCKET_NAME: ref('BUCKET'),
    AWS_DEFAULT_REGION: ref('REGION'),
    AWS_S3_URL_STYLE: 'virtual',
  };
}

/**
 * Runtime contract for Hypervibe-owned helper code only.
 *
 * Application builds must never inherit this value. Keep it aligned with the
 * repository's .node-version; regression tests enforce that relationship.
 */
export const HYPERVIBE_MANAGED_NODE_VERSION = '24';

export const HYPERVIBE_MANAGED_NODE_SLIM_IMAGE = `node:${HYPERVIBE_MANAGED_NODE_VERSION}-slim`;
export const HYPERVIBE_MANAGED_NODE_ALPINE_IMAGE = `node:${HYPERVIBE_MANAGED_NODE_VERSION}-alpine`;

/** Exact, lockfile-verified packages materialized inside isolated managed jobs. */
export const HYPERVIBE_MANAGED_NPM_PACKAGES = {
  awsEcr: '@aws-sdk/client-ecr@3.1106.0',
  awsEcs: '@aws-sdk/client-ecs@3.1106.0',
  cloudSqlConnector: '@google-cloud/cloud-sql-connector@1.10.0',
  postgres: 'pg@8.17.2',
} as const;

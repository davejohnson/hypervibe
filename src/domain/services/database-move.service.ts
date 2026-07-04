import pg from 'pg';
import { spawn, spawnSync } from 'child_process';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { resolveProject } from './resolve-project.js';
import { adapterFactory } from './adapter.factory.js';
import { captureEnvironmentSnapshot, restoreEnvironmentSnapshot } from './local-state.transaction.js';
import { getTableEstimates, quoteIdentifier, resolveExternalDatabaseUrl } from './database-ops.service.js';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';

const envRepo = new EnvironmentRepository();
const componentRepo = new ComponentRepository();
const { Client } = pg;

const DB_PROVIDERS = ['supabase', 'cloudsql', 'railway'] as const;
const DB_MIGRATION_STRATEGIES = ['snapshot', 'logical_replication', 'managed_migration', 'read_replica_promote'] as const;

export async function provisionTargetDatabaseUrl(params: {
  projectId: string;
  projectName: string;
  envName: string;
  targetProvider: (typeof DB_PROVIDERS)[number];
  databaseName?: string;
  region?: string;
  size?: string;
}): Promise<string | null> {
  const project = resolveProject({ projectId: params.projectId, projectName: params.projectName });
  if (!project) return null;
  const env = envRepo.findByProjectAndName(project.id, params.envName);
  if (!env) return null;

  const dbAdapterResult = await adapterFactory.getDatabaseAdapter(params.targetProvider, project);
  if (!dbAdapterResult.success || !dbAdapterResult.adapter) return null;

  const envSnapshot = captureEnvironmentSnapshot(env);
  const provision = await dbAdapterResult.adapter.provision('postgres', env, {
    databaseName: params.databaseName,
    region: params.region,
    size: params.size,
  });
  if (!provision.receipt.success || !provision.connectionUrl) {
    restoreEnvironmentSnapshot(envRepo, envSnapshot);
    return null;
  }

  const existing = componentRepo.findByEnvironmentAndType(env.id, 'postgres');
  if (existing) {
    componentRepo.update(existing.id, {
      bindings: {
        ...provision.component.bindings,
        migrationCandidate: {
          targetProvider: params.targetProvider,
          targetConnectionString: provision.connectionUrl,
          sourceConnectionString: existing.bindings.connectionString,
          preparedAt: new Date().toISOString(),
        },
      },
      externalId: provision.component.externalId ?? undefined,
    });
  } else {
    componentRepo.create({
      environmentId: env.id,
      type: 'postgres',
      bindings: provision.component.bindings,
      externalId: provision.component.externalId ?? undefined,
    });
  }

  return provision.connectionUrl;
}

export function databaseMigrationStrategyStatus(strategy: (typeof DB_MIGRATION_STRATEGIES)[number]): Record<string, unknown> {
  if (strategy === 'snapshot') {
    return {
      selected: strategy,
      status: 'available',
      writeFreezeRequired: true,
      continuousReplication: false,
      detail: 'Uses pg_dump/pg_restore. Writes after the dump starts are not copied unless you freeze writes or run a final copy.',
    };
  }

  return {
    selected: strategy,
    status: 'planned',
    writeFreezeRequired: false,
    continuousReplication: true,
    detail: 'Not implemented yet. Requires provider-specific replication or migration service support.',
  };
}

export function overrideDatabaseName(url: string, databaseName?: string): string {
  const trimmed = databaseName?.trim();
  if (!trimmed) return url;

  try {
    const parsed = new URL(url);
    parsed.pathname = `/${encodeURIComponent(trimmed)}`;
    return parsed.toString();
  } catch {
    return url.replace(/\/([^/?#]*)([?#].*)?$/, `/${encodeURIComponent(trimmed)}$2`);
  }
}

export function hasCommand(command: string): boolean {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

export async function copyPostgresDatabase(sourceUrl: string, targetUrl: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const dump = spawn('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--dbname=${sourceUrl}`,
    ]);

    const restore = spawn('pg_restore', [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      `--dbname=${targetUrl}`,
    ]);

    let stderr = '';
    dump.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    restore.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    dump.stdout.pipe(restore.stdin);

    let dumpDone = false;
    let restoreDone = false;
    let dumpCode = 1;
    let restoreCode = 1;

    const maybeDone = () => {
      if (!dumpDone || !restoreDone) return;
      if (dumpCode === 0 && restoreCode === 0) {
        resolve({ success: true });
        return;
      }
      resolve({
        success: false,
        error: stderr.slice(0, 4000) || `pg_dump exited ${dumpCode}, pg_restore exited ${restoreCode}`,
      });
    };

    dump.on('close', (code) => {
      dumpDone = true;
      dumpCode = code ?? 1;
      maybeDone();
    });
    restore.on('close', (code) => {
      restoreDone = true;
      restoreCode = code ?? 1;
      maybeDone();
    });
  });
}

export async function getExactCountVerification(
  sourceUrl: string,
  targetUrl: string,
  criticalTables?: string[]
): Promise<{
  checkedTables: number;
  mismatches: Array<{ table: string; source: number; target: number }>;
  ok: boolean;
}> {
  const sourceEstimates = await getTableEstimates(sourceUrl);
  const candidateTables = criticalTables && criticalTables.length > 0
    ? criticalTables
    : Object.entries(sourceEstimates)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([table]) => table);

  const sourceCounts = await getExactCounts(sourceUrl, candidateTables);
  const targetCounts = await getExactCounts(targetUrl, candidateTables);

  const mismatches: Array<{ table: string; source: number; target: number }> = [];
  for (const table of candidateTables) {
    if (sourceCounts[table] !== targetCounts[table]) {
      mismatches.push({
        table,
        source: sourceCounts[table] ?? -1,
        target: targetCounts[table] ?? -1,
      });
    }
  }

  return {
    checkedTables: candidateTables.length,
    mismatches,
    ok: mismatches.length === 0,
  };
}

export async function getExactCounts(connectionUrl: string, tables: string[]): Promise<Record<string, number>> {
  const client = new Client({ connectionString: connectionUrl, statement_timeout: 30000 });
  await client.connect();
  try {
    const counts: Record<string, number> = {};
    for (const fullName of tables) {
      const [schemaRaw, tableRaw] = fullName.includes('.')
        ? fullName.split('.', 2)
        : ['public', fullName];
      const schema = quoteIdentifier(schemaRaw);
      const table = quoteIdentifier(tableRaw);
      const sql = `SELECT COUNT(*)::bigint::text AS c FROM ${schema}.${table}`;
      const result = await client.query<{ c: string }>(sql);
      counts[fullName] = Number(result.rows[0]?.c ?? 0);
    }
    return counts;
  } finally {
    await client.end().catch(() => {});
  }
}

export function compareTableEstimates(
  source: Record<string, number>,
  target: Record<string, number>
): {
  sourceTables: number;
  targetTables: number;
  missingTables: string[];
  mismatchedTables: Array<{ table: string; source: number; target: number; deltaPct: number }>;
  ok: boolean;
} {
  const missingTables: string[] = [];
  const mismatchedTables: Array<{ table: string; source: number; target: number; deltaPct: number }> = [];

  for (const [table, sourceRows] of Object.entries(source)) {
    const targetRows = target[table];
    if (targetRows === undefined) {
      missingTables.push(table);
      continue;
    }

    const denominator = Math.max(1, sourceRows);
    const deltaPct = Math.abs(targetRows - sourceRows) / denominator;
    if (deltaPct > 0.2) {
      mismatchedTables.push({ table, source: sourceRows, target: targetRows, deltaPct });
    }
  }

  return {
    sourceTables: Object.keys(source).length,
    targetTables: Object.keys(target).length,
    missingTables,
    mismatchedTables,
    ok: missingTables.length === 0 && mismatchedTables.length === 0,
  };
}

function connectionUrlFromBindings(bindings: Record<string, unknown> | null | undefined): string | undefined {
  if (!bindings) return undefined;
  if (typeof bindings.connectionUrl === 'string' && bindings.connectionUrl.length > 0) return bindings.connectionUrl;
  if (typeof bindings.connectionString === 'string' && bindings.connectionString.length > 0) return bindings.connectionString;
  return undefined;
}

export type ManagedMoveFailure = {
  ok: false;
  code: 'no_component' | 'no_source' | 'no_target' | 'same_database' | 'tooling' | 'copy_failed';
  error: string;
  hint?: string;
};

export type ManagedMoveSuccess = {
  ok: true;
  sourceProvider?: string;
  targetProvider?: string;
  verification: Awaited<ReturnType<typeof getExactCountVerification>>;
};

export interface ManagedMovePreview {
  sourceProvider?: string;
  targetProvider?: string;
  sourceResolved: boolean;
  targetResolved: boolean;
  strategy: Record<string, unknown>;
}

/**
 * Resolve the source (previous provider) and target (current provider)
 * connection URLs for a staged database provider migration. The apply flow
 * records the old database under previousProvider/previousBindings on the
 * postgres component when the new one is created.
 */
export async function resolveManagedMoveTargets(params: {
  project: Project;
  environment: Environment;
  sourceConnectionUrl?: string;
  targetConnectionUrl?: string;
}): Promise<
  | { ok: true; sourceUrl: string; targetUrl: string; sourceProvider?: string; targetProvider?: string }
  | ManagedMoveFailure
> {
  const component = componentRepo.findByEnvironmentAndType(params.environment.id, 'postgres');
  const bindings = component?.bindings as Record<string, unknown> | undefined;
  const targetProvider = typeof bindings?.provider === 'string' ? bindings.provider : undefined;
  const previousProvider = typeof bindings?.previousProvider === 'string' ? bindings.previousProvider : undefined;
  const previousBindings = bindings?.previousBindings && typeof bindings.previousBindings === 'object'
    ? bindings.previousBindings as Record<string, unknown>
    : undefined;

  // Target: the CURRENT database (where data lands). Must be reachable from
  // this machine — Railway components store internal template refs, so
  // resolve the external (TCP proxy) URL.
  let targetUrl = params.targetConnectionUrl;
  if (!targetUrl && component) {
    targetUrl = await resolveExternalDatabaseUrl(params.project, params.environment) ?? undefined;
  }
  if (!targetUrl) {
    return {
      ok: false,
      code: component ? 'no_target' : 'no_component',
      error: component
        ? 'Could not resolve the target (current) database connection URL from the component bindings.'
        : `No postgres component is tracked for ${params.environment.name}. Run hv_plan/hv_apply to create the new database first.`,
      hint: 'The move copies INTO the environment\'s current database. Apply the plan that creates the new database, then re-run the move.',
    };
  }

  // Source: the PREVIOUS provider's database (where data comes from).
  let sourceUrl = params.sourceConnectionUrl;
  if (!sourceUrl && previousBindings) {
    sourceUrl = connectionUrlFromBindings(previousBindings);
    if (!sourceUrl && previousProvider) {
      const adapterResult = await adapterFactory.getDatabaseAdapter(previousProvider, params.project);
      if (adapterResult.success && adapterResult.adapter) {
        const syntheticComponent = {
          ...(component as Component),
          bindings: previousBindings,
          externalId: typeof bindings?.previousExternalId === 'string' ? bindings.previousExternalId : null,
        };
        sourceUrl = await adapterResult.adapter.getConnectionUrl(syntheticComponent) ?? undefined;
      }
    }
  }
  if (!sourceUrl) {
    return {
      ok: false,
      code: 'no_source',
      error: previousProvider
        ? `Could not resolve the previous ${previousProvider} database connection URL from the recorded bindings.`
        : 'No previous database is recorded for this environment (the component has no previousProvider bindings).',
      hint: 'The source is recorded automatically when hv_apply creates the replacement database during a provider change. Pass sourceConnectionUrl explicitly if the old database is not tracked — chat-safe refs are supported: sourceConnectionUrl=\"dotenv:/absolute/path/.env#OLD_DATABASE_URL\".',
    };
  }

  if (sourceUrl === targetUrl) {
    return {
      ok: false,
      code: 'same_database',
      error: 'Source and target resolve to the same database; nothing to move.',
    };
  }

  return { ok: true, sourceUrl, targetUrl, sourceProvider: previousProvider, targetProvider };
}

/**
 * Managed snapshot copy for a staged database provider migration:
 * pg_dump | pg_restore from the previous provider's database into the
 * current one, then exact-count verification on the largest tables.
 * Writes made to the source after the dump starts are NOT copied —
 * freeze writes or re-run the move before cutover.
 */
export async function executeManagedDatabaseMove(params: {
  project: Project;
  environment: Environment;
  sourceConnectionUrl?: string;
  targetConnectionUrl?: string;
  criticalTables?: string[];
}): Promise<ManagedMoveSuccess | ManagedMoveFailure> {
  for (const command of ['pg_dump', 'pg_restore'] as const) {
    if (!hasCommand(command)) {
      return {
        ok: false,
        code: 'tooling',
        error: `${command} is not available on this machine.`,
        hint: 'Install the PostgreSQL client tools (macOS: brew install libpq && brew link --force libpq) and retry.',
      };
    }
  }

  const resolved = await resolveManagedMoveTargets(params);
  if (!resolved.ok) {
    return resolved;
  }

  const copy = await copyPostgresDatabase(resolved.sourceUrl, resolved.targetUrl);
  if (!copy.success) {
    return {
      ok: false,
      code: 'copy_failed',
      error: copy.error ?? 'pg_dump/pg_restore failed',
      hint: 'Check network access to both databases from this machine. Supabase requires the direct (non-pooler) connection string for pg_dump.',
    };
  }

  const verification = await getExactCountVerification(resolved.sourceUrl, resolved.targetUrl, params.criticalTables);
  return {
    ok: true,
    sourceProvider: resolved.sourceProvider,
    targetProvider: resolved.targetProvider,
    verification,
  };
}

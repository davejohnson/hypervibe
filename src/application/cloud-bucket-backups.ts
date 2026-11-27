import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import { cloudEngines } from './cloud-engines.js';

export function dailyBucketNames(environment: EnvironmentSpec): string[] {
  return Object.entries(environment.storage ?? {}).filter(([, bucket]) => bucket.automatedBackups).map(([name]) => name).sort();
}

/** Report retained copies even if another daily backup is overdue. */
export async function readCloudBucketBackup(project: Project, environment: Environment, spec: EnvironmentSpec, storageName: string) {
  if (!spec.storage?.[storageName]?.automatedBackups || environment.projectId !== project.id) return;
  const cloud = cloudEngines.find(engine => engine.hostingProvider === spec.hosting.provider);
  const proof = await cloud?.observeBucketBackup?.(project, environment, spec, storageName).catch(() => undefined);
  if (!proof?.source || !proof.archive || proof.source === proof.archive) return;
  const age = Date.now() - Date.parse(proof.latestAt);
  if (!Number.isFinite(age) || age < 0) return;
  return { ...proof, current: age <= 24 * 60 * 60 * 1000 };
}

export async function observeCloudBucketBackup(project: Project, environment: Environment, spec: EnvironmentSpec, storageName: string) {
  const point = await readCloudBucketBackup(project, environment, spec, storageName);
  if (point?.current) return { source: point.source, archive: point.archive, latestAt: point.latestAt,
    ...(point.startedAt && { startedAt: point.startedAt }) };
}

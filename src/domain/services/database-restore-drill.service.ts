import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Project } from '../entities/project.entity.js';
import type { DatabaseRestoreDrillFile } from '../ports/database-restore-drill.port.js';
import { providerRegistry } from '../registry/provider.registry.js';
import type { ProjectSpec } from '../spec/spec.schema.js';

export interface DatabaseRestoreDrillCompileIssue {
  code:
    | 'database_restore_drill_unsupported'
    | 'database_restore_drill_binding_missing'
    | 'database_restore_drill_identity_invalid';
  environmentName: string;
  message: string;
}

export interface DatabaseRestoreDrillCompileResult {
  files: DatabaseRestoreDrillFile[];
  requiredSecrets: string[];
  issues: DatabaseRestoreDrillCompileIssue[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function compileDatabaseRestoreDrillFiles(params: {
  project: Project;
  spec: ProjectSpec;
  environmentRepo?: EnvironmentRepository;
  componentRepo?: ComponentRepository;
}): DatabaseRestoreDrillCompileResult {
  const environmentRepo = params.environmentRepo ?? new EnvironmentRepository();
  const componentRepo = params.componentRepo ?? new ComponentRepository();
  const files = new Map<string, DatabaseRestoreDrillFile>();
  const requiredSecrets = new Set<string>();
  const issues: DatabaseRestoreDrillCompileIssue[] = [];

  for (const [environmentName, environmentSpec] of Object.entries(params.spec.environments).sort(([a], [b]) => a.localeCompare(b))) {
    const database = environmentSpec.database;
    const drill = database?.resilience?.restoreDrill;
    if (!database || !drill) continue;

    const compiler = providerRegistry.getMetadata(database.provider)
      ?.orchestration?.databaseRestoreDrill;
    if (!compiler) {
      issues.push({
        code: 'database_restore_drill_unsupported',
        environmentName,
        message: `${database.provider} does not compile managed database restore drills.`,
      });
      continue;
    }

    const environment = environmentRepo.findByProjectAndName(params.project.id, environmentName);
    const component = environment
      ? componentRepo.findByEnvironmentAndType(environment.id, database.engine)
      : null;
    const bindings = asRecord(component?.bindings);
    const boundProvider = stringField(bindings, 'provider');
    const sourceInstanceId = component?.externalId ?? stringField(bindings, 'instanceId');
    const sourceConnectionName = stringField(bindings, 'connectionName');
    const sourceDatabaseName = stringField(bindings, 'database');
    if (
      !environment
      || !component
      || boundProvider !== database.provider
      || !sourceInstanceId
      || !sourceConnectionName
      || !sourceDatabaseName
    ) {
      issues.push({
        code: 'database_restore_drill_binding_missing',
        environmentName,
        message: `The ${environmentName} restore drill requires a durably bound ${database.provider} primary with exact connection and database identities.`,
      });
      continue;
    }

    const connectionParts = sourceConnectionName.split(':');
    const [projectId, region, connectionInstanceId] = connectionParts;
    if (
      connectionParts.length !== 3
      || !projectId
      || !region
      || connectionInstanceId !== sourceInstanceId
    ) {
      issues.push({
        code: 'database_restore_drill_identity_invalid',
        environmentName,
        message: `The bound connection name for ${environmentName} does not identify the reviewed primary ${sourceInstanceId}.`,
      });
      continue;
    }

    const workflow = compiler.buildWorkflow({
      environmentName,
      projectId,
      region,
      sourceInstanceId,
      sourceConnectionName,
      databaseName: sourceDatabaseName,
      schedule: drill.schedule,
      credentialsSecretName: drill.credentialsSecret,
      verificationQuery: drill.verificationQuery,
      restoreLagMinutes: drill.restoreLagMinutes,
      retainFailedInstanceDays: drill.retainFailedInstanceDays,
    });
    for (const file of workflow.files) {
      const existing = files.get(file.path);
      if (existing && existing.content !== file.content) {
        issues.push({
          code: 'database_restore_drill_identity_invalid',
          environmentName,
          message: `Multiple restore drills compiled conflicting content for ${file.path}.`,
        });
        continue;
      }
      files.set(file.path, file);
    }
    for (const secret of workflow.requiredSecrets) requiredSecrets.add(secret);
  }

  return {
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    requiredSecrets: [...requiredSecrets].sort(),
    issues,
  };
}

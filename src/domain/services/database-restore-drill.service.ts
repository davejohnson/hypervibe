import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Project } from '../entities/project.entity.js';
import type { DatabaseRestoreDrillFile } from '../ports/database-restore-drill.port.js';
import { providerRegistry } from '../registry/provider.registry.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { recoverySourceIdentitySchema } from './recovery-source.js';

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
    if (
      !environment
      || environment.projectId !== params.project.id
      || environment.name !== environmentName
      || !component
      || component.environmentId !== environment.id
      || component.type !== database.engine
      || component.bindings.provider !== database.provider
    ) {
      issues.push({
        code: 'database_restore_drill_binding_missing',
        environmentName,
        message: `The ${environmentName} restore drill requires a durably bound ${database.provider} primary in the selected environment.`,
      });
      continue;
    }

    const resolved = compiler.resolveSource({ environment, component });
    if (resolved.status !== 'resolved') {
      issues.push({
        code: `database_restore_drill_${resolved.status}`,
        environmentName,
        message: resolved.message,
      });
      continue;
    }

    const source = recoverySourceIdentitySchema.safeParse(resolved.source);
    if (
      !source.success
      || source.data.provider !== database.provider
      || (component.externalId !== null && source.data.primaryExternalId !== component.externalId)
      || !resolved.databaseName.trim()
    ) {
      issues.push({
        code: 'database_restore_drill_identity_invalid',
        environmentName,
        message: `The ${environmentName} restore drill source resolver returned an invalid recovery identity.`,
      });
      continue;
    }

    const workflow = compiler.buildWorkflow({
      environmentName,
      source: source.data,
      databaseName: resolved.databaseName,
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

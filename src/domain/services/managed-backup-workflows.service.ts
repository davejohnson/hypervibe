import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Project } from '../entities/project.entity.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { adapterFactory } from './adapter.factory.js';
import { compileBackupWorkflow } from './backup-workflow.service.js';
import type { ManagedGitHubFile } from './github-infrastructure.service.js';
import { resolveManagedBackupTarget } from './managed-backup-target.service.js';

/** Compile recurring data operations only after their ordinary resource lifecycle has bound exact identities. */
export async function compileManagedBackupFiles(input: { project: Project; spec: ProjectSpec }) {
  const files: ManagedGitHubFile[] = [], issues: string[] = [];
  const requiredSecrets: Array<{ environment: string; names: string[] }> = [];
  const environments = new EnvironmentRepository(), components = new ComponentRepository();
  for (const [name, spec] of Object.entries(input.spec.environments).sort(([a], [b]) => a.localeCompare(b))) {
    if (spec.backups?.mode !== 'daily' || !spec.backups.runnerImage) continue;
    const environment = environments.findByProjectAndName(input.project.id, name);
    const resolved = await resolveManagedBackupTarget({ project: input.project, spec, environment,
      components: environment ? components.findByEnvironmentId(environment.id) : [], adapterFactory });
    if (resolved.state !== 'ready') { issues.push(...resolved.issues.map(issue => `${name}: ${issue}`)); continue; }
    files.push(...compileBackupWorkflow({ project: input.project.name, environment: name, contractHash: resolved.contractHash,
      runnerImage: resolved.target.runnerImage, providerCredentialNames: resolved.providerCredentialNames, contract: resolved.target }));
    requiredSecrets.push({ environment: name, names: resolved.providerCredentialNames });
  }
  return { files, issues, requiredSecrets };
}

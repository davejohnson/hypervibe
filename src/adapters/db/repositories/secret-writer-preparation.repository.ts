import { getDb } from '../sqlite.adapter.js';
import { ProjectRepository } from './project.repository.js';

/** Non-secret recovery state, atomically merged without replacing sibling policy. */
export class SecretWriterPreparationRepository {
  private readonly projects = new ProjectRepository();
  read(projectId: string, environment: string): unknown {
    const project = this.projects.findById(projectId);
    if (!project) throw new Error('Writer preparation project is unavailable.');
    const records = project.policies.secretWriterPreparation;
    if (records === undefined) return undefined;
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid writer preparation state.');
    return (records as Record<string, unknown>)[environment];
  }
  save(projectId: string, environment: string, expected: unknown, next: unknown): void {
    getDb().transaction(() => {
      const project = this.projects.findById(projectId);
      if (!project || JSON.stringify(this.read(projectId, environment)) !== JSON.stringify(expected)) {
        throw new Error('Writer preparation changed concurrently.');
      }
      this.projects.update(projectId, { policies: { ...project.policies,
        secretWriterPreparation: { ...(project.policies.secretWriterPreparation as Record<string, unknown> | undefined), [environment]: next } } });
    })();
  }
}

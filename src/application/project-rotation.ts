import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CommandRegistrar } from './commands.js';
import type { CommandContext } from './context.js';
import { commandSuccess, HvError, wrapCommandHandler } from './results.js';
import { RotationRepository, type RotationWorkflow } from '../adapters/db/repositories/rotation.repository.js';
import { SpecStore, type SpecResult } from '../domain/spec/spec.store.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import {
  applicableRotationConnections,
  buildProjectRotationAssessment,
} from '../domain/services/project-rotation.service.js';
import { canonicalizeJson } from '../lib/canonical-json.js';
import { normalizeGitRemoteIdentity } from '../lib/git-remote.js';

/** A prepared rotation workflow is not an infrastructure plan or mutation authority. */
function recordedSpec(store: SpecStore, project: Project): SpecResult {
  try {
    const result = store.getForInspection(project);
    if (result) return result;
  } catch {
    throw new HvError('VALIDATION', 'Rotation preparation requires recorded desired state matching the repository.', {
      hint: 'Review and record the intended spec before preparing a workflow. Inspection never adopts edits or changes infrastructure.',
    });
  }
  throw new HvError('VALIDATION', 'No recorded desired state is available for this rotation workflow.', {
    hint: 'Record the reviewed project spec first. An absent journal is not an empty credential inventory.',
  });
}

function snapshot(ctx: CommandContext, project: Project, spec: ProjectSpec) {
  const environments = ctx.repos.environments.findByProjectId(project.id);
  const connections = ctx.repos.connections.findAll();
  const candidates = applicableRotationConnections(spec, project, connections);
  const selected = new Set(candidates.map(connection => connection.id));
  // Internal stale-snapshot guard only. Neither ciphertext nor binding contents
  // are copied into the workflow record or the command result. No decryption.
  const scopeFingerprint = createHash('sha256').update(JSON.stringify(canonicalizeJson({
    project: { id: project.id, name: project.name, gitRemoteUrl: project.gitRemoteUrl },
    environments: environments.map(environment => ({ id: environment.id, name: environment.name,
      bindings: environment.platformBindings })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    connections: connections.filter(connection => selected.has(connection.id))
      .map(connection => ({ id: connection.id, provider: connection.provider, scope: connection.scope,
        status: connection.status, ciphertext: connection.credentialsEncrypted }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  }))).digest('hex');
  return { scopeFingerprint, recordedEnvironments: environments.map(({ name }) => ({ name })),
    connections: connections.filter(connection => selected.has(connection.id))
      .map(({ id, provider, scope, status }) => ({ id, provider, scope, status })) };
}

function assessment(project: Project, spec: ProjectSpec, revision: number,
  mode: 'incident' | 'routine', scope: Pick<RotationWorkflow, 'recordedEnvironments' | 'connections'>) {
  return buildProjectRotationAssessment({ project, spec, specRevision: revision, mode, ...scope });
}

export function registerProjectRotationCommands(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register('hv_rotation',
    'Prepare a project-wide credential rotation workflow. preview (default) reads recorded local intent; start saves an idempotent value-free inventory snapshot; status resumes it and detects changed local scope. mode=incident plans containment before recovery; routine plans overlapping replacement. Reports explicit issuer, live inventory, shared-consumer and verification blockers. This command does not issue, install, deploy, revoke or inspect private execution progress. Scoped database password execution is separately available through hv_spec, hv_plan scope=database-rotation and hv_apply for supported providers and verified prerequisites; currently Supabase under maintenance. Preparation never claims rotation completion.',
    {
      project: z.string().min(1).optional().describe('Project name or id; defaults to the current repository.'),
      action: z.enum(['preview', 'start', 'status']).optional().describe('Default preview. start writes only local workflow metadata; status is read-only.'),
      mode: z.enum(['incident', 'routine']).optional().describe('For preview/start, defaults to routine. Incident requires explicit review of revocation impact and destination trust; no outage is authorized by preparation.'),
      workflowId: z.string().uuid().optional().describe('For status only: exact workflow id belonging to the selected project; omitted selects its most recently prepared workflow.'),
    },
    wrapCommandHandler(async ({ project: projectRef, action = 'preview', mode, workflowId }) => {
      if ((action === 'status' && mode !== undefined) || (action !== 'status' && workflowId !== undefined)) {
        throw new HvError('VALIDATION', 'mode selects a new preview/start; workflowId selects a saved status. These modes cannot be combined.');
      }
      // An explicitly selected saved project permits historical inspection even
      // when the checkout is corrupt. It does not establish CURRENT repo scope.
      const historicalProject = action === 'status' && projectRef
        ? ctx.repos.projects.findById(projectRef) ?? ctx.repos.projects.findByName(projectRef) : null;
      const project = historicalProject ?? ctx.resolveProjectOrThrow({ project: projectRef, readOnly: true });
      const workflows = new RotationRepository();
      // Resolve exact saved ownership before reading another project's scope.
      let workflow: RotationWorkflow | undefined;
      if (action === 'status') {
        workflow = (workflowId ? workflows.getById(project.id, workflowId) : workflows.latest(project.id)) ?? undefined;
        if (!workflow) throw new HvError('NOT_FOUND', 'No matching rotation workflow exists for this project.', {
          hint: 'Use action="preview" to inspect the project or action="start" to save its workflow.',
        });
      }
      const store = new SpecStore();
      let localWorkflowWrites = 0;
      let scopeCheck: 'current' | 'changed' | 'unknown' = 'current';
      let report: ReturnType<typeof assessment>;
      if (workflow) {
        let original: ProjectSpec;
        try {
          const savedSpec = store.getRevision(project.id, workflow.specRevision);
          if (!savedSpec) throw new Error('Missing original revision');
          original = savedSpec;
        } catch {
          throw new HvError('VALIDATION', 'The original rotation workflow spec revision cannot be read. No replacement baseline was invented.');
        }
        report = assessment({ ...project, name: original.project, gitRemoteUrl: workflow.projectGitRemoteUrl },
          original, workflow.specRevision, workflow.mode, workflow);
        try {
          ctx.resolveProjectOrThrow({ project: project.id, readOnly: true });
          const current = recordedSpec(store, project);
          const scope = snapshot(ctx, project, current.spec);
          scopeCheck = current.revision === workflow.specRevision && scope.scopeFingerprint === workflow.scopeFingerprint ? 'current' : 'changed';
        } catch {
          // Failed current reads do not erase independently recorded history.
          scopeCheck = 'unknown';
        }
      } else {
        const current = recordedSpec(store, project);
        const scope = snapshot(ctx, project, current.spec);
        report = assessment(project, current.spec, current.revision, mode ?? 'routine', scope);
        if (action === 'start') {
          const remoteIdentity = project.gitRemoteUrl ? normalizeGitRemoteIdentity(project.gitRemoteUrl) : null;
          // Preserve URL parsing (including a non-default port) while stripping
          // userinfo/query material. Bare host:port/path parses as SCP syntax.
          const projectGitRemoteUrl = remoteIdentity ? `https://${remoteIdentity}` : undefined;
          const saved = workflows.prepare({ projectId: project.id, specRevision: current.revision,
            mode: mode ?? 'routine', ...(projectGitRemoteUrl ? { projectGitRemoteUrl } : {}), ...scope });
          workflow = saved.workflow;
          localWorkflowWrites = saved.created ? 1 : 0;
        }
      }
      const blocked = [
        ...(scopeCheck === 'unknown' ? [{ code: 'ROTATION_SCOPE_UNVERIFIED', message: 'Current local scope cannot be checked safely. This is the saved original inventory, not proof that current credentials or destinations match it.' }] : []),
        ...(scopeCheck === 'changed' ? [{ code: 'ROTATION_SCOPE_CHANGED', message: 'The recorded spec, credential selection or destination bindings changed after preparation. Review a fresh preview and start a new snapshot; the original remains available.' }] : []),
        ...report.blockers,
        { code: 'ROTATION_EXECUTION_UNSUPPORTED', message: 'This project-wide workflow prepares scope and stages; it does not execute or verify a credential campaign. Separate scoped database password actions exist through spec/plan/apply, but their prerequisites and progress are not inspected here. No campaign stage is accepted as completed.' },
      ];
      const result = {
        ...report,
        action,
        status: scopeCheck === 'changed' ? 'stale' : workflow ? 'blocked' : 'review_required',
        ...(workflow ? { workflow: { id: workflow.id, preparedAt: workflow.createdAt, specRevision: workflow.specRevision },
          snapshotCurrent: scopeCheck === 'current', scopeCheck } : {}),
        blocked,
        scopedExecution: { credential: 'database-password', command: 'hv_plan', scope: 'database-rotation',
          availability: 'provider-dependent', prerequisites: 'unchecked', progress: 'not-inspected' },
        mutationCounts: { providerWrites: 0, localWorkflowWrites, ciDispatches: 0 },
      };
      // Inventory projection never reads envVars values, credentials or secret
      // references. Do not treat ordinary config as redaction patterns: values
      // like "id" or "production" would corrupt this machine-readable contract.
      return commandSuccess(result, {
        hint: 'Review the inventory and blockers. Saved workflows are preparation records, not hv_apply plans. For a declared database password generation, hv_plan scope="database-rotation" evaluates separate issuer and consumer actions; currently Supabase requires verified maintenance and supported consumer destinations. This report does not inspect that execution. Rollout, application use and existing sessions require separate verification.',
        agentInstruction: { action: 'stop_and_report', message: 'Report incomplete coverage and unsupported stages. Do not claim keys rotated, bypass blockers with provider tools, or revoke shared credentials from project context alone.' },
      });
    }));
}

import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { canonicalJsonSha256 } from '../../../../lib/canonical-json.js';
import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import { projectIamAddress } from './gcp-setup.backend.js';

const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const archivePattern = /^hv-backup-[a-f0-9]{20}-[a-z][a-z0-9-]{0,31}$/;
const number = z.string().regex(/^[1-9]\d*$/);
const tag = 'bucket-backup-access-';
const grantType = 'google_project_iam_member';
export const backupStorageRole = 'roles/storage.objectUser';
const blankTitle = 'hv-file-backup-storage';
const blankDescription = 'Keep the application out of its separate daily file backup buckets.';
const condition = z.object({ title: z.string(), expression: z.string(), description: z.string().optional() }).strict();
export type BackupGrantCondition = z.infer<typeof condition>;
const scopeSchema = z.object({ projectId: z.string().regex(projectPattern), projectNumber: number, runtimeEmail: z.email(), runtimeUid: number,
  archive: z.string().regex(archivePattern), source: z.string().min(3), sourceCreated: z.iso.datetime() }).strict();
export type BackupAccessScope = z.infer<typeof scopeSchema>;
export interface BackupAccessReview { scope: BackupAccessScope; before?: BackupGrantCondition; after: BackupGrantCondition }
export const backupAccessAddress = (email: string) => projectIamAddress('serviceAccount:' + email, backupStorageRole);
export const isBackupAccessContribution = (id: string) => id.startsWith(tag);
const invalid = () => new Error('The application storage grant does not match the original managed Google project setup. Review that setup before changing backup access.');
const object = (raw: unknown): Record<string, any> | undefined => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, any> : undefined;

/** Report addresses and action kinds only. Native before/after, provider diagnostics and raw values can contain secrets. */
export function googleBackupPlanMismatch(raw: unknown, purpose: 'application storage permission' | 'daily backup resources') {
  const plan = object(raw);
  const describe = (rows: unknown) => {
    if (!Array.isArray(rows)) return 'unknown';
    const changed = rows.filter(row => !equal(row?.change?.actions, ['no-op']));
    if (!changed.length) return 'none';
    const entries = changed.slice(0, 18).map(row => {
      const address = typeof row?.address === 'string' && /^google_[a-z0-9_]+\.[a-zA-Z0-9_-]{1,128}$/.test(row.address) ? row.address : 'unrecognized address';
      const actions = Array.isArray(row?.change?.actions) && row.change.actions.every((a: unknown) => ['read','create','update','delete','forget'].includes(String(a)))
        ? row.change.actions.join('/') : 'unrecognized change';
      return address + ' (' + actions + ')';
    });
    if (changed.length > entries.length) entries.push(String(changed.length - entries.length) + ' more');
    return entries.join(', ');
  };
  return 'The native Google plan did not match the reviewed ' + purpose + '. Proposed changes: ' + describe(plan?.resource_changes)
    + '. Refreshed state differences: ' + describe(plan?.resource_drift ?? []) + '.';
}

export function backupAccessContribution(raw: BackupAccessScope) {
  const scope = scopeSchema.parse(raw);
  if (!scope.runtimeEmail.endsWith('@' + scope.projectId + '.iam.gserviceaccount.com') || scope.source === scope.archive) throw invalid();
  const id = tag + canonicalJsonSha256([scope.projectId, scope.runtimeEmail, scope.archive]).slice(0, 20);
  const configuration: EngineConfiguration = { files: { [id + '.tf.json']: { locals: { [id.replaceAll('-', '_')]: scope } } }, resources: {} };
  return { id, configuration };
}
export function backupAccessScopes(contributions: Record<string, EngineConfiguration>) {
  return Object.entries(contributions).filter(([id]) => isBackupAccessContribution(id)).map(([id, configuration]) => {
    const file = object(configuration.files[id + '.tf.json']);
    const scope = scopeSchema.parse(file?.locals?.[id.replaceAll('-', '_')]);
    if (!equal(backupAccessContribution(scope), { id, configuration })) throw invalid();
    return scope;
  });
}
const storageGuard = ' && (!(resource.type in ["storage.googleapis.com/Bucket", "storage.googleapis.com/Object", "storage.googleapis.com/Folder", "storage.googleapis.com/ManagedFolder"]) || (';
function clauses(archive: string) {
  const name = 'projects/_/buckets/' + archive;
  return storageGuard + 'resource.name != "' + name + '" && !resource.name.startsWith("' + name + '/")))';
}
export function restrictedBackupCondition(prior: BackupGrantCondition | undefined, archives: string[]): BackupGrantCondition {
  if (!archives.length || archives.some(name => !archivePattern.test(name))) throw invalid();
  const base = prior ?? { title: blankTitle, description: blankDescription, expression: 'true' };
  const expression = '(' + base.expression + ')' + [...new Set(archives)].sort().map(clauses).join('');
  if (expression.length > 12000) throw new Error('This Google Cloud application has reached the size limit for one storage access condition.');
  return { ...base, expression };
}
/** Transfer isolation and ordinary preparation may accept strictly narrower conditions. Only
 * these exact, repeated AND clauses can be stripped; a different expression is left intact. */
export function unpackBackupCondition(raw: unknown): { base?: BackupGrantCondition; archives: string[] } {
  const value = condition.safeParse(raw).data;
  if (!value) { if (raw !== undefined) throw invalid(); return { archives: [] }; }
  const marker = ')' + storageGuard;
  const split = value.expression.indexOf(marker);
  if (split < 0 || !value.expression.startsWith('(')) return { base: value, archives: [] };
  const body = value.expression.slice(1, split);
  const suffix = value.expression.slice(split + 1);
  const archives = [...suffix.matchAll(/\(resource\.name != "projects\/_\/buckets\/(hv-backup-[a-f0-9]{20}-[a-z][a-z0-9-]{0,31})"/g)].map(match => match[1]!);
  if (!archives.length || suffix !== [...new Set(archives)].sort().map(clauses).join('')) return { base: value, archives: [] };
  const base = { ...value, expression: body };
  return body === 'true' && base.title === blankTitle && base.description === blankDescription ? { archives } : { base, archives };
}

export function projectStorageDefinition(configuration: EngineConfiguration, email: string) {
  const address = backupAccessAddress(email);
  const resource = object(configuration.files['project-setup.tf.json'])?.resource?.[grantType]?.[address.split('.')[1]!];
  if (!configuration.resources[address] || !object(resource) || resource.member !== 'serviceAccount:' + email || resource.role !== backupStorageRole ||
      configuration.imports?.[address]) throw invalid();
  return resource as Record<string, any>;
}
export function storageDefinitionCondition(definition: Record<string, any>): BackupGrantCondition | undefined {
  if (definition.condition === undefined || equal(definition.condition, [])) return;
  return z.tuple([condition]).parse(definition.condition)[0];
}
export function composeBackupArchiveAccess(configuration: EngineConfiguration, scopes: BackupAccessScope[]) {
  if (!scopes.length) return;
  // Project contributions are reused on subsequent previews. Never change a retained contribution while composing one plan.
  configuration.files['project-setup.tf.json'] = structuredClone(configuration.files['project-setup.tf.json']);
  for (const runtime of new Set(scopes.map(scope => scope.runtimeEmail))) {
    const selected = scopes.filter(s => s.runtimeEmail === runtime);
    if (new Set(selected.map(s => [s.projectId,s.projectNumber,s.runtimeUid].join('/'))).size !== 1) throw invalid();
    const definition = projectStorageDefinition(configuration, runtime);
    if (definition.project !== selected[0]!.projectId) throw invalid();
    definition.condition = [restrictedBackupCondition(storageDefinitionCondition(definition), selected.map(s => s.archive))];
    definition.lifecycle = { create_before_destroy: true };
  }
}

export function matchesBackupAccessState(document: unknown, review: BackupAccessReview, when: 'before' | 'after') {
  return matchesManagedProjectStorage(document, review.scope.projectId, review.scope.runtimeEmail, review[when]);
}
export function matchesManagedProjectStorage(document: unknown, projectId: string, runtimeEmail: string, expected?: BackupGrantCondition) {
  const rows = object(document)?.values?.root_module?.resources;
  if (!Array.isArray(rows)) return false;
  const matches = rows.filter(row => row.address === backupAccessAddress(runtimeEmail));
  return matches.length === 1 && validRow(matches[0], runtimeEmail) && validValues(matches[0].values, projectId, runtimeEmail, expected);
}
/** Every later project setup producer must preserve the full composed condition, including when
 * a migration restriction changes a different part of the same project grant. */
export function preservesBackupAccess(raw: unknown, configuration: EngineConfiguration, scopes: BackupAccessScope[]) {
  const rows = object(raw)?.resource_changes;
  if (!Array.isArray(rows)) return false;
  return [...new Set(scopes.map(scope => scope.runtimeEmail))].every(runtime => {
    const expected = projectStorageDefinition(configuration, runtime);
    const found = rows.filter(row => row.address === backupAccessAddress(runtime));
    if (found.length !== 1) return false;
    const [row] = found;
    const value = row.change?.after;
    return row.mode === 'managed' && row.type === grantType && row.provider_name === 'registry.opentofu.org/hashicorp/google' &&
      !row.deposed && !row.deposed_key && !row.tainted && !row.previous_address && value?.project === expected.project &&
      value.member === expected.member && value.role === expected.role && equal(value.condition, expected.condition);
  });
}
function validRow(row: Record<string, any>, runtimeEmail: string) {
  return row.address === backupAccessAddress(runtimeEmail) && row.mode === 'managed' && row.type === grantType &&
    row.provider_name === 'registry.opentofu.org/hashicorp/google' && !row.module_address && row.index === undefined &&
    !row.previous_address && !row.tainted && !row.deposed && !row.deposed_key;
}
function validValues(raw: unknown, projectId: string, runtimeEmail: string, expected?: BackupGrantCondition) {
  const v = object(raw);
  return v?.project === projectId && v.member === 'serviceAccount:' + runtimeEmail && v.role === backupStorageRole &&
    equal(v.condition ?? [], expected ? [expected] : []) && Object.keys(v).every(key => ['id','project','member','role','etag','condition'].includes(key));
}
/** The pinned provider refreshes execution status when a migration job has run and the
 * repository timestamp when release artifacts change. Accept these reads only on already-owned
 * addresses, with the same native identity and an exact no-op in the executable plan. */
function harmlessProjectRefresh(plan: Record<string, any>, projectId: string, owned: ReadonlySet<string>) {
  const drift = plan.resource_drift ?? [];
  if (!Array.isArray(drift)) return false;
  const seen = new Set<string>();
  for (const row of drift) {
    if (!row || !owned.has(row.address) || seen.has(row.address) || row.mode !== 'managed' ||
        row.provider_name !== 'registry.opentofu.org/hashicorp/google' || row.deposed || row.deposed_key ||
        row.previous_address || row.tainted || row.index !== undefined || row.module_address) return false;
    seen.add(row.address);
    const change = row.change;
    const before = object(change?.before), after = object(change?.after);
    if (!before || !after || before.project !== projectId || !before.id || before.id !== after.id ||
        change.importing || change.forget || !equal(change.actions,['update'])) return false;
    const matches = plan.resource_changes.filter((r: any) => r.address === row.address);
    if (matches.length !== 1 || matches[0].mode !== row.mode || matches[0].provider_name !== row.provider_name ||
        matches[0].type !== row.type || !equal(matches[0].change?.actions,['no-op']) ||
        !equal(matches[0].change?.before,after) || !equal(matches[0].change?.after,after)) return false;
    const fields = new Set([...Object.keys(before), ...Object.keys(after)].filter(key => !equal(before[key], after[key])));
    if (!fields.size || !String(row.address).startsWith(row.type + '.')) return false;
    if (row.type === 'google_secret_manager_secret') {
      if (![...fields].every(key => ['annotations','version_aliases'].includes(key) &&
          [before[key],after[key]].every(value => value == null || equal(value,{})))) return false;
    } else if (row.type === 'google_artifact_registry_repository') {
      const resource = 'projects/' + projectId + '/locations/' + before.location + '/repositories/hypervibe';
      if (row.address !== 'google_artifact_registry_repository.release_images_' + String(before.location).replaceAll('-','_') ||
          before.repository_id !== 'hypervibe' || before.id !== resource || before.format !== 'DOCKER' ||
          !before.create_time || ![...fields].every(key => key === 'update_time')) return false;
    } else if (row.type === 'google_cloud_run_v2_job') {
      const hash = /^google_cloud_run_v2_job\.bucket_copy_([a-f0-9]{20})$/.exec(row.address)?.[1];
      const job = hash && 'hv-bucket-copy-' + hash;
      const outputs = new Set(['conditions','terminal_condition','execution_count','latest_created_execution','observed_generation','update_time','etag','reconciling']);
      if (!job || before.name !== job || before.id !== 'projects/' + projectId + '/locations/' + before.location + '/jobs/' + job ||
          !z.uuid().safeParse(before.uid).success || !before.create_time || before.delete_time || before.expire_time ||
          ![...fields].every(key => outputs.has(key)) || Number(after.execution_count) < Number(before.execution_count)) return false;
    } else return false;
  }
  return true;
}
export function verifyBackupAccessPlan(raw: unknown, review: BackupAccessReview, owned: ReadonlySet<string> = new Set()) {
  const v = object(raw);
  if (!v || v.errored || v.complete === false || !Array.isArray(v.resource_changes) || (v.deferred_changes?.length ?? 0) ||
      !harmlessProjectRefresh(v,review.scope.projectId,owned)) return false;
  const seen = new Set<string>();
  let replacement = false;
  for (const row of v.resource_changes) {
    const ch = row.change;
    if (!ch || seen.has(row.address) || ch.importing || ch.forget || row.deposed || row.deposed_key || row.tainted || row.previous_address) return false;
    seen.add(row.address);
    if (row.address !== backupAccessAddress(review.scope.runtimeEmail)) { if (!equal(ch.actions, ['no-op'])) return false; continue; }
    if (!validRow(row,review.scope.runtimeEmail) || !validValues(ch.before,review.scope.projectId,review.scope.runtimeEmail,review.before) ||
        !validValues(ch.after,review.scope.projectId,review.scope.runtimeEmail,review.after) ||
        !equal(ch.actions,['create','delete']) || row.action_reason !== 'replace_because_cannot_update' || !Array.isArray(ch.replace_paths) ||
        !ch.replace_paths.length || ch.replace_paths.some((path: any) => !Array.isArray(path) || path[0] !== 'condition') ||
        Object.keys(ch.after_unknown ?? {}).some(k => !['id','etag','condition'].includes(k)) ||
        ![undefined, '[]', '[{}]'].includes(JSON.stringify(ch.after_unknown?.condition))) return false;
    replacement = true;
  }
  return replacement;
}

import { parseDocument } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import type { PlanFieldDiff } from '../plan/plan.types.js';

const sections: Record<string, string> = {on: 'event triggers', permissions: 'permissions', concurrency: 'concurrency', env: 'workflow environment', defaults: 'defaults', name: 'display name', 'run-name': 'run display name'};
const jobSections: Record<string, string> = {steps: 'job steps', permissions: 'job permissions', needs: 'job dependencies', if: 'job conditions', 'runs-on': 'runner selection', strategy: 'job strategy', environment: 'deployment environment', env: 'job environment', uses: 'reusable workflows', with: 'workflow inputs', secrets: 'secret references'};

function describeWorkflow(before: string, after: string): string {
  // Never echo repository text, job IDs, commands or environment values.
  if (Math.max(before.length, after.length) > 512_000) return 'Workflow contents change';
  try {
    const documents = [before, after].map(bytes => parseDocument(bytes, {uniqueKeys: true}));
    if (documents.some(doc => doc.errors.length || doc.warnings.length)) return 'Workflow contents change; syntax could not be compared';
    const [left, right] = documents.map(doc => doc.toJS({maxAliasCount: 0}));
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return 'Workflow contents change';
    if (isDeepStrictEqual(left, right)) return 'Only YAML comments or formatting change';
    const changed = new Set<string>();
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (isDeepStrictEqual(left[key], right[key])) continue;
      if (key !== 'jobs') { changed.add(Object.hasOwn(sections, key) ? sections[key] : 'workflow settings'); continue; }
      const previous = left.jobs ?? {};
      const desired = right.jobs ?? {};
      for (const id of new Set([...Object.keys(previous), ...Object.keys(desired)])) {
        if (!previous[id] || !desired[id]) { changed.add('job membership'); continue; }
        for (const field of new Set([...Object.keys(previous[id]), ...Object.keys(desired[id])])) {
          if (!isDeepStrictEqual(previous[id][field], desired[id][field])) changed.add(Object.hasOwn(jobSections, field) ? jobSections[field] : 'job settings');
        }
      }
    }
    return 'Changes ' + [...changed].join(', ');
  } catch { return 'Workflow contents change; syntax could not be compared'; }
}

export function reviewGitHubFile(path: string, before: string | null | undefined, after: string | null): PlanFieldDiff {
  const field = 'file:' + path;
  if (before === undefined) return {field, from: 'unknown', to: 'Read the file before changing it'};
  if (after === null) return {field, from: 'Managed file', to: 'Remove the retired file'};
  if (before === null) return {field, from: 'Absent', to: 'Create the declared file'};
  const oldHeader = before.split('\n', 1)[0];
  const newHeader = oldHeader.replace(/\bhv_spec_set\b/, 'hv_spec');
  const onlyHeader = /Managed by Hypervibe/i.test(oldHeader) && oldHeader !== newHeader
    && newHeader + before.slice(oldHeader.length) === after;
  const summary = onlyHeader ? 'Update the generator header from hv_spec_set to hv_spec; behavior stays the same'
    : /^\.github\/workflows\/.+\.ya?ml$/.test(path) ? describeWorkflow(before, after) : 'Update file contents';
  return {field, from: 'Existing file', to: summary};
}

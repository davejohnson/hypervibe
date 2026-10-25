import type { PlanAction } from './plan.types.js';

/** Pure dependency ordering shared by local and hosted reconciliation. */
export function orderActions(actions: PlanAction[]): PlanAction[] {
  const byId = new Map<string, PlanAction>();
  for (const action of actions) {
    if (byId.has(action.id)) throw new Error(`Duplicate plan action id "${action.id}"`);
    byId.set(action.id, action);
  }
  const ordered: PlanAction[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (action: PlanAction) => {
    const mark = state.get(action.id);
    if (mark === 'done') return;
    if (mark === 'visiting') throw new Error(`Dependency cycle involving "${action.id}"`);
    state.set(action.id, 'visiting');
    for (const dependency of action.dependsOn ?? []) {
      const target = byId.get(dependency);
      if (!target) throw new Error(`Unknown dependency "${dependency}" referenced by action "${action.id}"`);
      visit(target);
    }
    state.set(action.id, 'done');
    ordered.push(action);
  };
  for (const action of actions) visit(action);
  return ordered;
}

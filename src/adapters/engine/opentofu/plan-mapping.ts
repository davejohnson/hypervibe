import {
  ENGINE_ACTION_TYPE,
  type EngineActionSegment,
  type EngineAddressOutcome,
  type EngineChangeAction,
  type EngineConfiguration,
  type EngineResourceChange,
} from '../../../domain/ports/infrastructure-engine.port.js';
import type { PlanAction, PlanFieldDiff } from '../../../domain/plan/plan.types.js';

interface RawResourceChange {
  address?: unknown;
  type?: unknown;
  mode?: unknown;
  change?: {
    actions?: unknown;
    before?: unknown;
    after?: unknown;
    after_unknown?: unknown;
    before_sensitive?: unknown;
    after_sensitive?: unknown;
    importing?: unknown;
  };
}

function classify(actions: unknown): EngineChangeAction | 'unsupported' {
  if (!Array.isArray(actions)) return 'unsupported';
  const key = actions.join(',');
  switch (key) {
    case 'no-op': return 'noop';
    case 'create': return 'create';
    case 'update': return 'update';
    case 'delete': return 'delete';
    case 'read': return 'read';
    case 'delete,create':
    case 'create,delete': return 'replace';
    // `forget` removes a resource from state without destroying it; it is an
    // ownership change that needs its own reviewed workflow.
    default: return 'unsupported';
  }
}

function containsSensitive(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(containsSensitive);
  if (value && typeof value === 'object') return Object.values(value).some(containsSensitive);
  return false;
}

function changedTopLevel(before: unknown, after: unknown, afterUnknown: unknown): string[] {
  const left = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
  const right = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>;
  const unknown = (afterUnknown && typeof afterUnknown === 'object' ? afterUnknown : {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys]
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]) || containsSensitive(unknown[key]))
    .sort();
}

export interface ParsedEnginePlan {
  changes: EngineResourceChange[];
  /** Addresses whose action Hypervibe cannot represent; any entry blocks the plan. */
  unsupported: string[];
}

export function parseEnginePlan(json: string): ParsedEnginePlan {
  const document = JSON.parse(json) as { resource_changes?: RawResourceChange[]; errored?: boolean };
  if (document.errored) throw new Error('OpenTofu reported an errored plan; it cannot be reviewed or applied.');
  const changes: EngineResourceChange[] = [];
  const unsupported: string[] = [];
  for (const raw of document.resource_changes ?? []) {
    if (typeof raw.address !== 'string' || typeof raw.type !== 'string') {
      throw new Error('OpenTofu plan contains a resource change without an address.');
    }
    const classified = classify(raw.change?.actions);
    // An import with no other change is adoption, not a no-op: state gains a resource.
    const action = raw.change?.importing && (classified === 'noop' || classified === 'update') ? 'import' : classified;
    if (action === 'unsupported') {
      unsupported.push(raw.address);
      continue;
    }
    if (raw.mode === 'data' || action === 'read') continue;
    changes.push({
      address: raw.address,
      type: raw.type,
      action,
      changedAttributes: action === 'noop'
        ? []
        : changedTopLevel(raw.change?.before, raw.change?.after, raw.change?.after_unknown),
      hasSensitiveValues: containsSensitive(raw.change?.before_sensitive) || containsSensitive(raw.change?.after_sensitive),
    });
  }
  return { changes, unsupported };
}

const ACTION_RANK: Record<EngineChangeAction, number> = { noop: 0, read: 0, update: 1, import: 2, create: 3, replace: 4, delete: 5 };

export interface EnginePlanTranslation {
  actions: PlanAction[];
  /** Human-readable reasons the plan must not be applied. */
  blockers: string[];
}

/**
 * Translates an engine plan into Hypervibe actions. Every engine change must
 * map to exactly one declared resource; anything unmapped or outside the
 * configuration's declared scope blocks the plan rather than being applied
 * silently.
 */
export function translateEnginePlan(params: {
  provider: string;
  parsed: ParsedEnginePlan;
  configuration: EngineConfiguration;
  segment: Omit<EngineActionSegment, 'addresses'>;
}): EnginePlanTranslation {
  const blockers = params.parsed.unsupported.map((address) =>
    `OpenTofu proposed an unsupported action for ${address}; Hypervibe will not apply it.`);
  const grouped = new Map<string, { changes: EngineResourceChange[] }>();
  for (const change of params.parsed.changes) {
    const mapping = params.configuration.resources[change.address];
    if (!mapping) {
      if (change.action !== 'noop') {
        blockers.push(`OpenTofu proposed ${change.action} for ${change.address}, which this plan does not manage.`);
      }
      continue;
    }
    const entry = grouped.get(mapping.actionId) ?? { changes: [] };
    entry.changes.push(change);
    grouped.set(mapping.actionId, entry);
  }

  const actions: PlanAction[] = [];
  for (const [actionId, { changes }] of grouped) {
    const mapping = params.configuration.resources[changes[0]!.address]!;
    const dominant = changes.reduce((best, change) =>
      ACTION_RANK[change.action] > ACTION_RANK[best.action] ? change : best);
    // Deleting one resource while creating its successor (a service becoming a worker pool) is a replacement.
    const succession = changes.some((change) => change.action === 'delete') && changes.some((change) => change.action === 'create');
    const type = succession ? ENGINE_ACTION_TYPE.replace : ENGINE_ACTION_TYPE[dominant.action as Exclude<EngineChangeAction, 'read'>];
    const destructive = changes.some((change) => change.action === 'delete' || change.action === 'replace');
    const adopting = changes.some((change) => change.action === 'import');
    // A database major-version change is irreversible and needs its own explicit approval.
    const majorUpgrade = changes.some((change) => change.action === 'update' && change.changedAttributes.includes('database_version'));
    // Field lists help review changes to existing resources; for creates and deletes they are noise.
    const diff: PlanFieldDiff[] = changes
      .filter((change) => change.action === 'update' || change.action === 'replace')
      .flatMap((change) => change.changedAttributes.map((field) => ({ field: `${change.type}.${field}` })));
    const mutating = changes.filter((change) => change.action !== 'noop').map((change) => change.address);
    actions.push({
      id: actionId,
      type,
      resource: { kind: mapping.kind, name: mapping.name, provider: params.provider },
      verified: true,
      reason: type === 'noop'
        ? 'OpenTofu reports no changes.'
        : `OpenTofu will ${changes.filter((c) => c.action !== 'noop').map((c) => c.action === 'import'
          ? `take over the existing ${c.address} (created by an interrupted earlier apply)` : `${c.action} ${c.address}`).join(', ')}.`,
      ...(diff.length ? { diff } : {}),
      ...(mapping.dataBearing && destructive ? { dataBearing: true } : {}),
      ...(mapping.billable && (dominant.action === 'create' || dominant.action === 'replace') ? { billable: true } : {}),
      // Replacing, deleting or adopting anything is never implied by approving the plan as a whole.
      ...(destructive || adopting || majorUpgrade ? { requiresConfirm: true } : {}),
      ...(type === 'noop' ? {} : {
        metadata: { engineSegment: { ...params.segment, addresses: mutating } satisfies EngineActionSegment, ...(adopting ? { engineAdopt: true } : {}), ...(majorUpgrade ? { engineMajorUpgrade: true } : {}) },
      }),
    });
  }
  return { actions: actions.sort((a, b) => a.id.localeCompare(b.id)), blockers };
}

/**
 * Interprets `tofu apply -json` events. Only an explicit completion proves
 * success; a started change without a terminal event is unknown and must be
 * observed before any retry.
 */
export function interpretApplyEvents(stdout: string, addresses: string[]): Record<string, EngineAddressOutcome> {
  const outcomes: Record<string, EngineAddressOutcome> = Object.fromEntries(addresses.map((a) => [a, 'not_started']));
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event: { type?: string; hook?: { resource?: { addr?: string } }; diagnostic?: { address?: string; severity?: string } };
    try { event = JSON.parse(line); } catch { continue; }
    const address = event.hook?.resource?.addr ?? event.diagnostic?.address;
    if (!address || !(address in outcomes)) continue;
    if (event.type === 'apply_start' && outcomes[address] === 'not_started') outcomes[address] = 'unknown';
    else if (event.type === 'apply_complete') outcomes[address] = 'succeeded';
    else if (event.type === 'apply_errored') outcomes[address] = 'failed';
    else if (event.type === 'diagnostic' && event.diagnostic?.severity === 'error' && outcomes[address] !== 'succeeded') {
      outcomes[address] = 'failed';
    }
  }
  return outcomes;
}

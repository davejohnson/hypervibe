import type { PlanReportAction } from '../domain/plan/plan-report.js';

export const lanes = ['Project setup', 'Identity and access', 'Public entry', 'App services', 'Data and storage', 'Outside services'] as const;
type Lane = typeof lanes[number];

export interface MapGroup {
  index: number;
  lane: Lane;
  title: string;
  icon: 'project' | 'api' | 'key' | 'identity' | 'storage' | 'database' | 'service';
  provider: string;
  actions: PlanReportAction[];
}

const providers: Record<string, string> = {
  gcp: 'Google Cloud', google: 'Google Cloud', cloudrun: 'Cloud Run', aws: 'AWS', azure: 'Azure',
  github: 'GitHub', railway: 'Railway', cloudflare: 'Cloudflare', stripe: 'Stripe', sendgrid: 'SendGrid',
};

const googleApis: Record<string, string> = {
  artifactregistry: 'Artifact Registry', cloudbuild: 'Cloud Build', cloudresourcemanager: 'Resource Manager',
  cloudscheduler: 'Cloud Scheduler', compute: 'Compute Engine', iam: 'Identity and Access Management',
  iamcredentials: 'Service Account Credentials', logging: 'Cloud Logging', monitoring: 'Cloud Monitoring',
  run: 'Cloud Run', secretmanager: 'Secret Manager', serviceusage: 'Service Usage', sqladmin: 'Cloud SQL Admin', cloudsql: 'Cloud SQL',
  storage: 'Cloud Storage', workflows: 'Workflows',
};

export const namedResourceKinds = new Set(['service', 'database', 'cache', 'volume', 'domain', 'queue']);

export function humanize(value: string): string {
  const words = value.trim().replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function providerName(value: string): string {
  return Object.hasOwn(providers, value) ? providers[value] : humanize(value);
}

export function actionTitle(action: PlanReportAction): string {
  const api = /^Enable ([a-z0-9-]+)\.googleapis\.com$/i.exec(action.name);
  if (api) return `${Object.hasOwn(googleApis, api[1]) ? googleApis[api[1]] : humanize(api[1])} API`;
  // The full grant (principal, role and target) stays in the action detail.
  const role = /^serviceAccount:\S+ roles\/(\w+)\.([\w.]+)(?: on \S+)?$/.exec(action.name);
  if (!role) return action.name;
  const product = Object.hasOwn(googleApis, role[1]) ? googleApis[role[1]] : humanize(role[1]);
  return `${product} · ${humanize(role[2])}`;
}

type GroupDescription = Pick<MapGroup, 'lane' | 'title' | 'icon'>;

function describe(action: PlanReportAction): GroupDescription {
  // Project setup maps many distinct provider resources to the same 'project'
  // kind. Use the recorded engine address to distinguish APIs and grant scopes.
  const resources = [action.id, ...action.addresses].join(' ');
  const setup = (title: string, icon: MapGroup['icon']): GroupDescription => ({ lane: lanes[0], title, icon });
  const access = (title: string, icon: MapGroup['icon']): GroupDescription => ({ lane: lanes[1], title, icon });
  const store = (title: string, icon: MapGroup['icon']): GroupDescription => ({ lane: 'Data and storage', title, icon });
  const app = (title: string): GroupDescription => ({ lane: 'App services', title, icon: 'service' });
  if (/\bgoogle_project_service[.:]/.test(resources)) return setup('Cloud APIs', 'api');
  if (/\bgoogle_(?:project_service_identity|service_account)[.:]/.test(resources)) return access('Service accounts', 'identity');
  if (/\bgoogle_project_iam_(member|binding|policy)[.:]/.test(resources)) return access('Project permissions', 'key');
  if (/\bgoogle_service_account_iam_(member|binding|policy)[.:]/.test(resources)) return access('Service account permissions', 'key');
  if (/\bgoogle_storage_bucket_iam_(member|binding|policy)[.:]/.test(resources)) return access('Bucket permissions', 'key');
  if (/\bgoogle_artifact_registry_repository[.:]/.test(resources)) return store('Artifact Registry', 'storage');
  switch (action.kind) {
    case 'project': return setup('Cloud project', 'project');
    case 'environment': return setup('Environment', 'project');
    case 'secret': return access('Secrets', 'key');
    case 'database': return store('Databases', 'database');
    case 'cache': return store('Caches', 'database');
    case 'storage': return store('Storage', 'storage');
    case 'volume': return store('Volumes', 'storage');
    case 'queue': return store('Queues', 'storage');
    case 'service': return app('App services');
    case 'domain': return { lane: 'Public entry', title: 'Domains', icon: 'service' };
    case 'email': case 'payment': return { lane: 'Outside services', title: humanize(action.kind), icon: 'service' };
    case 'repo': return setup('Repositories', 'project');
    case 'ci': return app('Build and release');
    default: return app(humanize(action.kind));
  }
}

export function buildReportMap(actions: PlanReportAction[]) {
  const groups: MapGroup[] = [];
  const byCategory = new Map<string, MapGroup>();
  const groupByAction = new Map<PlanReportAction, MapGroup>();
  const groupById = new Map<string, MapGroup | null>();
  for (const action of actions) {
    const description = describe(action);
    // Keep named app resources distinct, so connections such as web → database
    // are visible. The many APIs and IAM grants of project setup stay grouped.
    const name = namedResourceKinds.has(action.kind) ? action.name : '';
    const category = JSON.stringify([action.provider, description.lane, description.title, name]);
    let group = byCategory.get(category);
    if (!group) {
      group = { ...description, index: groups.length, provider: action.provider, actions: [] };
      groups.push(group);
      byCategory.set(category, group);
    }
    group.actions.push(action);
    groupByAction.set(action, group);
    groupById.set(action.id, groupById.has(action.id) ? null : group);
  }
  // Wires represent only dependencies between actions in different groups.
  // The review list retains same-group and unresolved dependency IDs verbatim.
  const edges = new Map<string, { from: number; to: number }>();
  for (const group of groups) {
    for (const action of group.actions) {
      for (const id of action.dependsOn) {
        const prerequisite = groupById.get(id);
        if (prerequisite && prerequisite !== group) {
          edges.set(`${prerequisite.index}-${group.index}`, { from: prerequisite.index, to: group.index });
        }
      }
    }
  }
  return { groups, groupByAction, edges: [...edges.values()] };
}

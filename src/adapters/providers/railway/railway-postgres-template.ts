import { gql, type GraphQLClient } from 'graphql-request';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Images whose PostgreSQL startup/data-directory contract has been reviewed. */
export function isRailwayPostgresImage(image: unknown): image is string {
  return typeof image === 'string'
    && /^(?:(?:(?:docker\.io\/)?library\/|docker\.io\/)?postgres|ghcr\.io\/railwayapp-templates\/postgres-ssl)(?::|@|$)/.test(image.trim());
}

/** Public template metadata; never contains a generated credential. Preserve
 * the raw config, as Railway's official CLI does, including generators,
 * sealing, volume settings, icon and HA metadata. The GraphQL scalar is opaque;
 * its nested contract is separately recorded in provider-contracts/railway. */
export async function railwayPostgresTemplate(client: GraphQLClient) {
  const response = await client.request<{ template: unknown }>(gql`
    query PostgresTemplate($code: String!) {
      template(code: $code) { id code serializedConfig }
    }
  `, { code: 'postgres' });
  const template = response.template;
  if (!record(template) || !identity(template.id) || template.code !== 'postgres'
    || !record(template.serializedConfig) || !record(template.serializedConfig.services)) {
    throw new Error('Railway returned incomplete official PostgreSQL template metadata.');
  }
  const serializedConfig = structuredClone(template.serializedConfig);
  if (Object.keys(serializedConfig).some(key => key !== 'services')) {
    throw new Error('The PostgreSQL template declares resources outside the reviewed database action.');
  }
  const entries = Object.entries(serializedConfig.services as Record<string, unknown>);
  if (entries.length !== 1) throw new Error('The PostgreSQL template must contain exactly one database service.');
  const [serviceKey, service] = entries[0];
  if (!identity(serviceKey) || !record(service) || !identity(service.name)
    || !record(service.source) || !identity(service.source.image)
    || !/^ghcr\.io\/railwayapp-templates\/postgres-ssl:[0-9]+(?:\.[0-9]+)*$/.test(service.source.image)
    || !record(service.variables) || !record(service.volumeMounts) || !record(service.deploy)) {
    throw new Error('The official PostgreSQL template has an unsupported service or storage configuration.');
  }
  const mounts = Object.values(service.volumeMounts);
  if (mounts.length !== 1 || !record(mounts[0]) || !identity(mounts[0].mountPath)) {
    throw new Error('The official PostgreSQL template must declare one persistent data volume.');
  }
  const mountPath = mounts[0].mountPath;
  const defaults: Record<string, string> = {};
  for (const [name, variable] of Object.entries(service.variables)) {
    if (!record(variable)) throw new Error('The PostgreSQL template has malformed variable metadata.');
    // No user override is supplied in this flow. The official CLI selects the
    // published default and overwrites any pre-existing serialized `value`.
    const value = variable.defaultValue;
    if (value === undefined || value === null) {
      if (variable.isOptional === true) continue;
      throw new Error('The PostgreSQL template requires an input that Hypervibe cannot infer.');
    }
    if (typeof value !== 'string') throw new Error('The PostgreSQL template has malformed variable defaults.');
    // This is the official CLI's preparation step, not interpolation.
    variable.value = value;
    defaults[name] = value;
  }
  const pgdata = defaults.PGDATA;
  if (!mountPath.startsWith('/') || mountPath.split('/').some(part => part === '..' || part === '.')
    || service.deploy.requiredMountPath !== mountPath || !pgdata
    || pgdata.split('/').some(part => part === '..' || part === '.')
    || !(pgdata === mountPath || pgdata.startsWith(`${mountPath.replace(/\/$/, '')}/`))) {
    throw new Error('The official PostgreSQL template does not put PGDATA inside its required persistent volume.');
  }
  const componentUrl = (value: string) => /^postgres(?:ql)?:\/\/<(?:PGUSER|POSTGRES_USER)>:<(?:POSTGRES_PASSWORD|PGPASSWORD)>@<(?:RAILWAY_PRIVATE_DOMAIN|PGHOST)>:(?:5432|<PGPORT>)\/<(?:PGDATABASE|POSTGRES_DB)>$/.test(
    value.replace(/\$\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g, '<$1>')
  );
  if (!/^\$\{\{\s*POSTGRES_PASSWORD\s*\}\}$/.test(defaults.PGPASSWORD ?? '')
    || !/\$\{\{\s*secret\(/.test(defaults.POSTGRES_PASSWORD ?? '')
    || !defaults.DATABASE_URL || !componentUrl(defaults.DATABASE_URL)
    || ['DIRECT_URL', 'DATABASE_PRIVATE_URL'].some(key => defaults[key] !== undefined && !componentUrl(defaults[key]))) {
    throw new Error('The PostgreSQL template must retain provider-generated credentials and reference-based aliases.');
  }
  const directUrlVariable = selectRailwayDatabaseDirectUrlVariable(defaults);
  if (!directUrlVariable) throw new Error('The PostgreSQL template has an unusable URL variable.');
  return {
    templateId: template.id,
    serviceKey,
    name: service.name,
    image: service.source.image,
    mountPath,
    directUrlVariable,
    referenceDefinitions: Object.fromEntries(Object.entries(defaults)
      .filter(([key, value]) => key !== 'POSTGRES_PASSWORD' && value.includes('${{'))),
    serializedConfig,
  };
}

export interface RailwayTemplateService {
  id: string;
  name: string;
  templateId: string | null;
  templateServiceId: string | null;
}

/** Complete pre/post identity inventory; same names are never ownership proof. */
export async function railwayTemplateServices(client: GraphQLClient, projectId: string): Promise<RailwayTemplateService[]> {
  const services: RailwayTemplateService[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 100; page++) {
    const response: { project: unknown } = await client.request(gql`
      query DatabaseTemplateServices($projectId: String!, $after: String) {
        project(id: $projectId) {
          id
          services(first: 100, after: $after) {
            edges { node { id name templateId templateServiceId } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `, { projectId, after });
    const project = response.project;
    if (!record(project) || project.id !== projectId || !record(project.services)
      || !Array.isArray(project.services.edges) || !record(project.services.pageInfo)
      || typeof project.services.pageInfo.hasNextPage !== 'boolean') {
      throw new Error('Railway database template service inventory is incomplete.');
    }
    for (const edge of project.services.edges) {
      const node = record(edge) ? edge.node : undefined;
      if (!record(node) || !identity(node.id) || !identity(node.name) || ids.has(node.id)
        || !(node.templateId === null || identity(node.templateId))
        || !(node.templateServiceId === null || identity(node.templateServiceId))) {
        throw new Error('Railway database template inventory has an incomplete or duplicate identity.');
      }
      ids.add(node.id);
      services.push({ id: node.id, name: node.name, templateId: node.templateId, templateServiceId: node.templateServiceId });
    }
    if (!project.services.pageInfo.hasNextPage) return services;
    const cursor = project.services.pageInfo.endCursor;
    if (!identity(cursor) || cursors.has(cursor)) throw new Error('Railway database template inventory cannot be completely paginated.');
    cursors.add(cursor);
    after = cursor;
  }
  throw new Error('Railway database template inventory exceeded its bounded page limit.');
}

/** Select only a provider-observed key; an unusable present alias is unknown. */
export function selectRailwayDatabaseDirectUrlVariable(
  variables: Record<string, string>
): 'DIRECT_URL' | 'DATABASE_PRIVATE_URL' | 'DATABASE_URL' | undefined {
  if (!variables.DATABASE_URL?.trim()) return undefined;
  const direct = Object.prototype.hasOwnProperty.call(variables, 'DIRECT_URL')
    ? 'DIRECT_URL'
    : Object.prototype.hasOwnProperty.call(variables, 'DATABASE_PRIVATE_URL')
      ? 'DATABASE_PRIVATE_URL' : 'DATABASE_URL';
  return variables[direct]?.trim() ? direct : undefined;
}

export function railwayDatabaseReferences(name: string, directUrlVariable: unknown): Record<string, string> {
  if (!name.trim() || name !== name.trim() || /[${}\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('The Railway database service name cannot be used safely in a variable reference.');
  }
  if (directUrlVariable !== undefined && (typeof directUrlVariable !== 'string'
    || !['DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DIRECT_URL'].includes(directUrlVariable))) {
    throw new Error('The recorded Railway database URL variable is invalid; review its binding before runtime wiring.');
  }
  const direct = directUrlVariable ?? 'DATABASE_PRIVATE_URL';
  return { DATABASE_URL: '${{' + name + '.DATABASE_URL}}', DIRECT_URL: '${{' + name + '.' + direct + '}}' };
}

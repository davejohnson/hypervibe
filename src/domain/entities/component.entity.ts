export type ComponentType = 'postgres' | 'redis' | 'mysql' | 'mongodb' | string;

export interface ComponentBindings {
  connectionString?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  [key: string]: unknown;
}

export interface Component {
  id: string;
  environmentId: string;
  type: ComponentType;
  bindings: ComponentBindings;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateComponentInput {
  environmentId: string;
  type: ComponentType;
  bindings?: ComponentBindings;
  externalId?: string;
}

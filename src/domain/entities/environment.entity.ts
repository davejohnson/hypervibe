export interface Environment {
  id: string;
  projectId: string;
  name: string;
  platformBindings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEnvironmentInput {
  projectId: string;
  name: string;
  platformBindings?: Record<string, unknown>;
}

export type EnvironmentName = 'local' | 'staging' | 'production' | string;

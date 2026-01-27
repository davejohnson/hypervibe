export interface Project {
  id: string;
  name: string;
  defaultPlatform: string;
  policies: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectInput {
  name: string;
  defaultPlatform?: string;
  policies?: Record<string, unknown>;
}

export type RunType = 'deploy' | 'migrate' | 'rollback' | string;
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunStep {
  name: string;
  action: string;
  target?: string;
  params?: Record<string, unknown>;
}

export interface RunPlan {
  steps: RunStep[];
  metadata?: Record<string, unknown>;
}

export interface RunReceipt {
  step: string;
  status: 'success' | 'failure' | 'skipped';
  result?: Record<string, unknown>;
  error?: string;
  timestamp: string;
}

export interface Run {
  id: string;
  projectId: string;
  environmentId: string;
  type: RunType;
  status: RunStatus;
  plan: RunPlan | Record<string, unknown>;
  receipts: RunReceipt[];
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface CreateRunInput {
  projectId: string;
  environmentId: string;
  type: RunType;
  plan?: RunPlan | Record<string, unknown>;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'consumed';

export interface Approval {
  id: string;
  projectId: string;
  environmentName: string;
  action: string;
  status: ApprovalStatus;
  requestedBy: string;
  approvedBy: string | null;
  rejectedBy: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateApprovalInput {
  projectId: string;
  environmentName: string;
  action: string;
  requestedBy?: string;
  reason?: string | null;
  payload?: Record<string, unknown>;
  expiresAt?: Date | null;
}

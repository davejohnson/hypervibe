export interface AuditEvent {
  id: string;
  timestamp: Date;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateAuditEventInput {
  actor?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details?: Record<string, unknown>;
}

export type AuditAction =
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'environment.created'
  | 'environment.updated'
  | 'environment.deleted'
  | 'service.created'
  | 'service.updated'
  | 'service.deleted'
  | 'connection.created'
  | 'connection.verified'
  | 'connection.failed'
  | 'deploy.started'
  | 'deploy.succeeded'
  | 'deploy.failed'
  | 'local.bootstrap'
  | 'integration.synced'
  | 'integration.keys_deleted';

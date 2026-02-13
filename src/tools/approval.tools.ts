import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApprovalRepository } from '../adapters/db/repositories/approval.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { resolveProject } from './resolve-project.js';

const approvalRepo = new ApprovalRepository();
const auditRepo = new AuditRepository();

const actionSchema = z.enum(['deploy', 'deploy.rollback', 'infra.apply']);

export function registerApprovalTools(server: McpServer): void {
  server.tool(
    'approval_request_create',
    'Create an approval request for a protected operation (deploy, rollback, infra apply).',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().describe('Environment name'),
      action: actionSchema.describe('Action requiring approval'),
      requestedBy: z.string().optional().describe('Requester identity (free-form)'),
      reason: z.string().optional().describe('Why this change is needed'),
      expiresInMinutes: z.number().optional().describe('Expiry from now (default: 120 minutes)'),
      payload: z.record(z.unknown()).optional().describe('Optional structured payload for audit/debug'),
    },
    async ({ projectName, environmentName, action, requestedBy, reason, expiresInMinutes = 120, payload }) => {
      const project = resolveProject({ projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const expiresAt = expiresInMinutes ? new Date(Date.now() + expiresInMinutes * 60_000) : null;
      const approval = approvalRepo.create({
        projectId: project.id,
        environmentName,
        action,
        requestedBy,
        reason: reason ?? null,
        payload: payload ?? {},
        expiresAt,
      });

      auditRepo.create({
        action: 'approval.requested',
        resourceType: 'approval',
        resourceId: approval.id,
        details: { projectId: project.id, environmentName, action, requestedBy, expiresAt: expiresAt?.toISOString() ?? null },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            approval,
            message: 'Approval request created. Use approval_request_approve to approve it.',
          }),
        }],
      };
    }
  );

  server.tool(
    'approval_request_list',
    'List approval requests (optionally filter to pending).',
    {
      projectName: z.string().optional().describe('Filter by project'),
      pendingOnly: z.boolean().optional().describe('Only show pending approvals (default: true)'),
      limit: z.number().optional().describe('Max results (default: 50)'),
    },
    async ({ projectName, pendingOnly = true, limit = 50 }) => {
      let approvals;
      if (projectName) {
        const project = resolveProject({ projectName });
        if (!project) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
            }],
          };
        }
        approvals = pendingOnly ? approvalRepo.findPending(project.id, limit) : approvalRepo.findByProject(project.id, limit);
      } else {
        approvals = pendingOnly ? approvalRepo.findPending(undefined, limit) : [];
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, count: approvals.length, approvals }),
        }],
      };
    }
  );

  server.tool(
    'approval_request_get',
    'Get an approval request by ID.',
    {
      approvalId: z.string().uuid().describe('Approval ID'),
    },
    async ({ approvalId }) => {
      const approval = approvalRepo.findById(approvalId);
      if (!approval) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Approval not found: ${approvalId}` }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, approval }),
        }],
      };
    }
  );

  server.tool(
    'approval_request_approve',
    'Approve a pending approval request.',
    {
      approvalId: z.string().uuid().describe('Approval ID'),
      approvedBy: z.string().describe('Approver identity (free-form)'),
    },
    async ({ approvalId, approvedBy }) => {
      const updated = approvalRepo.approve(approvalId, approvedBy);
      if (!updated) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Approval not found: ${approvalId}` }),
          }],
        };
      }

      auditRepo.create({
        action: 'approval.approved',
        resourceType: 'approval',
        resourceId: approvalId,
        details: { approvedBy },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, approval: updated }),
        }],
      };
    }
  );

  server.tool(
    'approval_request_reject',
    'Reject a pending approval request.',
    {
      approvalId: z.string().uuid().describe('Approval ID'),
      rejectedBy: z.string().describe('Rejector identity (free-form)'),
      reason: z.string().optional().describe('Reason'),
    },
    async ({ approvalId, rejectedBy, reason }) => {
      const updated = approvalRepo.reject(approvalId, rejectedBy, reason);
      if (!updated) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Approval not found: ${approvalId}` }),
          }],
        };
      }

      auditRepo.create({
        action: 'approval.rejected',
        resourceType: 'approval',
        resourceId: approvalId,
        details: { rejectedBy, reason: reason ?? null },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, approval: updated }),
        }],
      };
    }
  );
}


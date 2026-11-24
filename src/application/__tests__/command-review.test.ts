import { describe, expect, it } from 'vitest';
import { approvalGuidance } from '../command-review.js';

const planId = '6f1c2b1e-8f0a-4c56-9d55-0d1f3a6f6a10';

describe('where a saved plan can be approved', () => {
  it('offers chat and the review page for an ordinary plan, with the exact chat call', () => {
    const guidance = approvalGuidance('hv_plan', planId, { planId, confirmActions: ['database:postgres', 'service:old'] }, {}, false)!;
    expect(guidance.agentInstruction.action).toBe('ask_user');
    // The plan is shown in chat, not only linked.
    expect(guidance.agentInstruction.message).toContain('Show the user this plan in chat');
    expect(guidance.agentInstruction.message).toContain('They can approve in either place');
    expect(guidance.agentInstruction.message).toContain(`call hv_apply with planId ${planId} and confirmActions exactly ["database:postgres","service:old"].`);
    expect(guidance.agentInstruction.message).toContain(`call hv_apply with planId ${planId} and useBrowserApproval=true.`);
    expect(guidance.hint).toContain('in chat or on the review page');
  });

  it('needs no action ids in chat when nothing in the plan needs confirmation', () => {
    expect(approvalGuidance('hv_plan', planId, { planId, confirmActions: [] }, {}, false)!.agentInstruction.message).toContain(`call hv_apply with planId ${planId}. If they approve on the review page`);
  });

  it.each(['hv_launch', 'hv_migrate'])('offers both for %s', (command) => {
    const message = approvalGuidance(command, planId, { planId, confirmActions: ['database:postgres'] }, {}, false)!.agentInstruction.message;
    expect(message).toContain(`continue ${command} with planId ${planId} and confirmActions exactly ["database:postgres"].`);
    expect(message).toContain(`continue ${command} with planId ${planId}, omitting confirmActions.`);
  });

  it('continues without asking once the review page approval is recorded', () => {
    expect(approvalGuidance('hv_plan', planId, { planId, confirmActions: ['a'] }, {}, true)).toEqual({
      hint: `Call hv_apply with planId ${planId} and useBrowserApproval=true.`,
      agentInstruction: { action: 'continue', message: `The browser approval is recorded. Call hv_apply with planId ${planId} and useBrowserApproval=true.` },
    });
  });

  it('keeps Google Cloud setup and access checks on the review page only', () => {
    for (const id of ['setup-1b2c3d4e-0000-4000-8000-000000000000', 'probe-1b2c3d4e-0000-4000-8000-000000000000']) {
      const guidance = approvalGuidance('hv_connections', id, { planId: id, confirmActions: ['x'] }, { action: 'prepare' }, false)!;
      expect(guidance.agentInstruction.message).toMatch(/^Share the review link so the user can approve this plan in their browser\./);
      expect(guidance.agentInstruction.message).not.toContain('in chat');
      expect(guidance.hint).toMatch(/^After browser approval, /);
    }
    expect(approvalGuidance('hv_connections', 'setup-1b2c3d4e-0000-4000-8000-000000000000', {}, { action: 'bootstrap' }, false)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { toolSuccess, toolError, wrapHandler, HvError, type ToolEnvelope } from '../respond.js';

function parse(response: { content: Array<{ type: 'text'; text: string }> }): ToolEnvelope {
  return JSON.parse(response.content[0].text) as ToolEnvelope;
}

describe('toolSuccess', () => {
  it('wraps data in the envelope', () => {
    const body = parse(toolSuccess({ id: '1' }));
    expect(body).toEqual({ ok: true, data: { id: '1' } });
  });

  it('supports hint, warnings, and next', () => {
    const body = parse(toolSuccess({ id: '1' }, { hint: 'run hv_plan', warnings: ['w'], next: ['hv_plan'] }));
    expect(body.hint).toBe('run hv_plan');
    expect(body.warnings).toEqual(['w']);
    expect(body.next).toEqual(['hv_plan']);
  });

  it('omits empty fields', () => {
    const body = parse(toolSuccess(undefined, { warnings: [] }));
    expect(body).toEqual({ ok: true });
  });
});

describe('toolError', () => {
  it('returns a coded error', () => {
    const body = parse(toolError('NOT_FOUND', 'no such project', { hint: 'list projects with hv_spec_get' }));
    expect(body.ok).toBe(false);
    expect(body.error).toEqual({ code: 'NOT_FOUND', message: 'no such project' });
    expect(body.hint).toBe('list projects with hv_spec_get');
  });

  it('includes details when provided', () => {
    const body = parse(toolError('VALIDATION', 'bad input', { details: { field: 'domain' } }));
    expect(body.error?.details).toEqual({ field: 'domain' });
  });
});

describe('wrapHandler', () => {
  it('passes through successful responses', async () => {
    const handler = wrapHandler(async () => toolSuccess({ ok: true }));
    const body = parse(await handler({}));
    expect(body.ok).toBe(true);
  });

  it('converts HvError into its coded envelope', async () => {
    const handler = wrapHandler(async () => {
      throw new HvError('CONFIRM_REQUIRED', 'production needs confirm', { hint: 'retry with confirm: true' });
    });
    const body = parse(await handler({}));
    expect(body.error?.code).toBe('CONFIRM_REQUIRED');
    expect(body.hint).toBe('retry with confirm: true');
  });

  it('converts unknown errors into INTERNAL', async () => {
    const handler = wrapHandler(async () => {
      throw new Error('boom');
    });
    const body = parse(await handler({}));
    expect(body.error).toEqual({ code: 'INTERNAL', message: 'boom' });
  });
});

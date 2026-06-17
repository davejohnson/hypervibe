import { describe, expect, it } from 'vitest';
import { toolSuccess, toolError, wrapHandler, HvError, type ToolEnvelope } from '../respond.js';
import { parseToolEnvelope } from './tool-result.js';

function parse(response: { content: Array<{ type: 'text'; text: string }> }): ToolEnvelope {
  return parseToolEnvelope(response);
}

describe('toolSuccess', () => {
  it('wraps data in the envelope', () => {
    const response = toolSuccess({ id: '1' });
    const body = parse(response);
    expect(body).toEqual({ ok: true, data: { id: '1' } });
    expect(response.content[0].text).toContain('🟢 **Hypervibe OK**');
    expect(response.content[0].text).toContain('▸ **Id**: 1');
    expect(response.content[0].text.trim().startsWith('{')).toBe(false);
  });

  it('redacts sensitive fields and credential-looking strings', () => {
    const body = parse(toolSuccess({
      apiToken: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
      secretName: 'DATABASE_URL',
      nested: {
        connectionUrl: 'postgresql://postgres:secretpw@db.example.com:5432/app',
        message: 'failed for postgresql://postgres:secretpw@db.example.com:5432/app',
      },
    }));
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secretpw');
    expect(serialized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(body.data).toMatchObject({
      apiToken: '[redacted]',
      secretName: 'DATABASE_URL',
      nested: {
        connectionUrl: '[redacted]',
        message: 'failed for postgresql://[redacted]@db.example.com:5432/app',
      },
    });
  });

  it('supports hint, warnings, and next', () => {
    const body = parse(toolSuccess({ id: '1' }, { hint: 'run hv_plan', warnings: ['w'], next: ['hv_plan'] }));
    expect(body.hint).toBe('run hv_plan');
    expect(body.warnings).toEqual(['w']);
    expect(body.next).toEqual(['hv_plan']);
  });

  it('formats action ids with colons without corrupting markdown labels', () => {
    const response = toolSuccess({
      actions: [{
        id: 'service:web',
        type: 'create',
        resource: { kind: 'service', name: 'web', provider: 'railway' },
        reason: 'Missing',
      }],
    });
    expect(response.content[0].text).toContain('➕ `service:web` create on railway - Missing');
    expect(response.content[0].text).not.toContain('**➕ `service**');
  });

  it('omits empty fields', () => {
    const body = parse(toolSuccess(undefined, { warnings: [] }));
    expect(body).toEqual({ ok: true });
  });
});

describe('toolError', () => {
  it('returns a coded error', () => {
    const response = toolError('NOT_FOUND', 'no such project', { hint: 'list projects with hv_spec_get' });
    const body = parse(response);
    expect(body.ok).toBe(false);
    expect(body.error).toEqual({ code: 'NOT_FOUND', message: 'no such project' });
    expect(body.hint).toBe('list projects with hv_spec_get');
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('🔴 **NOT_FOUND**');
    expect(response.content[0].text).toContain('no such project');
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

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
    expect(response.content[0].text).toContain('🟢 Hypervibe OK');
    expect(response.content[0].text).toContain('▸ Id: 1');
    expect(response.content[0].text).not.toContain('**');
    expect(response.content[0].text.trim().startsWith('{')).toBe(false);
  });

  it('redacts sensitive fields and credential-looking strings', () => {
    const body = parse(toolSuccess({
      apiToken: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
      secretName: 'DATABASE_URL',
      nested: {
        connectionUrl: 'postgresql://postgres:secretpw@db.example.com:5432/app',
        message: 'failed for postgresql://postgres:secretpw@db.example.com:5432/app using sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
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
        message: 'failed for postgresql://[redacted]@db.example.com:5432/app using [redacted]',
      },
    });
  });

  it('supports hint, warnings, and next', () => {
    const body = parse(toolSuccess({ id: '1' }, { hint: 'run hv_plan', warnings: ['w'], next: ['hv_plan'] }));
    expect(body.hint).toBe('run hv_plan');
    expect(body.warnings).toEqual(['w']);
    expect(body.next).toEqual(['hv_plan']);
  });

  it('tells agents to stop when successful tool output contains failed receipts', () => {
    const response = toolSuccess({
      applied: false,
      receipts: [
        { actionId: 'service:web', status: 'succeeded' },
        { actionId: 'domain:example.com', status: 'failed', error: 'Missing Cloudflare connection' },
      ],
    });
    const body = parse(response);
    expect(body.agentInstruction).toMatchObject({
      action: 'stop_and_report',
    });
    expect(response.content[0].text).toContain('🛑 Agent Instruction');
    expect(response.content[0].text).toContain('Report which stage receipts succeeded');
  });

  it('tells agents to ask the user when output contains blockers', () => {
    const body = parse(toolSuccess({
      blocked: [{ provider: 'cloudflare', scope: 'example.com' }],
    }));
    expect(body.agentInstruction).toMatchObject({
      action: 'ask_user',
    });
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
    expect(response.content[0].text).not.toContain('**');
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
    expect(response.content[0].text).toContain('🔴 NOT_FOUND');
    expect(response.content[0].text).toContain('no such project');
    expect(response.content[0].text).not.toContain('**');
  });

  it('defaults missing connection errors to stop-and-ask guidance', () => {
    const response = toolError('MISSING_CONNECTION', 'No Cloudflare connection');
    const body = parse(response);
    expect(body.agentInstruction).toMatchObject({
      action: 'ask_user',
    });
    expect(response.content[0].text).toContain('ask the user for an exported token');
  });

  it('includes details when provided', () => {
    const body = parse(toolError('VALIDATION', 'bad input', { details: { field: 'domain' } }));
    expect(body.error?.details).toEqual({ field: 'domain' });
  });

  it('renders connection setup details as visible bullets instead of one long paragraph', () => {
    const response = toolError('NOT_FOUND', 'No connection found.', {
      details: {
        connectionSetup: {
          provider: 'cloudflare',
          scope: 'hlspropertycare.com',
          tokenType: 'Cloudflare Account API Token for DNS',
          setupUrls: [
            'Account API Tokens: https://dash.cloudflare.com/?to=/:account/api-tokens',
            'User API Tokens: https://dash.cloudflare.com/profile/api-tokens',
          ],
          requiredPermissions: [
            'For DNS/custom domains: grant Zone -> Zone -> Read.',
            'For DNS/custom domains: grant Zone -> DNS -> Edit.',
          ],
          credentialExample: 'hv_connect provider="cloudflare" scope="hlspropertycare.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}',
        },
      },
    });

    const text = response.content[0].text;
    expect(text).toContain('Connection Setup: 1');
    expect(text).toContain('Token Type: Cloudflare Account API Token for DNS');
    expect(text).toContain('Setup URL: Account API Tokens: https://dash.cloudflare.com/?to=/:account/api-tokens');
    expect(text).toContain('Permission: For DNS/custom domains: grant Zone -> DNS -> Edit.');
    expect(text).toContain('Connect: hv_connect provider="cloudflare" scope="hlspropertycare.com"');
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

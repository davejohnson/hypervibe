import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { supportsRuntimeMailAuthentication } from '../../domain/ports/runtime-mail-authentication.port.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../commands.js';
import { registerConnectionsTools } from '../../tools/connections.tools.js';
import type { CommandContext } from '../context.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { parseCliInvocation } from '../../interfaces/cli/parser.js';

// Independent SendGrid sandbox contract: fixed Boolean true means no delivery or
// credits, and success is 200 rather than ordinary Mail Send's 202.
// https://www.twilio.com/docs/sendgrid/for-developers/sending-email/sandbox-mode
// These are reconstructed HTTP responses; no live SendGrid request is made.
const mailBytes = readFileSync('test/provider-contracts/sendgrid/mail.openapi.json', 'utf8');
const mailSource = JSON.parse(readFileSync('test/provider-contracts/sendgrid/mail.source.json', 'utf8'));
const ajv = new Ajv({ strict: false, validateFormats: false }); ajv.addSchema(JSON.parse(mailBytes), 'sendgrid-mail');
const requestValid = ajv.compile({ $ref: 'sendgrid-mail#/components/requestBodies/PostMailSend/content/application~1json/schema' });
const privateKey = 'synthetic-private-mail-sending-credential';
const args = { provider: 'sendgrid', action: 'verify', credentialsRef: 'env:HV_TEST_RUNTIME_MAIL',
  runtimeMail: { sender: 'operator@example.test', recipient: 'consenting@example.test' } };
function registry() { const result = new CommandRegistry(); registerConnectionsTools(result, {} as CommandContext); return result; }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('private runtime email sandbox verification', () => {
  it('reviews every registered email provider capability explicitly', async () => {
    const providers = providerRegistry.all().map(item => item.metadata).filter(item => item.category === 'email');
    expect(providers.map(item => item.name).sort()).toEqual(['sendgrid']);
    expect(supportsRuntimeMailAuthentication(await providerRegistry.createAdapter('sendgrid', { apiKey: privateKey }))).toBe(true);
  });
  it('validates through the actual application boundary without saving or querying management access', async () => {
    vi.stubEnv('HV_TEST_RUNTIME_MAIL', privateKey);
    const transport = vi.fn(async () => new Response(null, { status: 200 })); vi.stubGlobal('fetch', transport);
    const result = await registry().execute('hv_connections', args);
    expect(result).toMatchObject({ ok: true, data: { authentication: 'authenticated', sandbox: true, delivery: 'unchecked', leastPrivilege: 'unchecked', senderAuthorization: 'unchecked' } });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send'); expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${privateKey}`);
    expect(createHash('sha256').update(mailBytes).digest('hex')).toBe(mailSource.schemaSha256);
    expect(requestValid(JSON.parse(String(init.body))), JSON.stringify(requestValid.errors)).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({ personalizations: [{ to: [{ email: 'consenting@example.test' }] }],
      from: { email: 'operator@example.test' }, subject: 'Hypervibe sandbox validation', content: [{ type: 'text/plain', value: 'Hypervibe sandbox validation; no email is sent.' }],
      mail_settings: { sandbox_mode: { enable: true } } });
    expect(JSON.stringify(result)).not.toContain(privateKey);
  });
  it.each([[401, 'rejected', 'authentication_rejected'], [403, 'rejected', 'access_denied'], [429, 'unknown', 'provider_unavailable'],
    [500, 'unknown', 'provider_unavailable'], [202, 'unknown', 'unexpected_response']])('projects HTTP %s without echoing provider payloads', async (status, authentication, reason) => {
    vi.stubEnv('HV_TEST_RUNTIME_MAIL', privateKey); vi.stubGlobal('fetch', vi.fn(async () => new Response(privateKey, { status })));
    const result = await registry().execute('hv_connections', args);
    expect(result).toMatchObject({ ok: false, error: { details: { authentication, reason, sandbox: true } } });
    expect(JSON.stringify(result)).not.toContain(privateKey);
  });
  it('does not infer validity from a redirect, transport failure, or credential resolution failure', async () => {
    vi.stubEnv('HV_TEST_RUNTIME_MAIL', privateKey);
    for (const transport of [vi.fn(async () => { throw new Error(privateKey); }), vi.fn(async () => Response.redirect('https://other.example', 302))]) {
      vi.stubGlobal('fetch', transport); const result = await registry().execute('hv_connections', args);
      expect(result).toMatchObject({ ok: false, error: { details: { authentication: 'unknown' } } }); expect(JSON.stringify(result)).not.toContain(privateKey);
    }
    expect(await registry().execute('hv_connections', { ...args, credentialsRef: 'env:HV_MISSING_RUNTIME_MAIL' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
  it('rejects ambiguous actions, saved management scopes and raw credentials before access', async () => {
    const transport = vi.fn(); vi.stubGlobal('fetch', transport);
    for (const extra of [{ action: 'add' }, { action: 'describe' }, { credentials: { apiKey: privateKey } }, { scope: 'production' }, { confirm: false }, { provider: undefined }]) {
      expect(await registry().execute('hv_connections', { ...args, ...extra })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it('shares the value-free result through MCP and CLI without a new tool', async () => {
    vi.stubEnv('HV_TEST_RUNTIME_MAIL', privateKey); vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const commands = registry(), invocation = await parseCliInvocation(commands, ['connections', '--provider', 'sendgrid', '--action', 'verify', '--credentials-ref', args.credentialsRef,
      '--runtime-mail', JSON.stringify(args.runtimeMail), '--json'], async () => '');
    const cli = await commands.execute(invocation.command!.id, invocation.input);
    const server = new McpServer({ name: 'mail-auth-contract', version: '0.0.0' }); registerConnectionsTools(createMcpCommandRegistrar(server), {} as CommandContext);
    const client = new Client({ name: 'mail-auth-contract', version: '0.0.0' }); const [c, s] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(s), client.connect(c)]);
    try { const mcp = await client.callTool({ name: 'hv_connections', arguments: invocation.input }); expect(mcp.structuredContent).toEqual(cli); expect(cli).toMatchObject({ ok: true }); expect(JSON.stringify(mcp)).not.toContain(privateKey); }
    finally { await client.close(); await server.close(); }
  });
});

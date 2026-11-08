import { describe, expect, it } from 'vitest';
import { recordMcpClient, requestingAgent } from '../requesting-agent.js';

describe('requesting agent', () => {
  it('names the coding agent from its shell environment', () => {
    expect(requestingAgent({ CLAUDECODE: '1' })).toBe('Claude Code');
    expect(requestingAgent({ CODEX_SANDBOX: 'seatbelt' })).toBe('Codex');
    expect(requestingAgent({ CODEX_HOME: '/x' })).toBe('Your coding agent');
    expect(requestingAgent({})).toBe('Your coding agent');
  });

  it('prefers the MCP client that initialized the session', () => {
    recordMcpClient({ name: 'codex-mcp-client' });
    expect(requestingAgent({ CLAUDECODE: '1' })).toBe('Codex');
  });
});

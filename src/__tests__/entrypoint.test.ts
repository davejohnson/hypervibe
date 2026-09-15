import { describe, expect, it, vi } from 'vitest';
import { dispatchEntrypoint } from '../entrypoint.js';

describe('Hypervibe entrypoint compatibility', () => {
  it('handles client installation before starting MCP or infrastructure commands', async () => {
    const runMcp = vi.fn(async () => undefined);
    const runCli = vi.fn(async () => 2);
    const runInstall = vi.fn(async () => 0);

    const result = await dispatchEntrypoint(['install', 'claude'], { runMcp, runCli, runInstall });

    expect(result).toBe(0);
    expect(runInstall).toHaveBeenCalledWith(['claude']);
    expect(runMcp).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
  });

  it('keeps no-argument invocation as MCP', async () => {
    const runMcp = vi.fn(async () => undefined);
    const runCli = vi.fn(async () => 0);

    const result = await dispatchEntrypoint([], { runMcp, runCli, runInstall: vi.fn() });

    expect(result).toBeUndefined();
    expect(runMcp).toHaveBeenCalledOnce();
    expect(runCli).not.toHaveBeenCalled();
  });

  it('supports an explicit MCP subcommand', async () => {
    const runMcp = vi.fn(async () => undefined);
    const runCli = vi.fn(async () => 0);

    await dispatchEntrypoint(['mcp'], { runMcp, runCli, runInstall: vi.fn() });

    expect(runMcp).toHaveBeenCalledOnce();
    expect(runCli).not.toHaveBeenCalled();
  });

  it('dispatches infrastructure CLI arguments through the existing adapter', async () => {
    const runMcp = vi.fn(async () => undefined);
    const runCli = vi.fn(async () => 2);

    const result = await dispatchEntrypoint(['--help'], { runMcp, runCli, runInstall: vi.fn() });

    expect(result).toBe(2);
    expect(runCli).toHaveBeenCalledWith(['--help']);
    expect(runMcp).not.toHaveBeenCalled();
  });
});

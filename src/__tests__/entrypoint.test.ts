import { describe, expect, it, vi } from 'vitest';
import { dispatchEntrypoint } from '../entrypoint.js';

describe('Hypervibe entrypoint compatibility', () => {
  it('keeps no-argument invocation as MCP', async () => {
    const runMcp = vi.fn(async () => undefined);
    const runCli = vi.fn(async () => 0);

    const result = await dispatchEntrypoint([], { runMcp, runCli });

    expect(result).toBeUndefined();
    expect(runMcp).toHaveBeenCalledOnce();
    expect(runCli).not.toHaveBeenCalled();
  });

  it('supports an explicit MCP subcommand', async () => {
    const runMcp = vi.fn(async () => undefined);
    const runCli = vi.fn(async () => 0);

    await dispatchEntrypoint(['mcp'], { runMcp, runCli });

    expect(runMcp).toHaveBeenCalledOnce();
    expect(runCli).not.toHaveBeenCalled();
  });

  it('dispatches every other argument list to the CLI', async () => {
    const runMcp = vi.fn(async () => undefined);
    const runCli = vi.fn(async () => 2);

    const result = await dispatchEntrypoint(['--help'], { runMcp, runCli });

    expect(result).toBe(2);
    expect(runCli).toHaveBeenCalledWith(['--help']);
    expect(runMcp).not.toHaveBeenCalled();
  });
});

export interface EntrypointHandlers {
  runMcp(): Promise<void>;
  runCli(args: string[]): Promise<number>;
}

export async function dispatchEntrypoint(
  args: string[],
  handlers: EntrypointHandlers
): Promise<number | undefined> {
  if (args.length === 0 || args[0] === 'mcp') {
    await handlers.runMcp();
    return undefined;
  }
  return handlers.runCli(args);
}

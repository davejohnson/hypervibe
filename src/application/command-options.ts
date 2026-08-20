/** Values supplied to a flat command schema but interpreted by one mode. */
export type CommandOptionValues = Record<string, unknown>;

export function suppliedOptionNames(options: CommandOptionValues): string[] {
  return Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);
}

/**
 * Read-only commands may safely ignore a recognized, mode-inapplicable option
 * as long as the human and structured envelopes say exactly what happened.
 */
export function ignoredOptionWarnings(
  commandId: string,
  selectedMode: string,
  options: CommandOptionValues
): string[] | undefined {
  const ignored = suppliedOptionNames(options);
  if (ignored.length === 0) return undefined;
  return [
    `Ignored option${ignored.length === 1 ? '' : 's'} for ${commandId} ${selectedMode}: ${ignored.join(', ')}. The requested read still completed.`,
  ];
}

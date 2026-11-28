import { initializeDatabase } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../application/context.js';
import { createCommandRegistry, type CommandRegistry } from '../../application/commands.js';
import { commandError, type CommandEnvelope } from '../../application/results.js';
import { formatCommandResult } from '../../application/presentation.js';
import { HYPERVIBE_VERSION } from '../../version.js';
import { createProcessCliIo, type CliIo } from './io.js';
import { commandHelp, parseCliInvocation, rootHelp } from './parser.js';

export interface CliRunOptions {
  io?: CliIo;
  registry?: CommandRegistry;
  initialize?: boolean;
}

function renderResult(commandId: string, result: CommandEnvelope, json: boolean): string {
  return json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${formatCommandResult(commandId, result)}\n`;
}

export async function runCli(
  argv: string[],
  options: CliRunOptions = {}
): Promise<number> {
  const io = options.io ?? createProcessCliIo();
  if (argv[0] === 'ci' && ['observe', 'deliver-observations'].includes(argv[1])) {
    if (argv.length !== 4 || argv[2] !== '--env') {
      io.writeErr(`Usage: hypervibe ci ${argv[1]} --env <environment>\n`);
      return 2;
    }
    try {
      const { runObserve, deliverObservations } = await import('../../ci/observe.js');
      if (argv[1] === 'deliver-observations') {
        const count = await deliverObservations(argv[3]);
        io.writeOut(`Delivered ${count} runtime observations to the hosted review.\n`);
        return 0;
      }
      const report = await runObserve(argv[3]);
      io.writeOut(`Checked ${report.environment}. ${report.observations.length} observations recorded.\n`);
      return 0;
    } catch {
      if (argv[1] === 'deliver-observations') io.writeErr('Hosted review delivery failed. Check the project’s GitHub connection and environment. The next poll can retry.\n');
      else io.writeErr('Runtime observation could not finish. Check the workflow identity, applied bindings and previous checkpoint.\n');
      return 1;
    }
  }
  if (argv[0] === 'reviews') {
    const { runReviews } = await import('./reviews.js');
    return runReviews(argv.slice(1), io);
  }
  const registry = options.registry ?? createCommandRegistry(createCommandContext());

  let invocation;
  try {
    invocation = await parseCliInvocation(registry, argv, io.readStdin);
  } catch (error) {
    const result = commandError('VALIDATION', `Hypervibe CLI error: ${error instanceof Error ? error.message : String(error)}`);
    if (argv.includes('--json')) io.writeOut(renderResult('cli', result, true));
    else io.writeErr(renderResult('cli', result, false));
    return 2;
  }

  if (invocation.version) {
    io.writeOut(`${HYPERVIBE_VERSION}\n`);
    return 0;
  }
  if (!invocation.command) {
    io.writeOut(rootHelp(registry));
    return invocation.help ? 0 : 2;
  }
  if (invocation.help) {
    io.writeOut(commandHelp(invocation.command));
    return 0;
  }

  // Help, version, and parse failures must not create or migrate local state.
  // Initialize only once we know a real command is going to execute.
  if (options.initialize !== false) {
    initializeDatabase();
  }

  let result = await registry.execute(invocation.command.id, invocation.input);
  const review = result.data as { reviewUrl?: string; reviewStatus?: string } | undefined;
  const browserDecision = review?.reviewUrl && ['Awaiting approval', 'Approved'].includes(review.reviewStatus ?? '');
  const canPrompt = (
    !browserDecision
    && !invocation.json
    && !invocation.nonInteractive
    && io.stdinIsTTY
    && (result.error?.code === 'CONFIRM_REQUIRED' || (result.ok && result.confirmation?.completeInput))
    && result.confirmation
  );

  if (canPrompt && result.confirmation) {
    io.writeOut(renderResult(invocation.command.id, result, false));
    const confirmed = await io.confirm(result.confirmation.message);
    if (!confirmed) {
      io.writeErr(`Hypervibe ${HYPERVIBE_VERSION}: Confirmation declined; no confirmed action was executed.\n`);
      return 1;
    }
    const nextInput = result.confirmation.completeInput ? result.confirmation.retryInput
      : { ...invocation.input, ...result.confirmation.retryInput };
    result = await registry.execute(invocation.command.id, nextInput);
  }

  io.writeOut(renderResult(invocation.command.id, result, invocation.json));
  return result.ok ? 0 : 1;
}

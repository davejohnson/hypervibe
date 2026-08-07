import type { CommandContext } from './context.js';
import { commandError, type CommandEnvelope } from './results.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';

export interface ImportProviderInput {
  provider: string;
  name?: string;
  id?: string;
  force?: boolean;
  environmentMappings?: Record<string, string>;
  storageMappings?: Record<string, string>;
  databaseMappings?: Record<string, 'postgres'>;
  cacheMappings?: Record<string, 'redis'>;
  confirm?: boolean;
}

export type ProviderImportDriver = (
  ctx: CommandContext,
  input: ImportProviderInput
) => Promise<CommandEnvelope>;

const importDrivers = new Map<string, ProviderImportDriver>();

export function registerProviderImport(provider: string, driver: ProviderImportDriver): void {
  if (importDrivers.has(provider)) throw new Error(`Provider import driver already registered: ${provider}`);
  importDrivers.set(provider, driver);
}

export async function importProvider(
  ctx: CommandContext,
  input: ImportProviderInput
): Promise<CommandEnvelope> {
  const provider = input.provider.trim().toLowerCase();
  const registered = providerRegistry.get(provider);
  if (!registered) {
    return commandError('VALIDATION', `Unknown provider "${input.provider}".`, {
      details: { providers: providerRegistry.names() },
      hint: 'Use hv_inspect without provider to list registered providers.',
      next: ['hv_inspect'],
    });
  }
  const driver = importDrivers.get(provider);
  if (!registered.adoption?.project || !driver) {
    return commandError('UNSUPPORTED', `${registered.metadata.displayName} does not yet expose a tested project adoption driver.`, {
      details: { importProviders: [...importDrivers.keys()] },
      hint: 'Use hv_inspect for read-only provider state. Do not adopt by editing bindings manually.',
      next: ['hv_inspect'],
    });
  }
  if (!input.name && !input.id) {
    return commandError('VALIDATION', 'hv_import is adoption-only and requires name or id.', {
      hint: `Use hv_inspect provider="${provider}" to list/read provider projects. Use hv_import only when adopting a selected provider project into Hypervibe.`,
      next: ['hv_inspect'],
    });
  }
  return driver(ctx, { ...input, provider });
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import type {
  CommandDefinition,
  CommandRegistrar,
  CommandRegistry,
} from '../../application/commands.js';
import {
  formatCommandEnvelope,
  type CommandEnvelope,
} from '../../application/results.js';

export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  _meta: { hypervibeEnvelope: CommandEnvelope };
  isError?: boolean;
  [key: string]: unknown;
}

export function toMcpToolResponse(envelope: CommandEnvelope): McpToolResponse {
  return {
    content: [{ type: 'text', text: formatCommandEnvelope(envelope) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    _meta: { hypervibeEnvelope: envelope },
    ...(envelope.ok ? {} : { isError: true }),
  };
}

function registerDefinition(
  server: McpServer,
  registry: CommandRegistry,
  definition: CommandDefinition
): void {
  server.tool(
    definition.id,
    definition.description,
    definition.inputShape,
    async (args) => toMcpToolResponse(
      await registry.execute(definition.id, args)
    )
  );
}

export function registerCommandRegistry(
  server: McpServer,
  registry: CommandRegistry
): void {
  for (const definition of registry.list()) {
    registerDefinition(server, registry, definition);
  }
}

/**
 * Compatibility adapter for focused tests that register one command group.
 * Production server construction uses registerCommandRegistry instead.
 */
export function createMcpCommandRegistrar(server: McpServer): CommandRegistrar {
  return {
    register<Args extends ZodRawShape>(
      name: string,
      description: string,
      inputShape: Args,
      handler: (
        args: z.infer<z.ZodObject<Args>>
      ) => Promise<CommandEnvelope> | CommandEnvelope
    ): void {
      const registerTool = server.tool.bind(server) as unknown as (
        name: string,
        description: string,
        inputShape: ZodRawShape,
        callback: (args: Record<string, unknown>) => Promise<McpToolResponse>
      ) => unknown;
      registerTool(
        name,
        description,
        inputShape,
        async (args) => toMcpToolResponse(
          await handler(args as z.infer<z.ZodObject<Args>>)
        )
      );
    },
  };
}

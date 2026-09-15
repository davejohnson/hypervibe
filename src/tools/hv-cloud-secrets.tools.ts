import { z } from 'zod';
import type { CommandContext } from '../application/context.js';
import type { CommandRegistrar } from '../application/commands.js';
import { createCloudSecretImport } from '../application/cloud-secret-import.js';
import { commandSuccess, wrapCommandHandler } from '../application/results.js';

export function registerHvCloudSecretsTools(commands: CommandRegistrar, ctx: CommandContext): void {
  const importer = createCloudSecretImport({ context: ctx });
  commands.register(
    'hv_cloud_secrets',
    'Import one approved hosted credential request into the current project’s gitignored .env.<env> exactly once. Start returns a browser approval link and comparison code; after owner approval, receive with confirm=true retrieves values privately. Existing populated keys block. Values and device proof never enter output. A lost consuming response requires a new request. Returned secretRefs are inputs to a fresh hv_plan, not deployment approval.',
    {
      action: z.enum(['start', 'receive']).optional(),
      requestId: z.string().uuid(),
      env: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
      baseUrl: z.string().optional(),
      confirm: z.boolean().optional(),
    },
    wrapCommandHandler(async (input) => {
      const result = await importer.run(input);
      return commandSuccess(
        result,
        result.status === 'approval_required'
          ? {
              agentInstruction: {
                action: 'ask_user',
                message:
                  'Offer to open verificationUrl. Wait for the owner to approve the matching comparison code before receiving; do not request secret values in chat.',
              },
              hint: 'After browser approval, use action="receive" with confirm=true to import once.',
            }
          : {
              hint: 'Map the returned secretRefs entries (key and ref) into a fresh hv_plan secretRefs object. Review that plan before applying; this import did not deploy anything.',
            }
      );
    })
  );
}

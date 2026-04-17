import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildRailwayGitHubRepoAccessHelp, buildRailwaySetupHelpInstructions } from './railway-help.js';

export function registerRailwayTools(server: McpServer): void {
  server.tool(
    'railway_setup_help',
    'Get instructions for setting up Railway API access and the Railway GitHub App for repo-linked deploys',
    {
      repo: z.string().optional().describe('Optional GitHub repository in owner/repo format for tailored repo-access guidance'),
    },
    async ({ repo }) => {
      const instructions = buildRailwaySetupHelpInstructions(repo);
      const help = buildRailwayGitHubRepoAccessHelp(repo);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            instructions,
            help,
          }),
        }],
      };
    }
  );
}

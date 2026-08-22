import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createCommandContext } from './application/context.js';
import { createCommandRegistry } from './application/commands.js';
import { registerCommandRegistry } from './interfaces/mcp/adapter.js';
import { HYPERVIBE_VERSION } from './version.js';

export const HYPERVIBE_SERVER_INSTRUCTIONS = [
  'Hypervibe exposes one desired-state infrastructure engine (hosting, databases, DNS, email, secrets, CI) through its hv_* MCP tools and the Hypervibe CLI.',
  'When these MCP tools are available, use them directly instead of spawning the Hypervibe CLI. Do NOT shell out to provider CLIs (railway, gcloud, vercel, doppler, op, bws, gh, etc.) or call provider APIs directly: those bypass Hypervibe state, reviewed plans, and audit history.',
  'Core workflow: hv_spec (desired state) → hv_plan (diff against live infrastructure, returns planId) → hv_apply planId=... → hv_status / hv_logs / hv_health to verify.',
  'In a fresh git repository, begin with hv_spec({}). Its successful initialized=false result is a normal bootstrap state: inspect the repository, call hv_spec again with the complete initial desired state, then continue to hv_plan. Do not treat the absence of an existing Hypervibe project as a missing capability.',
  'When an unknown project error includes requestedProject, repositoryProject, and registeredProjects, correct one unambiguous selector typo and retry once. Ask the user only when the intended project remains ambiguous; never initialize the possibly misspelled name.',
  'For missing connections, reproduce the exact clickable setup links and least-privilege permissions returned in connectionSetup, recommend recommendedSetupUrl, and offer to open it in the user\'s browser. Explain exactly where the user can save the credential, then show the complete credentialExample with the real local path and call hv_connections yourself after they confirm it is available. Never refer vaguely to a "Hypervibe credential flow" and never ask the user to paste a token into chat.',
  'For Hypervibe-managed GitHub Actions deploys, always inspect workflows, runs, jobs, and logs with hv_ci_status, then use hv_health after a successful run. Do not use gh, a GitHub connector/app, the GitHub UI, or direct GitHub API calls to inspect deploys. If hv_ci_status is blocked, follow or report its connection/error guidance instead of bypassing Hypervibe.',
  'Custom domain and DNS changes must be modeled as desired infrastructure and reconciled through hv_plan/hv_apply. Do not bypass a blocked apply with one-off DNS/provider mutations.',
  'When an hv_* result reports a missing required connection, use hv_connections only when a safe credentialsRef is already available. Otherwise stop and explain the concrete blocked task. Offer to help connect credentials the user already controls or prepare a value-free handoff for the person who manages that provider; do not assume the current user should receive provider access. Do not run hv_plan, hv_apply, hv_deploy, or one-off tools as a workaround.',
  'Parameter modes: hv_connections({project?}) and hv_secrets({project?}) list by default; secret hosting reads require env. hv_inspect({}) alone discovers providers and each resource mode\'s accepted selectors; every bounded inspection requires provider, full environment inspection requires provider + project + env, and limit is valid only when that mode advertises acceptsLimit=true. When a validation result includes suggestedCall with action=continue, retry that exact corrected call once.',
  'If a capability seems missing, check the other hv_* tools (most have action/target parameters) before reaching for anything outside Hypervibe.',
].join('\n');

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'hypervibe',
      version: HYPERVIBE_VERSION,
    },
    {
      instructions: HYPERVIBE_SERVER_INSTRUCTIONS,
    }
  );

  const ctx = createCommandContext();
  registerCommandRegistry(server, createCommandRegistry(ctx));

  return server;
}

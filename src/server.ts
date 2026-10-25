import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { withClientInstructions } from './interfaces/mcp/client-instructions.js';
import { createCommandContext } from './application/context.js';
import { createCommandRegistry } from './application/commands.js';
import { registerCommandRegistry } from './interfaces/mcp/adapter.js';
import { HYPERVIBE_VERSION } from './version.js';

export const HYPERVIBE_SERVER_INSTRUCTIONS = [
  'Never require another person to approve merges by default on any repository. Mandatory reviews are opt-in: enable them only when the user explicitly requests them and explain that merging will require another person. Requests for code safeguards or automated checks, and the presence of collaborators, do not authorize this requirement. Preserve existing owner-chosen review policies unless the user asks to change them.',
  'Hypervibe exposes one desired-state infrastructure engine (hosting, databases, DNS, email, secrets, CI) through its hv_* MCP tools and the Hypervibe CLI.',
  'When these MCP tools are available, use them directly instead of spawning the Hypervibe CLI. Do NOT shell out to provider CLIs (railway, gcloud, vercel, doppler, op, bws, gh, etc.) or call provider APIs directly: those bypass Hypervibe state, reviewed plans, and audit history.',
  'Core workflow: hv_spec (desired state) → hv_plan (diff against live infrastructure, returns planId) → hv_apply planId=... → hv_status / hv_logs / hv_health to verify.',
  'When the user must complete a web form, first obtain read-only contextual setup guidance with hv_connections action="describe" using the known provider and scope, plus project only when initialized. Generic provider discovery is not completed scoped setup. Hypervibe prepares every supported non-secret field whose value is known, including name and description, using officially documented, encoded parameters. Lead with the returned direct clickable form URL. Preserve the complete query string exactly; do not rewrite labels or permissions, invent parameters, or replace it with dashboard navigation. Report a missing supported prefill as a guidance gap. Explain remaining manual fields, review and consent. Never put secrets in URLs. Provider-owned bootstrap and browser authentication take precedence when available.',
  'Hypervibe is for nontechnical users bringing projects to the web. Choose routine names and supported economical defaults from repository evidence. For a new web app, prepare production and isolated staging unless the user or existing spec says otherwise; explain the chosen setup instead of asking naming questions. Ask only for missing access, ambiguous ownership or billing scope, and consequential plan confirmations. Report unattempted actions as skipped or aborted, with their prerequisite; reserve failed for attempted actions that failed.',
  'Explain changes by their practical benefit in everyday language. For example, say "I will help protect your code on GitHub from accidental overwrites" instead of "enable branch protection on main." Explain reviews or automated checks when they affect how the user publishes changes. For routine safeguards already declared in the project or authorized by the user, explain the benefit and proceed through spec/plan/apply without asking for another confirmation just because a technical setting appears in the plan. Preserve explicit user choices and confirmations required for consequential changes.',
  'In a fresh git repository, begin with hv_spec({}). Its successful initialized=false result is a normal bootstrap state: inspect the repository, call hv_spec again with the complete initial desired state, then continue to hv_plan. Do not treat the absence of an existing Hypervibe project as a missing capability.',
  'When an unknown project error includes requestedProject, repositoryProject, and registeredProjects, correct one unambiguous selector typo and retry once. Ask the user only when the intended project remains ambiguous; never initialize the possibly misspelled name.',
  'For new AWS, Azure or GCP secret-manager connections, use hv_cloud_connections purpose="connect-cloud" with the exact repository environment: action="start", open the returned browser approval link, then action="status" and action="connect" after device approval. Follow the returned browser link for provider selection and administrator installation, or inviting the cloud administrator. This flow requires no local cloud credentials or manually prepared writer. Review the exact cloud scope, resources, permissions and costs before installation. Use status to recover progress. Follow the returned nextStep. Only mode="connect" may request a value-free spec patch to commit before action="accept-source"; connect-existing and migrate preserve the committed destinations and versions. Collection and purpose="deployment-access" each require separate authorization. If hosted setup is unavailable, report its concrete prerequisite; do not substitute credential uploads or key creation.',
  'Only when the user requests sharing compatible monitoring credentials they already control, use hv_cloud_connections purpose="provider-connections": start/status for its separate browser approval, preview for exact destinations, then connect with that previewId and confirm=true. Never paste credential values into chat or upload deployment credentials under a different monitoring role. Existing hosted connections are preserved.',
  'When the user wants hosted reporting or observation for the current repository, call hv_cloud_pair with action=start. Offer to open its verificationUrl, then call hv_cloud_pair with action=status after the user approves. Never ask for a GitHub token, repository id, or environment name; the GitHub App and repository spec own those choices.',
  'For connections outside the browser installation flow, reproduce the exact clickable setup links and least-privilege permissions returned in connectionSetup, recommend recommendedSetupUrl, and offer to open it in the user\'s browser. When connecting credentials the user already controls, explain the safe local reference, show the complete credentialExample with the real local path and call hv_connections yourself after they confirm it is available. Never refer vaguely to a "Hypervibe credential flow" and never ask the user to paste a token into chat.',
  'For every deploy or promotion request, read the desired state and route the release through Hypervibe. Use hv_deploy for plan-gated direct/manual deploys. For managed CI, use hv_ci_status to select the reviewed definition, hv_ci_trigger to dispatch it, hv_ci_status to monitor it, and hv_health after success. Never dispatch, monitor, or inspect a managed CI run with gh, a GitHub connector/app, the GitHub UI, or a direct CI/provider API. If hv_ci_status or hv_ci_trigger is blocked, follow or report its connection/error guidance and stop instead of bypassing Hypervibe.',
  'Custom domain and DNS changes must be modeled as desired infrastructure and reconciled through hv_plan/hv_apply. Do not bypass a blocked apply with one-off DNS/provider mutations.',
  'The legacy hv_connections provider="cloudrun" action="bootstrap" creates and stores a deployment service-account key. Preserve it only for explicitly requested legacy setup, never as the default for new Connect Cloud customers. It requires a read-only preview with explicit project and adminAuth="default" before any confirmation. The preview may infer gcpProjectId; confirmation requires the exact returned ID. Show openBillingAccounts and ask the user to choose one exact account before repeating with that gcpProjectId, billingAccountName and confirm=true. Never choose a billable account for the user.',
  'When an hv_* result reports a missing required connection, use the declared browser installation flow where applicable. Use hv_connections only when a safe credentialsRef is already available, the provider declares a native/default credential chain, or the user explicitly requested the legacy GCP key-creating bootstrap. Otherwise stop and explain the concrete blocked task. Offer to help connect credentials the user already controls or prepare a value-free handoff for the person who manages that provider; do not assume the current user should receive provider access. Do not run hv_plan, hv_apply, hv_deploy, or one-off tools as a connection workaround.',
  'Preparing Hypercloud\'s own missing host is a separate operator task. Use only the provider-declared local hosting.scopePreparation capability through hv_spec, hv_plan and hv_apply; a scope-ready empty project does not authorize billing, IAM, connection publication or deployment. Never present this local operator stage as hosted customer onboarding.',
  'Parameter modes: hv_connections({project?}) and hv_secrets({project?}) list by default; secret hosting reads require env. hv_inspect({}) alone discovers providers and each resource mode\'s accepted selectors; every bounded inspection requires provider, full environment inspection requires provider + project + env, and limit is valid only when that mode advertises acceptsLimit=true. When a validation result includes suggestedCall with action=continue, retry that exact corrected call once.',
  'If a capability seems missing, check the other hv_* tools (most have action/target parameters) before reaching for anything outside Hypervibe.',
].join('\n');

class HypervibeMcpServer extends McpServer {
  override connect(transport: Transport): Promise<void> {
    return super.connect(withClientInstructions(transport, HYPERVIBE_SERVER_INSTRUCTIONS));
  }
}

export function createServer(): McpServer {
  const server = new HypervibeMcpServer(
    {
      name: 'hypervibe',
      version: HYPERVIBE_VERSION,
    },
    {
      instructions: HYPERVIBE_SERVER_INSTRUCTIONS,
    }
  );

  server.registerResource('hypervibe-guidance', 'hypervibe://guidance', {
    title: 'Complete Hypervibe operating guidance',
    description: 'Full connection, deployment, cloud setup and recovery guidance, including details summarized for client startup limits.',
    mimeType: 'text/plain',
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: HYPERVIBE_SERVER_INSTRUCTIONS }] }));

  const ctx = createCommandContext();
  registerCommandRegistry(server, createCommandRegistry(ctx));

  return server;
}

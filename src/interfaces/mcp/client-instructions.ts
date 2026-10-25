import { InitializeRequestSchema, type RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// Claude Code's documented defaults are 4,096 characters since 2.1.296 and
// 2,048 before that. These are authored summaries, never sliced instructions.
// https://code.claude.com/docs/en/mcp#tool-search-for-mcp-server-authors
const CLAUDE_CORE = [
  'Use Hypervibe for deploying and managing apps, hosting, databases, storage, DNS, integrations, secrets and CI. Discover its hv_* tools; use them directly. Infrastructure changes follow hv_spec -> hv_plan -> hv_apply -> hv_status/hv_health. Never bypass this lifecycle with provider CLIs, APIs or other connectors.',
  'Start a new repository with hv_spec({}); initialized=false means inspect the app and submit its initial spec. Preserve the current repository, exact provider scope, existing choices and accepted bindings. Choose sensible economical defaults, including isolated production/staging for a new web app.',
  'Explain practical outcomes in plain language. Ask only for missing access, ambiguous ownership/billing, externally owned secrets or consequential confirmations. Never enable mandatory merge reviews unless explicitly requested. Never expose secrets or ask users to invent Hypervibe-generated keys.',
  'For missing connections, use the returned connectionSetup and supported bootstrap. Present its exact proposed scope and required approval before changes. Missing or unknown access blocks dependent work; never treat it as proof that a resource is absent.',
  'For a required form, call hv_connections action="describe" with provider/scope (project when initialized). Show its direct clickable setup link; preserve the complete query string, name and description exactly. Generic discovery is not scoped setup. Explain manual fields and the safe credential reference. Never put secrets in URLs or tokens in chat.',
  'For managed deployments use hv_ci_status, hv_ci_trigger and verification tools. Stop on blocked, failed, pending or confirmation-required results unless an explicit bounded continuation applies. Report actual evidence and partial outcomes honestly.',
  'All capabilities remain available. Read hypervibe://guidance for complete workflows; follow detailed tool results and the installed Hypervibe skill.',
].join('\n');

const CLAUDE_DETAILS = [
  'For a first GCP Cloud Run/Cloud SQL connection, use hv_connections action="bootstrap" with explicit project, gcpProjectId and adminAuth="default" for a read-only preview. Present openBillingAccounts; the user chooses the exact account before confirming the proposed setup. Hypervibe creates its generated deployment credential. Reuse valid access and preserve selected project/repository scope.',
  'Use hv_inspect for read-only provider investigation; hv_import adopts infrastructure only on explicit request. Hosted reporting uses hv_cloud_pair start/status, with browser approval; it needs no GitHub PAT. Sharing local credentials with hosted Hypervibe uses hv_cloud_connections start/status, preview, then the exact confirmed connect. Private owner requests and one-time secret imports have separate approvals and encrypted recovery; never retrieve a consumed secret twice.',
  'Credential inventory: hv_secrets({project,env,view:"inventory"}). Roles: hv_plan scope="credentials", credential=<role>, intent="adopt"|"rotate". Hosting reads need env. hv_inspect({}) discovers providers; bounded reads need provider, environment reads need project+env. Follow one exact suggestedCall when action=continue; names never prove ownership.',
  'For external credentials, present connectionSetup.recommendedSetupUrl and credentialExample with the real local reference, then connect through hv_connections. For direct/manual deploys use hv_deploy. Preserve recovery evidence for rollback, and separate configured protection, available recovery points and tested restores. Unsupported capabilities and unverified live behavior remain explicit.',
].join('\n');

export function instructionsForClient(
  client: { name: string; version: string },
  fullInstructions: string
): string {
  if (client.name !== 'claude-code') return fullInstructions;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/.exec(client.version);
  const modern = match && (Number(match[1]) > 2
    || (Number(match[1]) === 2 && (Number(match[2]) > 1
      || (Number(match[2]) === 1 && Number(match[3]) >= 296))));
  return modern ? `${CLAUDE_CORE}\n${CLAUDE_DETAILS}` : CLAUDE_CORE;
}

/** Adapt only the initialize receipt; SDK negotiation and all tools are intact. */
export function withClientInstructions(transport: Transport, fullInstructions: string): Transport {
  let initialization: { id: RequestId; instructions: string } | undefined;
  const wrapper: Transport = {
    async start() {
      transport.onmessage = (message, extra) => {
        if ('method' in message && message.method === 'initialize') {
          const parsed = InitializeRequestSchema.safeParse(message);
          if (parsed.success && 'id' in message) {
            initialization = { id: message.id, instructions: instructionsForClient(parsed.data.params.clientInfo, fullInstructions) };
          }
        }
        wrapper.onmessage?.(message, extra);
      };
      transport.onclose = () => wrapper.onclose?.();
      transport.onerror = error => wrapper.onerror?.(error);
      await transport.start();
    },
    async send(message, options) {
      if (initialization && 'id' in message && message.id === initialization.id && ('result' in message || 'error' in message)) {
        const instructions = initialization.instructions;
        initialization = undefined;
        if ('result' in message) message = { ...message, result: { ...message.result, instructions } };
      }
      await transport.send(message, options);
    },
    close: () => transport.close(),
    get sessionId() { return transport.sessionId; },
    setProtocolVersion: version => transport.setProtocolVersion?.(version),
  };
  return wrapper;
}

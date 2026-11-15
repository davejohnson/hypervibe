import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CommandRegistrar } from './commands.js';
import type { CommandContext } from './context.js';
import { createHypervibeCloudPairingClient, normalizeHypervibeCloudBaseUrl } from './cloud-pairing.js';
import { createCloudRequestClient, fieldSchema, type CredentialRequest } from './cloud-request-client.js';
import { resolveCredentialPlanHandoff } from './credential-plan-handoff.js';
import { CloudHttpError } from './cloud-http.js';
import { commandSuccess, HvError, wrapCommandHandler } from './results.js';
import { findRepoRoot, readRepoSpecFile } from '../domain/spec/repo-spec-file.js';
import { detectGitRemoteUrl, normalizeGitRemoteIdentity, resolveGitHeadCommitSha } from '../lib/git-remote.js';
import { primaryWorkspaceDirectory } from '../lib/workspace-context.js';
import { assertPendingSourceBranch, resolveCloudSourceBranch, sourceBranchSchema as branch } from './cloud-source-branch.js';

const PROVIDER = 'hypervibe-cloud-requests';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const email = z.string().trim().toLowerCase().email().max(320);
const inputShape = {
  action: z.enum(['create', 'list', 'resume', 'replace', 'revoke', 'authorize']).optional().describe('Default: prepare a request; confirm sends it. Resume finds ready requests and private import calls without IDs. Replace explicitly re-requests terminal credentials. List reads history, revoke cancels one request, authorize opens browser access.'),
  env: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).optional().describe('Defaults to staging, or the only declared environment.'),
  planId: z.string().uuid().optional().describe('For create/replace, select only unsupplied required runtime inputs from this fresh persisted plan. Resume treats this as a continuity hint, never deployment approval; a fresh plan is required after import.'),
  ownerEmail: email.optional().describe('Usually inferred from secret principal="email:owner@example.com". Supply only when the spec does not name an email owner, or to select one of several declared owners.'),
  fields: z.array(fieldSchema.partial({ label: true, inputType: true }).strict()).min(1).max(16).optional().describe('Optional subset of delegated keys with label/inputType overrides. By default request required keys from the spec with readable labels and hidden inputs. Never include values.'),
  sourceBranch: branch.optional().describe('Defaults to the checked-out branch. Authorize uses it only to prefill app setup; invitations and resume still require matching committed source.'),
  title: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  requestId: z.string().uuid().optional().describe('Required only when replacing or revoking a request returned by list/resume.'),
  page: z.number().int().min(1).max(1000).optional(),
  sort: z.enum(['newest', 'oldest']).optional(),
  baseUrl: z.string().optional(),
  confirm: z.boolean().optional().describe('Approve the previously reviewed invitation or revocation; changes require a new review.'),
};
type Input = z.infer<z.ZodObject<typeof inputShape>>;
const environment = z.object({ id: z.string().uuid(), key: z.string(), name: z.string() });
const proposalSchema = z.object({
  recipientEmail: email, title: inputShape.title.unwrap(), fields: z.array(fieldSchema).min(1).max(16),
  sourceBranch: branch, expectedSourceRevision: z.string().regex(/^[a-f0-9]{40}$/), expectedSourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
type Proposal = z.infer<typeof proposalSchema>;
const reviewSchema = z.object({
  fingerprint: z.string(), message: z.string(), pendingWrite: z.boolean(), action: z.enum(['create', 'replace', 'revoke']),
  requestId: z.string().uuid().optional(), proposal: proposalSchema.optional(), priorRequestIds: z.array(z.string().uuid()).max(20000).optional(),
});
const commonState = {
  version: z.literal(1), baseUrl: z.string(), repository: z.string(), env: z.string(),
  expiresAt: z.string().datetime(), review: reviewSchema.optional(),
};
const pendingSchema = z.object({ ...commonState, status: z.literal('pending'), sourceBranch: branch.optional(), deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/), userCode: z.string(), verificationUrl: z.string().url(), exchangeAttempted: z.boolean().optional() });
const verifiedSchema = z.object({ ...commonState, status: z.literal('verified'), project: z.object({ id: z.string().uuid(), name: z.string() }), environment, token: z.string().regex(/^hvc_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/) });
const stateSchema = z.discriminatedUnion('status', [pendingSchema, verifiedSchema]);
type State = z.infer<typeof stateSchema>;

function checkout(input: Input) {
  const root = findRepoRoot(primaryWorkspaceDirectory());
  const document = root && readRepoSpecFile(root);
  const remote = root && normalizeGitRemoteIdentity(detectGitRemoteUrl(root) ?? undefined);
  if (!root || !document || !remote?.startsWith('github.com/')
    || (document.spec.gitRemoteUrl && normalizeGitRemoteIdentity(document.spec.gitRemoteUrl) !== remote))
    throw new HvError('VALIDATION', 'Use the intended GitHub checkout with its Hypervibe spec. Initialize missing desired state with hv_spec.');
  const names = Object.keys(document.spec.environments);
  const env = input.env ?? (names.includes('staging') ? 'staging' : names.length === 1 ? names[0] : undefined);
  if (!env || !document.spec.environments[env]) throw new HvError('VALIDATION', 'Select a declared environment; there is no unambiguous staging default.');
  return { root, spec: document.spec, repository: remote.slice('github.com/'.length), env };
}

function committedSource(input: Input, scope: ReturnType<typeof checkout>) {
  const specPath = path.join(scope.root, '.hypervibe/spec.json');
  const revision = resolveGitHeadCommitSha(scope.root, specPath);
  const sourceBranch = resolveCloudSourceBranch(scope.root, input.sourceBranch);
  if (!revision || !branch.safeParse(sourceBranch).success) throw new HvError('VALIDATION', 'Commit the value-free spec and select its source branch before preparing an invitation.');
  return { sourceBranch: sourceBranch!, expectedSourceRevision: revision, expectedSourceDigest: hash(readFileSync(specPath)) };
}

function intent(input: Input, scope: ReturnType<typeof checkout>, requiredKeys?: string[]): Proposal | null {
  const slots = Object.entries(scope.spec.secrets ?? {}).filter(([, slot]) => slot.ownership === 'delegated' && slot.environments.includes(scope.env));
  const declaredEmail = (principal: string) => email.safeParse(principal.startsWith('email:') ? principal.slice(6) : principal);
  const selected: NonNullable<Input['fields']> = input.fields ?? slots.filter(([key, slot]) => (requiredKeys === undefined || requiredKeys.includes(key)) && slot.ownership === 'delegated' && slot.required !== false
    && (!input.ownerEmail || slot.ownership !== 'delegated' || !declaredEmail(slot.principal).success || declaredEmail(slot.principal).data === input.ownerEmail)).map(([key]) => ({ key }));
  if (!selected.length && !input.fields && !input.ownerEmail) return null;
  if (!selected.length || selected.length > 16 || new Set(selected.map(f => f.key)).size !== selected.length)
    throw new HvError('VALIDATION', 'Select 1–16 unique delegated keys declared for this environment. Generated application secrets cannot be requested.');
  const owners = new Set<string>();
  for (const field of selected) {
    const slot = slots.find(([key]) => key === field.key)?.[1];
    if (!slot || slot.ownership !== 'delegated') throw new HvError('VALIDATION', 'Every selected field must be a delegated secret in this environment.');
    if (requiredKeys && !requiredKeys.includes(field.key)) throw new HvError('VALIDATION', 'Select only unsupplied required runtime inputs from the reviewed plan; other declared keys are not missing inputs for that plan.');
    const parsed = declaredEmail(slot.principal);
    if (parsed.success) owners.add(parsed.data);
    else if (!input.ownerEmail) throw new HvError('VALIDATION', 'Who should supply these credentials? Set principal="email:owner@example.com" on the selected secrets with hv_spec, or supply ownerEmail for this invitation.');
  }
  if (owners.size > 1 || (input.ownerEmail && owners.size && !owners.has(input.ownerEmail)))
    throw new HvError('VALIDATION', 'The selected keys have different declared email ownership. Select one owner’s keys, or review an ownership change through hv_spec first.');
  const recipientEmail = input.ownerEmail ?? [...owners][0];
  if (!recipientEmail) throw new HvError('VALIDATION', 'Supply the credential owner’s email; never supply credential values here.');
  return proposalSchema.parse({
    recipientEmail, title: input.title ?? `${scope.spec.project.slice(0, 108)} credentials`,
    fields: selected.map(f => ({ key: f.key, label: f.label ?? f.key.replaceAll('_', ' ').slice(0, 120), inputType: f.inputType ?? 'password' as const })),
    ...committedSource(input, scope),
  });
}

function matchesProposal(request: CredentialRequest, proposal: Proposal, exactTitle = false) {
  return request.authentication === 'email' && request.recipient === proposal.recipientEmail
    && (!exactTitle || request.title === proposal.title)
    && request.sourceRevision === proposal.expectedSourceRevision && request.sourceBranch === proposal.sourceBranch
    && JSON.stringify(request.fields) === JSON.stringify(proposal.fields)
    && request.keys.slice().sort().join(',') === proposal.fields.map(field => field.key).sort().join(',');
}

export function registerCloudRequestCommands(commands: CommandRegistrar, context: CommandContext): void {
  commands.register('hv_cloud_requests',
    'Collect declared credentials with browser-approved access. Infer repository, staging, branch, delegated keys and email owner. Review an invitation before confirm=true sends it. Resume lists current readiness and exact-source private import calls without request IDs; it never imports, deploys or wakes an agent automatically. Matching requests are reused, including consumed requests; replace explicitly reviews a new request after consumption, expiry or revocation. List reads history and revoke confirms cancellation. Values stay in the secure form and separately approved hv_cloud_secrets import.',
    inputShape, wrapCommandHandler(async input => {
      const action = input.action ?? 'create';
      if (['revoke', 'replace'].includes(action) && !input.requestId) throw new HvError('VALIDATION', 'Select the requestId from list or resume for this action.');
      const invitationOptions = ['ownerEmail', 'fields', 'sourceBranch', 'title', 'confirm', 'planId'];
      const allowed: Record<typeof action, string[]> = { create: invitationOptions, replace: [...invitationOptions, 'requestId'], resume: ['sourceBranch', 'planId'], list: ['page', 'sort'], revoke: ['requestId', 'confirm'], authorize: ['sourceBranch'] };
      if (Object.entries(input).some(([key, value]) => value !== undefined && !['action', 'env', 'baseUrl', ...allowed[action]].includes(key))) throw new HvError('VALIDATION', 'Use only options for the selected request action.');
      const scope = checkout(input);
      let selectedBaseUrl = input.baseUrl;
      if (!selectedBaseUrl) {
        const paired = context.repos.connections.findByProviderAndScope('hypervibe-cloud', scope.repository);
        if (paired?.status === 'verified') {
          const metadata = z.object({ status: z.literal('verified'), repository: z.literal(scope.repository), baseUrl: z.string() }).safeParse(context.secretStore.decryptObject(paired.credentialsEncrypted));
          if (!metadata.success) throw new HvError('VALIDATION', 'The existing cloud pairing has unreadable repository scope. Repair it before continuing.');
          selectedBaseUrl = metadata.data.baseUrl;
        }
      }
      const baseUrl = normalizeHypervibeCloudBaseUrl(selectedBaseUrl);
      const connectionScope = `${baseUrl}|${scope.repository}|${scope.env}`;
      let stored = context.repos.connections.findByProviderAndScope(PROVIDER, connectionScope);
      let state: State | undefined;
      if (stored) {
        const parsed = stateSchema.safeParse(context.secretStore.decryptObject(stored.credentialsEncrypted));
        if (!parsed.success) throw new HvError('VALIDATION', 'Local browser-access state is unreadable. Restore it before continuing.');
        state = parsed.data;
        if (state.baseUrl !== baseUrl || state.repository !== scope.repository || state.env !== scope.env
          || (state.status === 'verified' && state.environment.key !== scope.env)) throw new HvError('VALIDATION', 'Browser access belongs to another repository or environment.');
      }
      // Recovery uses the original reviewed intent, not today's branch or owner.
      // Otherwise changing source could make a committed invitation impossible
      // to reconcile. A normal new invitation still preflights before pairing.
      const requiredKeys = input.planId && ['create', 'replace'].includes(action) && !state?.review?.pendingWrite
        ? resolveCredentialPlanHandoff(context, { planId: input.planId, ...scope }).keys : undefined;
      let proposal = action === 'create' && !state?.review?.pendingWrite ? intent(input, scope, requiredKeys) : undefined;
      if (proposal === null || (action === 'replace' && requiredKeys?.length === 0)) return commandSuccess({ status: 'not_required', environment: scope.env }, { hint: input.planId ? 'The reviewed plan has no eligible required runtime credentials to request. No invitation was sent.' : 'This spec declares no required delegated runtime credentials for this environment. No browser access or invitation is needed.' });
      const save = (next: State) => {
        const encrypted = context.secretStore.encryptObject(next);
        if (stored) context.repos.connections.updateCredentials(stored.id, encrypted);
        else stored = context.repos.connections.upsert({ provider: PROVIDER, scope: connectionScope, credentialsEncrypted: encrypted });
        context.repos.connections.updateStatus(stored.id, next.status === 'verified' ? 'verified' : 'pending');
        state = next;
      };
      const pairing = createHypervibeCloudPairingClient({ baseUrl, grant: { purpose: 'credential-requests', environment: scope.env } });
      const approval = (pending: z.infer<typeof pendingSchema>) => commandSuccess({ status: 'approval_required', repository: scope.repository, environment: scope.env, verificationUrl: pending.verificationUrl, userCode: pending.userCode, ...(pending.sourceBranch ? { sourceBranch: pending.sourceBranch } : {}) }, {
        agentInstruction: { action: 'ask_user', message: 'Offer to open verificationUrl. Ask the user to approve this repository, environment and matching code, then repeat the same command. Never ask for cookies, tokens or credential values.' },
        hint: 'Approve credential-request access in the browser, then repeat this command. No invitation has been sent.',
      });
      if (!state || new Date(state.expiresAt).getTime() <= Date.now()) {
        const sourceBranch = resolveCloudSourceBranch(scope.root, input.sourceBranch, state?.status === 'pending' ? state : undefined);
        const result = await pairing.start(scope.repository, sourceBranch);
        const pending: z.infer<typeof pendingSchema> = { version: 1, status: 'pending', baseUrl, repository: scope.repository, env: scope.env, sourceBranch, deviceCode: result.deviceCode, userCode: result.userCode, verificationUrl: result.verificationUrl, expiresAt: result.expiresAt, review: state?.review };
        save(pending);
        return approval(pending);
      }
      if (state.status === 'pending') {
        assertPendingSourceBranch(input.sourceBranch, state.sourceBranch);
        if (state.exchangeAttempted) throw new HvError('PROVIDER_ERROR', 'The browser-access exchange has an unknown outcome. Do not repeat it. Let this short approval expire before authorizing again.');
        save({ ...state, exchangeAttempted: true });
        let result;
        try { result = await pairing.exchange(state.deviceCode); }
        catch (error) {
          // Expired/consumed codes and revoked approvers are rejected before
          // grant issuance. Start fresh access after a definite rejection,
          // retaining any earlier uncertain invitation instead of retrying proof.
          if (error instanceof CloudHttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
            save({ ...state, expiresAt: new Date(0).toISOString(), exchangeAttempted: false });
            throw new HvError('MISSING_CONNECTION', 'This browser approval was rejected or is no longer available. Repeat the command to approve fresh access; any uncertain invitation remains preserved.');
          }
          throw error;
        }
        if (result.status === 'pending') {
          const pending = { ...state, exchangeAttempted: false };
          save(pending); return approval(pending);
        }
        const credential = result.credentials[0];
        const verified = verifiedSchema.parse({ version: 1, status: 'verified', baseUrl, repository: scope.repository, env: scope.env, project: result.project, environment: credential.environment, token: credential.token, expiresAt: credential.expiresAt, review: state.review });
        try { save(verified); } catch {
          // The exact newly issued grant is ours to compensate if local storage fails.
          await fetch(new URL('/api/v1/credential-request-access', baseUrl), { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${verified.token}` } }).catch(() => {});
          throw new HvError('PROVIDER_ERROR', 'Browser access could not be saved locally. Cleanup of the new grant was attempted; no invitation was sent.');
        }
        // Access approval never doubles as consent to an invitation.
      }
      if (state.status !== 'verified') throw new HvError('INTERNAL', 'Browser access was not established.');
      let grant = state;
      const client = createCloudRequestClient({ baseUrl, token: grant.token, projectId: grant.project.id, environmentId: grant.environment.id });
      const importCall = (request: CredentialRequest) => ({ command: 'hv_cloud_secrets', input: { requestId: request.id, env: scope.env, baseUrl } });
      const replacementCall = (request: CredentialRequest) => ({ command: 'hv_cloud_requests', input: { action: 'replace', requestId: request.id, env: scope.env, baseUrl } });
      const receipt = (request: CredentialRequest, extras: Record<string, unknown> = {}, offerImport = true) => commandSuccess({ applied: 0, skipped: 1, request,
        ...(offerImport && request.status === 'ready' ? { import: importCall(request) } : {}),
        ...(['consumed', 'expired', 'revoked'].includes(request.status) ? { replacement: replacementCall(request) } : {}), ...extras,
      }, {
        hint: offerImport && request.status === 'ready' ? 'Ready means values were supplied, not validated. Use hv_cloud_secrets for browser-approved private import, then prepare a fresh plan.' : 'No new invitation was sent. Resume checks current source eligibility. Re-requesting terminal credentials requires a separately confirmed replacement.', next: offerImport && request.status === 'ready' ? ['hv_cloud_secrets'] : ['hv_cloud_requests'],
      });
      const listAll = async () => {
        const requests: CredentialRequest[] = [];
        const ids = new Set<string>();
        for (let page = 1; page <= 1000; page++) {
          const result = await client.list(page);
          for (const request of result.requests) {
            if (ids.has(request.id)) throw new HvError('PROVIDER_ERROR', 'Request history changed during pagination. No complete inventory has been inferred.');
            ids.add(request.id); requests.push(request);
          }
          if (!result.pagination.hasNext) return requests;
        }
        throw new HvError('PROVIDER_ERROR', 'Request history exceeds the supported page limit. No invitation was sent.');
      };
      const confirm = (fingerprint: string, message: string, reviewed?: Proposal, priorRequestIds?: string[]) => {
        if (grant.review?.pendingWrite) throw new HvError('PROVIDER_ERROR', 'A previous write has an unknown outcome. List requests and resolve that outcome before sending or revoking again.');
        if (!input.confirm || grant.review?.fingerprint !== fingerprint) {
          grant = { ...grant, review: { fingerprint, message, pendingWrite: false, action: action as 'create' | 'replace' | 'revoke', requestId: input.requestId, proposal: reviewed, priorRequestIds } };
          save(grant);
          throw new HvError('CONFIRM_REQUIRED', message, { agentInstruction: { action: 'ask_user', message: 'Present the exact invitation or cancellation and ask for approval before retrying with confirm=true.' } });
        }
      };
      let writeAttempted = false;
      try {
        if (action === 'authorize') return commandSuccess({ status: 'connected', repository: scope.repository, environment: scope.env });
        if (action === 'list') return commandSuccess(await client.list(input.page, input.sort), { hint: 'Presence-only status; no values are returned. Ready requests can be imported with hv_cloud_secrets using this environment and server.' });
        let requests: CredentialRequest[] | undefined;
        let recovery: { status: 'reconciled'; requestId: string } | undefined;
        if (grant.review?.pendingWrite) {
          const review = grant.review;
          let recovered: CredentialRequest | undefined;
          if (review.action === 'revoke' && review.requestId) {
            const observed = await client.show(review.requestId);
            if (['revoked', 'consumed'].includes(observed.status)) recovered = observed;
          } else if (review.proposal && review.priorRequestIds) {
            requests = await listAll();
            // A previous identical terminal request predates this attempt. It
            // cannot prove the new POST completed; multiple new matches are
            // likewise ambiguous. Source revision binds immutable spec bytes.
            const candidates = requests.filter(request => !review.priorRequestIds!.includes(request.id) && matchesProposal(request, review.proposal!, true));
            if (candidates.length === 1) recovered = candidates[0];
          }
          if (!recovered) throw new HvError('PROVIDER_ERROR', 'The previous write remains uncertain. No unique new matching receipt was verified; its recovery marker is preserved and no mutation was repeated.');
          recovery = { status: 'reconciled', requestId: recovered.id };
          grant = { ...grant, review: undefined }; save(grant);
          // Resolving an earlier write never authorizes the newly requested
          // mutation. Resume may continue read-only; everything else stops here.
          if (action !== 'resume') return receipt(recovered, { recovery }, false);
        }
        if (action === 'resume') {
          requests ??= await listAll();
          const source = committedSource(input, scope);
          const discovered = await client.fields(source.sourceBranch);
          const currentSource = discovered.source?.revision === source.expectedSourceRevision && discovered.source.digest === source.expectedSourceDigest;
          // Web requests may bind the current default branch (null). Another
          // explicit branch retaining its old SHA is not proof of that default.
          const defaultSource = requests.some(request => request.sourceBranch === null && ['pending', 'ready'].includes(request.status))
            ? await client.fields('') : undefined;
          const currentDefault = defaultSource?.source?.revision === source.expectedSourceRevision && defaultSource.source.digest === source.expectedSourceDigest;
          const terminal = requests.filter(request => !['pending', 'ready'].includes(request.status));
          // The server permits at most 20 live requests. Bound historical
          // output while retaining complete inventory counts and active work.
          const visible = [...requests.filter(request => ['pending', 'ready'].includes(request.status)), ...terminal.slice(0, 20)];
          const rows = visible.map(request => {
            const eligible = request.sourceRevision === source.expectedSourceRevision
              && (request.sourceBranch === null ? currentDefault : currentSource && request.sourceBranch === source.sourceBranch)
              && request.keys.every(key => {
                const slot = scope.spec.secrets?.[key];
                return slot?.ownership === 'delegated' && slot.environments.includes(scope.env) && discovered.availableFields.some(field => field.key === key);
              });
            const readiness = ['pending', 'ready'].includes(request.status) && !eligible ? 'stale_source' : request.status;
            return { request, readiness,
              ...(readiness === 'ready' ? { import: importCall(request) } : {}),
              ...(['consumed', 'expired', 'revoked'].includes(request.status) ? { replacement: replacementCall(request) } : {}),
            };
          });
          const status = rows.some(row => row.readiness === 'ready') ? 'ready_for_import'
            : rows.some(row => row.readiness === 'pending') ? 'awaiting_credentials'
              : rows.length ? 'recovery_required' : 'no_active_requests';
          return commandSuccess({ status, environment: scope.env, requests: rows, history: { total: requests.length, shown: rows.length }, replanRequired: true, ...(input.planId ? { previousPlanId: input.planId } : {}), ...(recovery ? { recovery } : {}) }, {
            hint: 'Presence-only status, not provider validation or deployment readiness. Import calls require separate browser approval. Check local import recovery before replacing consumed credentials; never repeat a one-time retrieval. Prepare a fresh plan after import. No background wake or deployment was started.',
          });
        }
        if (action === 'revoke') {
          const request = await client.show(input.requestId!);
          if (['revoked', 'consumed'].includes(request.status)) {
            if (grant.review?.pendingWrite && grant.review.action === 'revoke' && grant.review.requestId === request.id) save({ ...grant, review: undefined });
            return receipt(request);
          }
          const fingerprint = hash(JSON.stringify({ action, request }));
          confirm(fingerprint, `Revoke ${request.title} for ${request.recipient} in ${scope.spec.project}/${scope.env}? Fields: ${request.keys.join(', ')}. This erases unconsumed values; it does not rotate imported credentials.`);
          save({ ...grant, review: { ...grant.review!, pendingWrite: true } });
          writeAttempted = true;
          const result = await client.revoke(request.id);
          save({ ...grant, review: undefined });
          return commandSuccess(result, { hint: 'The server confirmed this revocation or terminal no-op. Previously imported credentials were not rotated.' });
        }
        let previous: CredentialRequest | undefined;
        let proposalInput = input;
        if (action === 'replace') {
          previous = await client.show(input.requestId!);
          if (!['consumed', 'expired', 'revoked'].includes(previous.status)) throw new HvError('VALIDATION', 'Only a consumed, expired or revoked request can be replaced. Revoke an active request separately before reassigning its fields.');
          if (previous.authentication !== 'email') throw new HvError('VALIDATION', 'This replacement flow requires an email-owned request. Prepare a new reviewed email invitation for legacy GitHub requests.');
          if (input.fields?.some(field => !previous!.keys.includes(field.key))) throw new HvError('VALIDATION', 'A replacement may only re-request fields from the selected terminal request.');
          proposalInput = { ...input, ownerEmail: input.ownerEmail ?? previous.recipient, fields: input.fields ?? previous.fields.filter(field => requiredKeys === undefined || requiredKeys.includes(field.key)), title: input.title ?? previous.title };
          proposal = intent(proposalInput, scope, requiredKeys);
        }
        proposal ??= intent(input, scope, requiredKeys);
        if (!proposal) return commandSuccess({ status: 'not_required', environment: scope.env });
        const discovered = await client.fields(proposal.sourceBranch);
        if (discovered.source?.revision !== proposal!.expectedSourceRevision || discovered.source.digest !== proposal!.expectedSourceDigest
          || proposal!.fields.some(field => !discovered.availableFields.some(available => available.key === field.key)))
          throw new HvError('VALIDATION', 'The hosted branch does not match this committed spec and revision. Push or check out the reviewed source, then prepare again.');
        const fingerprint = hash(JSON.stringify({ action, projectId: grant.project.id, environmentId: grant.environment.id, planId: input.planId, ...(previous ? { previous } : {}), ...proposal }));
        requests ??= await listAll();
        for (const request of requests) {
          const matches = matchesProposal(request, proposal);
          if (matches && (['pending', 'ready'].includes(request.status) || (action === 'create' && request.status === 'consumed'))) return receipt(request);
          if (['pending', 'ready'].includes(request.status) && request.keys.some(key => proposal!.fields.some(field => field.key === key)))
            throw new HvError('VALIDATION', 'A different active request owns one of these fields. Review it with action="list"; revocation requires separate confirmation.');
        }
        const priorRequestIds = requests.filter(request => matchesProposal(request, proposal!, true)).map(request => request.id);
        const currentScope = checkout(input);
        if (currentScope.root !== scope.root || currentScope.repository !== scope.repository || currentScope.env !== scope.env) throw new HvError('VALIDATION', 'The checkout scope changed during review. Prepare the invitation again.');
        const currentKeys = input.planId ? resolveCredentialPlanHandoff(context, { planId: input.planId, ...currentScope }).keys : undefined;
        const current = intent(proposalInput, currentScope, currentKeys);
        if (JSON.stringify(current) !== JSON.stringify(proposal)) throw new HvError('VALIDATION', 'The checkout changed during review. Prepare the invitation again.');
        confirm(fingerprint, `${previous ? `Re-request credentials after ${previous.status} request ${previous.id}. This sends a new invitation, not another retrieval. ` : ''}Send ${proposal.title} to ${proposal.recipientEmail} for ${scope.spec.project}/${scope.env}? Fields: ${proposal.fields.map(f => `${f.key} (${f.label}, ${f.inputType})`).join(', ')}. Source: ${proposal.sourceBranch} at ${proposal.expectedSourceRevision}.`, proposal, priorRequestIds);
        grant = { ...grant, review: { ...grant.review!, proposal, priorRequestIds, pendingWrite: true } }; save(grant);
        writeAttempted = true;
        const result = await client.create(proposal!);
        save({ ...grant, review: undefined });
        return commandSuccess({ ...result, ...(previous ? { replacesRequestId: previous.id } : {}) }, { hint: 'Invitation queued, not confirmed delivered. Values stay in the recipient’s secure form. Resume checks readiness and provides separately approved private import calls.', next: ['hv_cloud_requests'] });
      } catch (error) {
        if (error instanceof HvError) {
          const rejected = z.object({ outcome: z.literal('rejected') }).safeParse(error.extras?.details).success;
          if (rejected || error.code === 'MISSING_CONNECTION') save({ ...grant, review: writeAttempted || !grant.review?.pendingWrite ? undefined : grant.review, ...(error.code === 'MISSING_CONNECTION' ? { expiresAt: new Date(0).toISOString() } : {}) });
        }
        throw error;
      }
    }));
}

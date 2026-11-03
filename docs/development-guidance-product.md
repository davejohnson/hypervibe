# Product and user experience

Read when changing onboarding defaults, user-facing guidance, provider setup UX, or operational reporting.

These are normative maintainer rules, complementary to `ARCHITECTURE.md`,
which remains the infrastructure model's source of truth. Load only the sections
relevant to the task. Paths in code spans are relative to the repository root.

Related contracts: [Product Model](../ARCHITECTURE.md#product-model), [Plan Honesty](../ARCHITECTURE.md#plan-honesty), and [Connections And Secrets](../ARCHITECTURE.md#connections-and-secrets).

Stable rule IDs preserve the original guidance and are mapped in
[the migration audit](development-guidance-migration.json). These files are
for developing Hypervibe; the distributed user workflow lives in
[`skills/hypervibe`](../skills/hypervibe/SKILL.md).

## Who we build and write for

Our primary customer is a **vibe coder**: someone building an app with a coding
agent who knows the outcome they want, but may have no experience with cloud
administration, deployment tools or security terminology. They should not need
to understand IAM, service accounts, federation, credential requests or our
internal states to connect and run their app. Write with respect for their
judgment; make the task clear without patronizing them.

The app builder, person paying for hosting, cloud administrator and person
providing a secret may be different people. Address the person taking the
current action. An administrator can inspect exact permissions without making
every app owner learn those details.

This applies to all customer-facing pages, local browser handoffs, emails,
notifications, chat, CLI/MCP explanations, approvals and errors—not only
onboarding. Keep stable machine contracts and useful, value-free diagnostics
for authorized agents; do not present those contracts as the human interface.

- **Lead with their goal and next action.** Name the app, environment and
  destination where they affect the decision. Explain what the button does
  now, who acts next and how the person knows they are done. A completion
  message must say whether to return to their agent, wait, or close the page.
- **Make the agent do the routine work.** Use supported APIs and choose safe
  defaults. Ask the person for facts only they know, browser sign-in, externally
  owned secrets, or meaningful consent. Do not turn internal setup steps,
  missing automation or recovery bookkeeping into a checklist of user chores.
- **Use familiar, concrete words.** Prefer “ask someone for this app's API key”
  to “manage credential requests.” Name an API key or password when that is
  what is needed; explain “secret” as private app configuration when necessary.
  Avoid “principal,” “scope,” “provision,” “reconcile” and similar terms in
  primary copy unless the person needs the term to make this decision.
- **Design the choice, not a wall of explanation.** Give each step one clear
  primary action. Present alternatives, such as signing in yourself or inviting
  an administrator, as alternatives. Put exact IAM resources, internal IDs,
  revisions and setup-step counts in optional details unless an identifier is
  needed to distinguish the destination or verify consent. Keep material costs,
  access, recipients and consequences visible beside the action.
- **Explain errors from evidence.** Say what Hypervibe could not do, what
  remains saved or incomplete, and the next supported action. Do not blame the
  person's account for a failure in Hypervibe's hosted access. Do not turn an
  unknown result into “permission denied,” “nothing happened” or “try again.”
  A refresh, retry or administrator invitation must be safe and relevant to the
  observed failure; internal reason codes alone are not useful instructions.
- **Make handoffs self-contained.** Invitations say who is asking, which app
  and environment need help, what is requested, and where to act. A person
  opening an email or deep link should not need the coding conversation.
  Never include secret values in this context.
- **Simplify without changing the truth.** Keep real authorization boundaries,
  cost implications and uncertainty. Use existing approval for unchanged
  authorized work; do not ask again merely because an IAM step appears.
  Plain language is not permission to widen access, hide spending, bypass a
  required approval, or claim deployment from sign-in or successful setup.

Examples of the intended direction, used only when the underlying state and
action support them:

| Internal framing | Customer-facing framing |
| --- | --- |
| “Manage credential requests?” | “Let your coding agent request secrets” followed by what it can ask for and from whom. |
| “Installation needs attention. Check its recorded result.” | “Cloud setup hasn't finished” with the supported progress or recovery action beside it. |
| “Source required” | “Cloud setup is complete. Return to your coding agent to finish connecting this environment.” |
| “Administrator invitation” | “Sam asked you to connect Google Cloud for Sequence's staging environment.” |

Before shipping, check whether a first-time person can tell what this is for,
what they need to decide, what to do next and what that action changes. For a
substantial flow, use the product-design workflow, inspect real mobile and
desktop screens, and get a separate clarity review. Passing render tests or
shortening sentences does not establish that the experience is understandable.

## DG-001

When the user must complete a web form, lead with a direct clickable form URL. Pre-fill every officially supported non-secret field whose value is known or can be safely inferred: name, description, owner/account, repository/project, expiry, and the permissions needed for the task. Use meaningful, consistent Hypervibe labels identifying the credential's purpose and known scope. Preserve the complete query string from tool-provided links; never shorten it to a dashboard URL or replace an available direct link with a click-by-click navigation checklist. Use documented parameter names and URL-encode values; never invent unsupported parameters or put secrets in URLs. Briefly identify fields that still require manual input, review, or consent.

## DG-002

GitHub PAT links must be role-specific, with the name/description and required classic scopes or fine-grained permissions pre-filled. Keep every PAT role covered by regression tests. For other providers, use officially documented credential-template URLs with all applicable known fields and least-privilege permissions; explicitly identify permissions or fields the template cannot represent. Provider-owned bootstrap and browser authentication still take precedence when available.

## DG-003

Never require another person's approval to merge by default on any repository. Enable mandatory reviews only when the user explicitly requests them, and explain that they prevent merging without another person's approval. Do not infer this choice from requests for code safeguards, automated checks, or the presence of collaborators. Preserve existing owner-chosen review policies unless the user asks to change them.

## DG-004

Explain infrastructure changes by their practical benefit. For example, say "I'll help protect your code on GitHub from accidental overwrites" instead of "enable branch protection on main." Explain reviews or automated checks in everyday language when they affect how the user publishes changes.

## DG-005

For routine safeguards already declared in the project or authorized by the user, explain the benefit and proceed through spec/plan/apply. Do not ask for another confirmation just because a technical setting appears in the plan. Preserve explicit user choices and confirmations required for consequential changes.

A reviewed connect/deploy task includes routine narrow setup permissions inside its exact scope. Show account, resources, access and costs together; do not turn each grant into another human question. Supply all required exact action IDs together after checking existing authorization. A missing machine confirmation or refreshed login does not itself require renewed human consent. New or changed effects still need review; separate setup, deployment, device, collection, secret-submission and runtime-reading authority remains enforced, and uncertain writes require read-only recovery.

## DG-006

Make routine decisions instead of asking users to design infrastructure. Infer the application name and runtime from the repository, reuse verified connections when their resource scope belongs to the selected project, and choose supported, economical defaults. Do not ask users to approve ordinary names, suffixes, or other reversible implementation details.

## DG-007

When the application declares owner/contact settings, infer initial non-secret defaults from the repository's git identity and persist the reviewed values in its spec. Git identity is a starting default, not proof of application ownership or authority to overwrite an existing owner. Do not hard-code application-specific env names in hosting adapters. Show managed runtime keys as value-free dotenv documentation; never copy generated secrets into local files.

## DG-008

For a new web project without an existing environment policy, prepare `production` and `staging` together under the application project and state the proposed setup directly. Keep logical resource names simple (`web`, `documents`); do not concatenate project/environment suffixes when the provider already supplies that namespace. Add uniqueness only to provider identifiers that require it, and preserve existing names, durable bindings, and explicit user choices. Keep staging data, secrets, and scoped resource identities isolated from production; do not add databases, caches, or other paid services the application does not need.

## DG-009

Surface cross-environment resource notes before claiming one environment validates another. Explain omitted workloads, storage or integrations and confirm consequential changes; differences may be intentional, so never silently copy resources or production identities to make the note disappear.

## DG-010

Prefer HTTPS, private datastores, least-privilege workload identities, generated application secrets, managed CI deploys, and economical staging capacity wherever implemented. Explain any unsupported or blocked part honestly instead of presenting an intended default as completed infrastructure.

## DG-012

Hide provider setup complexity behind the desired-state lifecycle where possible. Automatically discover unambiguous authorized account and billing scope, derive valid resource names, and plan required project creation, API enablement, identity setup, and runtime wiring through declared provider capabilities. A Hypervibe environment is not a GCP project; do not confuse their names or assume that a connection to another application's cloud project authorizes using it.

## DG-013

Ask only for missing access, genuinely ambiguous ownership or billing choices, external-party secrets, or consequential approvals required by the lifecycle contract. Present a concrete plan with the chosen defaults and cost implications before asking for those approvals. Naming defaults never authorize spending, billing attachment, adoption, or destructive changes.

## DG-014

When a missing capability forces a user to perform routine provider setup manually, treat it as an onboarding product gap to fix in the shared application/provider path. Do not normalize repeated dashboard chores, credential copying, or provider-specific questionnaires as the deployment experience.

## DG-081

Work stage-by-stage. After any blocked, failed, pending, or confirmation-required Hypervibe result, stop dependent mutations and report the actual receipts. An explicit read-only continuation for pending work may inspect its retained identities without another user approval; it cannot replay uncertain writes or authorize dependent mutations. Preserve existing approvals for unchanged actions and request confirmation for new or changed consequential actions. Otherwise report the blocker and the next decision needed from the user. Do not keep trying alternate tools, bypasses, or provider-specific workarounds unless the user explicitly asks you to investigate broadly or keep iterating.

## DG-082

Use `hv_inspect` for read-only provider forensics. Use `hv_import` only when the user explicitly wants to adopt existing provider infrastructure into Hypervibe local/repo state.

## DG-084

Deployment declarations describe managed resources, not every service an application uses. Discover configuration only from bounded, exact-scope observation; return requested key presence without values, and never equate presence with credential validity, active usage, monitoring access or health. Duplicate resource identities and malformed provider responses must remain unknown, never complete or checked-empty.

## DG-086

Never ask a user to invent an opaque application secret that Hypervibe can generate safely. Declare a Hypervibe-owned, versioned generator in the spec, derive a strong per-project/per-environment value inside the encrypted plan boundary, and install it automatically. Require user input only when an external party owns the value; confirmation is still required before replacing accepted live state with meaningful session, encryption, cost, or data consequences.

## DG-092

Prefer `credentialsRef` with exported environment variables, `dotenv:` references, local JSON files, or secret-manager refs when asking users for credentials. Raw credentials in chat are still accepted when the user intentionally chooses that path.

## DG-096

Token and permission guidance must include the exact credential type, official creation URL, required permissions/scopes, resource scope, caveats, and a safe `hv_connections` example.

## DG-097

For an application's SendGrid sending key, give the [exact runtime-key instructions](email-sender-readiness.md#application-sending-key-permissions): Restricted/Custom Access, Mail Send > Mail Send > Full Access (`mail.send`), and every other permission No Access. Use separate keys per project/environment. Keep Hypervibe management and diagnostic credentials separate from application runtime; request additional scopes only for the corresponding operation. Never widen a sending key just to satisfy connection setup or sender-readiness checks, and never describe a sending-only key as sufficient for a Hypervibe management connection.

## DG-132

Whenever a GitHub PAT is required, provide a role-specific pre-filled creation URL with its name/description and required scopes or fine-grained permissions already selected. Never send users only to a generic GitHub token settings page; keep every PAT role covered by regression tests.

## DG-133

Whenever a provider officially documents credential-template URLs, use them with the known required name and least-privilege permissions pre-filled. Do not reverse-engineer undocumented dashboard parameters; call out any optional permissions the official template cannot represent.

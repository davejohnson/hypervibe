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

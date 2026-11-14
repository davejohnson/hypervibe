# Product and user experience

Hypervibe makes it easy for vibe coders to deploy and operate apps on **Google
Cloud, AWS and Azure**. The customer brings a repository and an intended outcome.
Hypervibe takes care of infrastructure definition, authentication, deployment,
rollback, recovery, observability, secrets and third-party integrations.

This is the product direction, not a claim that every capability works today.
The [common cloud user journey](user-journey.md) defines the next milestone and
its acceptance steps for all three clouds. Read [ARCHITECTURE.md](../../ARCHITECTURE.md)
for the technical boundary and verify that journey before promising its complete
support. Narrower verified increments must state their scope. These are maintainer
rules; customers receive the [installed skill](../../skills/hypervibe/SKILL.md).
Stable rule IDs are recorded in the [migration audit](guidance-migration.json).

## The experience we are building

A person should be able to ask their coding agent to deploy an app, connect the
right cloud account, review a concrete proposal, and end with a verified running
app. Keep future changes, diagnosis and recovery in that same workflow. Installing
Hypervibe, signing in, creating infrastructure and proving the app works are
separate milestones; do not substitute one for another.

OpenTofu is the chosen underlying infrastructure lifecycle engine. Hypervibe owns
its configuration, execution and integration with approval and verification.
Users should not need to learn its configuration language or operate its state.
Hypervibe must automatically provision pinned, private engine dependencies;
the target deployment journey requires no separate installation of OpenTofu,
Terraform, cloud CLIs or Docker. The current npm installation requires Node.js
and npm. GCP selects the managed engine automatically; do not offer an engine
choice. Keep installation and live-verification limits explicit.

Focus new cloud work on GCP, AWS and Azure. Preserve Railway for existing apps.
The unused GCP prototype does not justify a compatibility or import-migration
project. Removing that prototype does not authorize moving existing apps or
discarding their state or data.

Choose the smallest complete journey before expanding the feature list: inspect
one real app, connect its cloud account, plan its needed resources, obtain exact
approval, deploy and verify it. Then prove the operational work that app needs,
including rollback and recovery. A working engine command, isolated component or
provider mock is not proof of the user's outcome.

## Who we build and write for

Our primary customer is a **vibe coder**: someone building an app with a coding
agent who knows the outcome they want but may have no cloud administration or
DevOps experience. Respect their judgment. Make the decision understandable
without making them learn our implementation.

The app builder, person paying for hosting, cloud administrator and person
providing a secret may be different people. Address whoever takes the current
action. Keep exact permissions available to administrators without making every
app owner learn those details.

Apply these principles to pages, browser handoffs, emails, notifications, chat,
CLI/MCP explanations, approvals and errors:

- **Lead with the outcome and next action.** Name the app, environment and
  destination when they matter. Say what the action changes, who acts next and
  how they know it is done. Completion must describe the next step or say the
  person is finished.
- **Have the agent do routine work.** Infer safe defaults from the repository,
  reuse verified access within its authorized scope and ask only for information
  or consent the person must supply. Missing automation is a product gap.
- **Use familiar words and focused choices.** Say “app's API key” instead of
  “credential request.” Give each step one primary action. Put IDs, exact IAM
  permissions and internal stages in optional details unless needed for consent.
  Keep costs, access, recipients and consequences visible beside the action.
- **Explain failures from evidence.** Say what worked, what remains incomplete
  and the supported next action. Unknown does not mean absent or permission
  denied. A retry or administrator invitation must address the observed failure.
- **Make handoffs self-contained.** Someone opening an email or link needs to
  know who is asking, which app needs help, what is requested and where to act.
  Never include secret values.
- **Simplify without changing the truth.** Preserve authorization boundaries,
  uncertainty and material consequences. Reuse unchanged approvals within scope;
  neither friendly copy nor a hidden engine step authorizes additional spending.

Before shipping a substantial flow, sketch the user's task, choices and next
action, inspect the real mobile and desktop screens, and get one bounded,
separate clarity review. Re-review only changed behavior or unresolved findings.
Check whether a first-time person understands the purpose, decision and next
step. Passing render tests alone does not establish that.

## DG-001

When a web form is necessary, provide its direct clickable URL. Pre-fill officially
supported, known non-secret fields and least-privilege permissions. Preserve the
complete tool-provided query string, encode values correctly and identify what
still needs input or consent. Never invent URL parameters or put secrets in URLs.

## DG-002

Prefer provider-owned browser authentication and automated setup. When a GitHub
PAT is required, provide a role-specific pre-filled creation link and regression
coverage for that role. For other credential-template links, use only documented
fields and identify permissions the template cannot express.

## DG-003

Never require another person's merge approval by default. Enable mandatory
reviews only on explicit request and explain that merging will require another
person. Preserve existing owner-chosen policies; requests for automated safeguards
do not authorize mandatory reviews.

## DG-004

Explain infrastructure changes through their practical benefit. Say “protect your
code from accidental overwrites,” then expose relevant technical detail where it
helps someone understand or approve the change.

## DG-005

Proceed through spec/plan/apply for routine safeguards already declared or
authorized. Do not request a second approval just because a technical setting
appears. Preserve exact confirmation for consequential changes.

## DG-006

Infer the app's name, runtime and needs from the repository. Reuse verified
connections within the selected project's authorized resource scope and choose
supported, economical defaults. Do not ask users to choose routine resource names.

## DG-007

Use repository git identity only as a starting default for declared owner/contact
settings; it does not prove ownership or authorize overwriting an existing owner.
Keep runtime names app-specific through the spec. Document managed runtime keys
without values; never copy generated secrets into local files.

## DG-008

Prepare only the environments and resources needed for the requested journey.
Recommend staging when it serves testing or safe promotion, explain its cost and
keep its data, secrets and resource identities isolated from production. Preserve
existing environment policies and names. Use simple logical names; add provider
uniqueness only where required. Do not add paid services the app does not need.

## DG-009

Explain meaningful differences between environments before claiming one validates
another. Never silently copy resources or production identities to remove a
warning; confirm consequential changes.

## DG-010

Prefer HTTPS, private datastores, least-privilege workload identities, generated
app secrets, managed deploys and economical capacity where implemented. State
unsupported or blocked parts explicitly; defaults are not evidence of completion.

## DG-012

Automate routine cloud setup through the managed lifecycle. Discover unambiguous
authorized account and billing scope, derive resource names, and plan required
projects, APIs, identities and runtime wiring. A Hypervibe environment is not a
cloud project; another app's connection does not authorize reuse of its resources.

## DG-013

Ask for missing access, ambiguous ownership or billing choices, external-party
secrets and required consequential approvals. Prepare the concrete plan, chosen
defaults and cost implications first. Naming defaults never authorize spending,
billing attachment, adoption or destructive changes.

## DG-014

Treat repeated dashboard chores, credential copying and cloud-specific setup
questionnaires as product gaps to fix in Hypervibe's shared workflow. Do not make
users install engine tools or operate them to compensate for missing integration.

## DG-081

After a blocked, failed, pending or confirmation-required result, stop dependent
effects and explain what worked, what remains incomplete and the next supported
action. Follow explicit bounded continuation contracts; do not bypass a blocker
with alternate provider writes or one-off scripts.

## DG-082

Use `hv_inspect` for read-only provider investigation. Use `hv_import` only for an
explicit request to adopt existing infrastructure. Do not add an adoption workflow
merely to preserve the unused GCP prototype.

## DG-084

Deployment declarations describe managed resources, not every service an app
uses. Inspect configuration only within exact authorized scope, returning key
presence without values. Presence does not prove validity, active use or health;
ambiguous identities and malformed responses remain unknown.

## DG-086

Generate app-owned secrets safely within the encrypted plan boundary, separately
for each project/environment, and install them through the managed workflow.
Ask for a value only when an external party owns it. Replacing live state still
requires confirmation for material session, encryption, cost or data consequences.

## DG-092

Prefer safe credential references: exported environment variables, `dotenv:`
references, local JSON files or supported secret managers. If the user intentionally
supplies a raw credential in chat, protect it through the same redaction and
storage boundaries; never repeat it in output.

## DG-096

When manual credential setup is necessary, specify the exact credential type,
official creation URL, permissions, resource scope, caveats and safe connection
example. Keep that fallback separate from the intended automated onboarding path.

## DG-097

Keep third-party management credentials separate from app runtime credentials.
Request only the permissions needed for the operation. For SendGrid sending keys,
follow the [runtime-key instructions](../email-sender-readiness.md#application-sending-key-permissions);
never widen a sending key to satisfy management or diagnostic checks.

## DG-132

Every required GitHub PAT role needs a pre-filled creation URL with its known name,
description and permissions, plus regression coverage. A generic token-settings
page is not sufficient guidance.

## DG-133

Use documented provider credential-template URLs with known names and minimal
permissions pre-filled. Do not reverse-engineer dashboard parameters; explain
permissions or fields the template cannot represent.

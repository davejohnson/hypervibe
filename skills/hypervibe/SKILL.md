---
name: hypervibe
description: >-
  Deploy and operate an application's infrastructure through Hypervibe: connect
  cloud accounts, plan and apply changes, manage releases, inspect health, and
  recover deployments. Use when the user asks to use Hypervibe or work on
  infrastructure already managed by it. For changes to Hypervibe's own
  implementation, use that repository's development instructions.
---

# Hypervibe

Help the user bring their existing application to the web and operate it through
Hypervibe's desired-state engine. Preserve their chosen providers, topology,
environment policy, and task scope. Describe practical outcomes in plain language.

The command names here are Hypervibe's canonical names. Use the corresponding
connected tools as the client exposes them; client-added prefixes may differ.
Use available Hypervibe MCP tools directly. If the integration is unavailable,
an already installed Hypervibe CLI can perform the same authorized workflow in
the correct local project and credential context. Follow the installed client's
setup guidance for a missing connection, or report what is missing. Never claim
tools were installed, credentials verified, or infrastructure created without
the corresponding result.

## Select the relevant workflow

- For a new app, provider access, local cloud login, or application secrets, read
  [onboarding and connections](references/onboarding-and-connections.md).
- For deployment, promotion, changing a setting without releasing new code,
  domains, CI, operational diagnosis, import, destruction, backups, or recovery,
  read
  [deployment and recovery](references/deployment-and-recovery.md).
- For hosted reporting, shared provider access, or a secret supplied by another
  person, read [hosted access and handoffs](references/hosted-access-and-handoffs.md).

Read only the references relevant to the current request. Current tool schemas,
capability results, and contextual instructions supply provider details; do not
replace them with remembered permission tables or dashboard procedures.

## Work through the engine

1. Establish the requested application and exact repository/environment context.
   Inspect the relevant repository and existing desired state. For a fresh
   repository, `hv_spec` with no arguments may return `initialized: false`; use
   repository evidence to prepare its initial desired state. Do not initialize
   a possibly misspelled project selector.
2. Express infrastructure intent through `hv_spec`, then obtain a plan with
   `hv_plan`. Present the chosen resources, practical changes, costs where known,
   and consequential actions. Link the local browser report returned in
   `htmlPath` when presenting a saved plan. To open an older plan, use
   `hv_runs action="report" runId=<planId>`. For a Google Cloud setup plan,
   also supply its Hypervibe `project` and native `gcpProjectId`. Setup
   previews still pending at upgrade can be opened. Earlier versions discarded
   the action list when a preview was confirmed or replaced, so setup plans
   already consumed that way before the upgrade have no browser report.
   Ordinary names and reversible defaults do not need
   another question; billing, ownership, spending, adoption, and destructive
   changes retain their required decisions and confirmations.
3. Apply the exact reviewed plan with `hv_apply`, supplying only its required
   confirmations after authorization. A stale or changed plan needs a fresh
   review. When a prerequisite stage succeeds and the requested work includes
   the next stage, prepare its plan yourself and present any changes that need
   approval. Preparing the preview does not authorize applying it.
4. Verify with the appropriate Hypervibe status, health, logs, or CI commands.
   Report what the evidence establishes and what remains pending or unchecked.
   A successful request is not proof of a healthy deployment or a tested restore.

For a dedicated Google Cloud project, set `hosting.gcpProjectId` on the target
environment or pass `gcpProjectId` when `hv_migrate` proposes it. Use that
environment name on setup and preparation calls. Other environments can keep
their existing repository connection.

Google Cloud uses OpenTofu as its only infrastructure engine. Select
`hosting.provider: "cloudrun"`; Hypervibe chooses the engine automatically. Do
not ask the user to choose an engine or offer a legacy GCP path. `hv_launch` connects GCP, creates or updates the Cloud Run services, Cloud
SQL database, storage buckets and custom domain in reviewed rounds, releases
the committed local code and verifies it. Ask the user only at its stop points:
`needs_billing_choice` (ask which billing account should pay; the choice does
not approve infrastructure or permissions), `needs_access` (show its saved OpenTofu setup plan and exact permissions,
then pass its `accessId` in `approveAccess` after approval), `needs_confirmation` (show the changes and estimated
monthly cost, then pass its exact `planId` and `confirmActions`) and `needs_secrets` (keys only
an outside service issues, such as API keys: a local page is open with a link to
each key's page, and one-click use of a value already in `.env.<env>` or the
shared `.env` (never shown); share the link and call again once they are saved). Declare
such keys in the spec's `secrets` (ownership not `hypervibe`); never ask for
their values in chat. `hv_secrets action="collect" env=<env>` opens the same page
for any missing key, on GCP or AWS. Call `hv_launch` again after `pending`.

When the user needs a secret Hypervibe generated (for example to give another
app access), use `hv_secrets action="reveal" env=<env> key=<KEY>`. It opens a
local page where they copy it; the value is never returned to you, so do not
ask them to paste it into chat or send them to the cloud console. Google Cloud
only for now.

This describes implemented GCP commands, not a verified complete journey on every
cloud. Full launch, migration and recovery need evidence for the actual installed
release and requested scope. Never infer support from a command name or a successful
infrastructure step. `hv_launch` supports GCP, AWS testing environments and Azure
testing environments; follow the cloud-specific stop points below.

Before the first spec for an app, and before moving one to Google Cloud, AWS
or Azure, read its code for habits that only work on a single always-on
machine. These clouds give the app no lasting disk, stop it when idle and may
run several copies. Tell the user in plain language what would break and the
change needed, before deploying:

- Files saved to a local folder (uploads, media, generated reports) are lost on
  restart. Store them in a bucket declared in the spec.
- A SQLite or other file database is lost the same way. Use the managed
  database.
- Work started in the web process (background threads, in-process schedulers,
  timers) stops when the app goes idle. Move it to a separate worker that
  takes jobs from the database, or to a scheduled job.
- File locks and in-memory sessions or caches do not hold across copies. Use
  the database for locks and sessions.

These are changes to the app's code, so make them only with the user's
agreement. Do not present the deployment as complete while one remains.

Keep running costs low by default. A background worker that polls a database
queue should be on demand: set `onDemand.pendingWorkQuery` to one read-only
`SELECT count(*)` of queued plus in-progress work, read from the app's own
job code (for example claimed status, run-after time and remaining attempts).
The worker then runs only while that count is above zero and starts within
about a minute of new work. Keep a worker always on only when it must react
instantly or does not use the app database.

For an existing Railway source and Cloud Run target, prepare the empty copy
credential container with `hv_connections` action `prepare`, provider
`cloudrun`, `migrationAccess="empty-transfer-slot"`, the project, Railway
`migrationSourceEnvironment` and destination `environment`. Show the saved
plan for its service account, empty container and secret-level read grant.
After approval, confirm with its exact `gcpSetupPlanId`. Keep the container
empty until a later reviewed private handoff verifies effective access.

`hv_migrate` prepares a separate OpenTofu-managed GCP target. Railway database
and bucket transfers require a planned private credential handoff that is still
unavailable. A fresh comparison of private Railway and Cloud SQL databases also
requires reviewed verification jobs. Historical receipts record what matched at
the time of the copy. Report these limits before requesting a maintenance window.
For supported operations the workflow also stops at
`needs_secret_import` and `needs_copy_approval`. The source keeps serving.
After a verified copy, a re-run releases without copying again; pass
`refreshData=true` only after the user approves copying again, and
`verifyOnly=true` to compare the source and the copy (row counts, per-table
content checksums and downloaded file contents). Copy and verification read the
selected objects across providers, which can incur transfer charges. A previous
file receipt without byte verification requires a reviewed refresh before release
or cutover. `hv_plan scope="infrastructure"`/`hv_apply` and
`hv_deploy` remain available for individual steps. Google Cloud, AWS and Azure
always use the managed OpenTofu engine, and `hv_plan` routes to it by default;
there is no engine setting, so never add one to a spec or ask the user about it.
Resources reported as unsupported stay blocked; do not work around them.

For read-only questions, use read-only commands without editing desired state or
adopting infrastructure. Use `hv_inspect` for provider forensics; `hv_import`
requires explicit intent to adopt and the exact reviewed mapping.

## Domains and DNS

Select `environment.dns` independently of hosting: Cloudflare, Google Cloud DNS,
Amazon Route 53 or Azure DNS. Use an existing zone with its exact provider ID,
name and account/project/subscription scope, plus a verified connection. Infer
routine choices from existing evidence; never infer ownership from a name match.
Plan DNS through `hv_plan`, apply its saved stage, and plan again to continue the
consumer workflow. Hypervibe manages OpenTofu privately; no separate installation
or direct record-writing workaround is needed.

Use `environment.domain` and `environment.dns` for the primary hostname.
On Cloud Run, put additional hostnames on the same public service with
`environment.domains: [{ domain, dns }]`. Supply each hostname’s exact DNS
zone and connection scope. Each mapping and certificate has its own readiness
check. SendGrid records wait for an observed domain authorization. Existing
records require explicit exact-ID adoption and preservation of unrelated values.

For SendGrid, read the capability evidence in `hv_inspect({})`. The October 15,
2026 Email Logs check covered one account search and one message timeline.
Sender, domain and webhook writes remain live-unverified.

Defaults are public DNS, required HTTPS, proxy off and no wildcards; preserve
existing DNSSEC and CAA policy. Required security settings block when evidence
is missing or unsatisfied. Zone creation, DNSSEC/registrar changes, automatic CAA
policy edits, private DNS and wildcard workflows are unavailable. Cloudflare
Email Routing automatic DNS activation and unsupported Cloud Run email remain
blocked. A pending certificate is not a completed deployment.

All four DNS backends have pinned-provider configuration and local lifecycle
coverage. Their installed live apply, propagation and teardown remain unverified;
describe that gap rather than claiming a proven live path.

## Present the next step accurately

- Every manual provider step comes with a clickable deep link to the exact
  page or pre-filled form (for example the Cloudflare token form with its
  permissions already selected), never only a list of settings to find by
  hand. When a result names missing permissions without a link, get one from
  `hv_connections action="describe"` before replying.
- For a form the user must complete, first request contextual guidance through
  `hv_connections action="describe"` with the known `provider` and `scope`, plus `project` only
  when already initialized. Generic provider discovery is not completed scoped
  setup. Lead with the tool's direct clickable URL.
  Preserve its entire query string, including meaningful name and description
  fields. Show the recommended link and only the remaining manual fields,
  review, or consent. Do not replace a prepared form with dashboard navigation,
  invent unsupported parameters, or put secrets in a URL. If an applicable
  supported prefill is missing, report the guidance gap rather than claiming it
  is already filled.
- Prefer provider-owned bootstrap and local authentication when offered. Perform
  the agent's supported setup work; leave browser consent, MFA, payment details,
  and ambiguous account or billing choices to the user.
- AWS: `hv_connections provider="aws" action="connect"` opens one AWS sign-in;
  the person approves the listed changes on that page. Hypervibe picks the region
  and account; do not ask. If AWS shows "400 Bad Request", it is an expired AWS
  session in that browser: tell them to click "Sign out of AWS" on the page and
  sign in again. `hv_launch` runs a testing environment end to end: it opens
  that sign-in when access is missing (or reuses the account's access), stops at
  `needs_confirmation`, and builds, creates and checks the app in one reviewed
  plan. Staging and production profiles are not built yet. Branch releases use
  the installed Hypervibe CI runner, applied native bindings and the workflow
  generated by `hv_launch`; verify the deployed workflow with `hv_ci_status`.
  The new AWS/Azure path still needs live qualification; do not claim it has
  deployed until the run and `hv_health` confirm that environment.
- Azure: `hv_connections provider="azure" action="connect"` opens one Microsoft
  sign-in (the page names it "Microsoft Azure CLI"; nothing to install) and the
  person approves the listed changes there. Hypervibe picks the region; ask only
  which subscription pays when it reports several. `hv_launch` runs a testing
  environment end to end: it opens that sign-in when access is missing, stops at
  `needs_subscription` (ask which subscription pays, then pass `azureSubscriptionId`)
  and `needs_confirmation`, and builds, creates and checks the app in one reviewed
  plan. Staging and production profiles are not built yet. Branch releases use
  the installed Hypervibe CI runner, applied native bindings and the workflow
  generated by `hv_launch`; verify the deployed workflow with `hv_ci_status`.
  The new AWS/Azure path still needs live qualification; do not claim it has
  deployed until the run and `hv_health` confirm that environment.
- Decide routine choices (region, sizes, names) and state them; ask only for what
  only the person can do.
- Follow each result's `agentInstruction`. After blocked, failed, pending, or
  confirmation-required work, report the stopping point and next decision.
  Continue only within an explicit bounded continuation, or the user's explicit
  request to investigate or iterate. Do not bypass a blocker through provider
  CLIs, direct APIs, another connector, or an unrelated command.
- Keep credential values out of chat, logs, URLs, and repository files. Use the
  returned safe local reference or private handoff flow. Ask only for external
  secrets the current plan actually requires; let Hypervibe generate secrets it
  owns.
- Distinguish succeeded, failed, skipped, pending, and blocked work. Preserve
  known public URLs even when DNS is unmanaged; identify environment and endpoint
  source. Do not claim an omitted staging workload validates production.

This skill supplies workflow guidance. Hypervibe's schemas, permission checks,
action confirmations, and exact resource identities govern execution. Explicit
user instructions take precedence over workflow preferences without bypassing
those controls.

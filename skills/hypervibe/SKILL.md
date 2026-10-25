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
- For deployment, promotion, domains, CI, operational diagnosis, import,
  destruction, backups, or recovery, read
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
   and consequential actions. Ordinary names and reversible defaults do not need
   another question; billing, ownership, spending, adoption, and destructive
   changes retain their required decisions and confirmations.
3. Apply the exact reviewed plan with `hv_apply`, supplying only its required
   confirmations after authorization. A stale or changed plan needs a fresh
   review. Follow explicit prerequisite stages before dependent work.
4. Verify with the appropriate Hypervibe status, health, logs, or CI commands.
   Report what the evidence establishes and what remains pending or unchecked.
   A successful request is not proof of a healthy deployment or a tested restore.

For read-only questions, use read-only commands without editing desired state or
adopting infrastructure. Use `hv_inspect` for provider forensics; `hv_import`
requires explicit intent to adopt and the exact reviewed mapping.

## Present the next step accurately

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

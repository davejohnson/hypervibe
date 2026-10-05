# Deployment product and import design

Paths are relative to the repository root. Read when the matching task in `AGENTS.md` applies.

# Agent Notes

Read `ARCHITECTURE.md` before changing lifecycle, provider, plan/apply, deploy, database migration, DNS/domain, CI, connection, or secret-handling code. That file is the source of truth for Hypervibe's infrastructure model.

Hypervibe is an infrastructure creation, migration, and destruction orchestrator. It is not a loose collection of imperative provider functions.

Hypervibe is built for nontechnical vibe coders who want to bring their projects to life on the web. Optimize the product and agent experience for the easiest, fastest sensible path from an existing repository to a working deployment. Hypervibe should do the infrastructure work and explain the outcome in plain language.

Onboarding and deployment defaults:

- Make routine decisions instead of asking users to design infrastructure. Infer the application name and runtime from the repository, reuse verified connections when their resource scope belongs to the selected project, and choose supported, economical defaults. Do not ask users to approve ordinary names, suffixes, or other reversible implementation details.
- When the application declares owner/contact settings, infer initial non-secret defaults from the repository's git identity and persist the reviewed values in its spec. Git identity is a starting default, not proof of application ownership or authority to overwrite an existing owner. Do not hard-code application-specific env names in hosting adapters. Show managed runtime keys as value-free dotenv documentation; never copy generated secrets into local files.
- For a new web project without an existing environment policy, prepare `production` and `staging` together under the application project and state the proposed setup directly. Keep logical resource names simple (`web`, `documents`); do not concatenate project/environment suffixes when the provider already supplies that namespace. Add uniqueness only to provider identifiers that require it, and preserve existing names, durable bindings, and explicit user choices. Keep staging data, secrets, and scoped resource identities isolated from production; do not add databases, caches, or other paid services the application does not need.
- Surface cross-environment resource notes before claiming one environment validates another. Explain omitted workloads, storage or integrations and confirm consequential changes; differences may be intentional, so never silently copy resources or production identities to make the note disappear.
- Prefer HTTPS, private datastores, least-privilege workload identities, generated application secrets, managed CI deploys, and economical staging capacity wherever implemented. Explain any unsupported or blocked part honestly instead of presenting an intended default as completed infrastructure.
- For backup defaults and protection claims, read [the recovery contract](recovery.md).
- Hide provider setup complexity behind the desired-state lifecycle where possible. Automatically discover unambiguous authorized account and billing scope, derive valid resource names, and plan required project creation, API enablement, identity setup, and runtime wiring through declared provider capabilities. A Hypervibe environment is not a GCP project; do not confuse their names or assume that a connection to another application's cloud project authorizes using it.
- Ask only for missing access, genuinely ambiguous ownership or billing choices, external-party secrets, or consequential approvals required by the lifecycle contract. Present a concrete plan with the chosen defaults and cost implications before asking for those approvals. Naming defaults never authorize spending, billing attachment, adoption, or destructive changes.
- When a missing capability forces a user to perform routine provider setup manually, treat it as an onboarding product gap to fix in the shared application/provider path. Do not normalize repeated dashboard chores, credential copying, or provider-specific questionnaires as the deployment experience.


## Design Principles

### Let LLMs Handle Fuzzy Matching

Tools should return raw data and let Claude interpret it. Don't hardcode complex pattern matching logic.

**Good:**
```json
{
  "environments": [
    { "name": "prod-us-east", "providerId": "..." },
    { "name": "staging-v2", "providerId": "..." }
  ]
}
```

Claude interprets "prod-us-east" as production, "staging-v2" as staging.

**Bad:**
```typescript
// Don't do this - hardcoded patterns
if (name.includes('prod') || name.startsWith('p-')) {
  return 'production';
}
```

### Simple Shortcuts Are OK

Exact matches for common names are fine for speed:
- `production` → production
- `staging` → staging
- `development` → development

Anything else? Return raw data, let Claude figure it out.

### Two-Step Import Flow

1. First call returns raw data for Claude to interpret
2. Claude analyzes, asks user if needed, then calls again with mappings
3. Second call performs the actual import

This keeps tools simple and leverages Claude's intelligence.

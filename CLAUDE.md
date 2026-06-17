# Hypervibe - Claude Code Guidelines

## Behavioral Guidelines

Guidelines to reduce common LLM coding mistakes. Bias toward caution over speed. For trivial tasks, use judgment.

### Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## Design Principles

### Let LLMs Handle Fuzzy Matching

Tools should return raw data and let Claude interpret it. Don't hardcode complex pattern matching logic.

**Good:**
```json
{
  "environments": [
    { "name": "prod-us-east", "railwayId": "..." },
    { "name": "staging-v2", "railwayId": "..." }
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

## Architecture

- **Tools** (`src/tools/`): the pinned `hv_*` MCP tool surface (registered in `src/server.ts` via `ToolContext`); all responses use the `toolSuccess`/`toolError` envelope from `src/tools/respond.ts`
- **Spec** (`src/domain/spec/`): the desired-state document (`ProjectSpec`, revisioned in the `project_specs` table via `SpecStore`)
- **Plan** (`src/domain/plan/`): the reconciliation engine — observe live state, pure `diffEnvironment`, `ConvergeExecutor` with the planId handshake
- **Adapters** (`src/adapters/`): External integrations (Railway, GCP, secrets, DB)
- **Domain services** (`src/domain/services/`): orchestrators (deploy, bootstrap, import, rollback, domain)
- **Repositories** (`src/adapters/db/repositories/`): SQLite data access (JSON columns validated via `parseJsonColumn`)

Legacy `*.tools.ts` files that still exist but are not registered in `server.ts` are internal helper libraries pending extraction — do not register them or add new tools there.

## The spec → plan → apply loop

The core workflow is terraform-style:
1. `hv_spec_set` — write the desired state (single source of truth, revisioned)
2. `hv_plan` — observe live infrastructure (Railway/Cloud Run support observe; others fall back to local state marked `verified: false`), diff, persist the plan as a run → `planId`
3. `hv_apply planId=...` — rejects stale plans (spec revision advanced, live state changed, plan expired/already applied); data-bearing destroys run only with explicit `confirmDestroy` action ids
4. `hv_status` — read-only drift view

There is no approval workflow: the human gate is MCP client tool-call approval plus explicit `confirm` flags.

## Platform Bindings

Environments store provider bindings in `platformBindings` using generic keys only (legacy `railwayProjectId`/`railwayEnvironmentId` were migrated away in sqlite migration 7):
```typescript
{
  provider: "railway",
  projectId: "...",       // external project/app id on the provider
  environmentId: "...",   // external environment id (if supported)
  services: {
    "api": { serviceId: "...", url: "...", customDomains: [...] }
  }
}
```

## Environment Variables: Local Dev Exceptions

Some env vars should **not** be synced from prod/staging to local. Leave them empty (or unset) locally:

| Variable | Why |
|----------|-----|
| `RECAPTCHA_SITE_KEY` | reCAPTCHA blocks localhost; skip verification locally |
| `RECAPTCHA_SECRET_KEY` | Not needed without the site key |
| `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` | Frontend reCAPTCHA; skip locally |

These use the real encrypted keys in production and staging (synced via `recaptcha_sync`). Locally, the app should detect missing keys and bypass reCAPTCHA validation.

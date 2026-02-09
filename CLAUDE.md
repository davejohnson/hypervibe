# Infraprint - Claude Code Guidelines

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

- **Tools** (`src/tools/`): MCP tool definitions, input validation
- **Adapters** (`src/adapters/`): External integrations (Railway, secrets, DB)
- **Domain** (`src/domain/`): Business logic, entities, orchestrators
- **Repositories** (`src/adapters/db/repositories/`): SQLite data access

## Platform Bindings

Environments store Railway bindings in `platformBindings`:
```typescript
{
  railwayProjectId: "...",
  railwayEnvironmentId: "...",
  services: {
    "api": { serviceId: "..." }
  }
}
```

This links local entities to their Railway counterparts.

# Infraprint - Claude Code Guidelines

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

// Persisted in Google Cloud plans and returned to CLI and MCP callers. The HTML review
// gives these known planning notes a reader-facing explanation, including on re-export.
export const gcpInfrastructureNotes = {
  release: 'Infrastructure is planned by OpenTofu. Releasing application code is a separate step: run hv_deploy after this apply.',
  redis: 'Services are connected to Redis in the next infrastructure plan, once Hypervibe has published its URL.',
  database: 'Services are connected to the database in the next infrastructure plan, once Hypervibe has created its login. Run hv_plan scope="infrastructure" again after this apply.',
} as const;

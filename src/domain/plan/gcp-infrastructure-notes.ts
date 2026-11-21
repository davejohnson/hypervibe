// Persisted in Google Cloud plans and returned to CLI and MCP callers. The HTML review
// gives these known planning notes a reader-facing explanation, including on re-export.
export const gcpInfrastructureNotes = {
  release: 'Infrastructure is planned by OpenTofu. Releasing application code is a separate step: run hv_deploy after this apply.',
  redis: 'Services are connected to Redis in the next infrastructure plan, once Hypervibe has published its URL.',
  database: 'Services are connected to the database in the next infrastructure plan, once Hypervibe has created its login. Run hv_plan scope="infrastructure" again after this apply.',
} as const;

export const railwayTransferSetupNote =
  'This plan reserves an empty Google Cloud secret for the connection details the copy job will use to read your Railway database or documents. It stays empty until Hypervibe verifies that the copy job has permission to read it and your app does not. Data moves only after you approve a separate copy plan.';

export const railwayTransferIsolationNote =
  'The two permissions reviewed here belong to the app. The narrower grants exclude the Railway copy secret and the contents of temporary database exports. The app can still list file names in the bucket. The secret stays empty until Hypervibe separately verifies what the app and copy job can actually read.';

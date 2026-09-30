export const privateProviderDetail = 'synthetic-private-provider-token-and-detail';

/** Reconstructed errors, not captured live failures. The pinned official CLI
 * f60f3a7 src/client.rs parse_graphql_response recognizes "not authorized";
 * controllers/workflow.rs documents workflow-specific authorization refusal.
 * Successful malformed payloads deliberately violate the pinned SDL.
 */
export const checkpointObservationFailures = [
  { name: 'GraphQL authorization refusal', category: 'authorization', httpStatus: 200,
    respond: () => Response.json({ errors: [{ message: `Not Authorized: ${privateProviderDetail}` }] }) },
  { name: 'HTTP authorization refusal', category: 'authorization', httpStatus: 403,
    respond: () => Response.json({ errors: [{ message: privateProviderDetail }] }, { status: 403 }) },
  { name: 'HTTP rate limit', category: 'rate_limit', httpStatus: 429,
    respond: () => Response.json({ errors: [{ message: privateProviderDetail }] }, { status: 429 }) },
  { name: 'GraphQL schema rejection', category: 'schema', httpStatus: 200,
    respond: () => Response.json({ errors: [{ message: privateProviderDetail,
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED', detail: privateProviderDetail } }] }) },
  { name: 'HTTP provider failure', category: 'provider', httpStatus: 503,
    respond: () => Response.json({ errors: [{ message: privateProviderDetail }] }, { status: 503 }) },
  { name: 'unclassified GraphQL rejection', category: 'provider', httpStatus: 200,
    respond: () => Response.json({ errors: [{ message: privateProviderDetail,
      extensions: { code: privateProviderDetail }, path: [privateProviderDetail] }] }) },
  { name: 'transport rejection without diagnostic evidence', category: 'unknown',
    respond: (): Response => { throw new TypeError(privateProviderDetail); } },
  { name: 'malformed successful response', category: 'invalid_response',
    respond: () => Response.json({ data: { workflowStatus: { status: privateProviderDetail } } }) },
] as const;

// Reconstructed Service JSON, not a recorded provider payload. Service.config may
// include documentation and API definitions with no published response-size cap.
// https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services
// https://docs.cloud.google.com/apis/docs/system-parameters (fields filtering)
export const largeServiceConfig = { documentation: { summary: 'Synthetic API documentation. '.repeat(50_000) } };
export function serviceUsageResponse(url: URL, name: string, state: unknown = 'ENABLED', options: { ignoreMask?: boolean; omitState?: boolean } = {}) {
  const service = { name, parent: name.split('/services/')[0], config: { name: name.split('/services/')[1], ...largeServiceConfig },
    ...(options.omitState ? {} : { state }) };
  const fields = options.ignoreMask ? null : url.searchParams.get('fields');
  if (fields === 'name,state') return Response.json({ name, ...(options.omitState ? {} : { state }) });
  if (fields === 'name,parent,config/name,state') return Response.json({ ...service, config: { name: service.config.name } });
  return Response.json(service);
}

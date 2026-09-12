export function serviceInstanceInventory(projectId: string, serviceId: string, environmentIds: string[]) {
  return { service: {
    id: serviceId,
    projectId,
    serviceInstances: {
      edges: environmentIds.map((environmentId) => ({ node: {
        id: `instance-${serviceId}-${environmentId}`, environmentId,
      } })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  } };
}

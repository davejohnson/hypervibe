/** Shared by direct reconciliation and emitted CI; retain all registered runtime settings. */
export function ecsTaskDefinitionInput(task: any, mainPatch: Record<string, unknown>, family?: string): any {
  if (!task?.family || task.networkMode !== 'awsvpc' || !task.requiresCompatibilities?.includes('FARGATE')
    || !Array.isArray(task.containerDefinitions)) throw new Error('ECS task definition is not an observable Fargate workload.');
  const main = task.containerDefinitions.filter((container: any) => container.name === 'Main');
  if (main.length !== 1 || main[0].portMappings?.length !== 1 || !main[0].portMappings[0].name
    || !main[0].portMappings[0].containerPort || ![undefined, 'tcp'].includes(main[0].portMappings[0].protocol)) {
    throw new Error('ECS Express task definition requires one Main container with one named TCP port.');
  }
  const keys = ['family', 'taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions', 'volumes', 'placementConstraints', 'requiresCompatibilities', 'cpu', 'memory', 'pidMode', 'ipcMode', 'proxyConfiguration', 'inferenceAccelerators', 'ephemeralStorage', 'runtimePlatform', 'enableFaultInjection'];
  return { ...Object.fromEntries(keys.filter((key) => task[key] !== undefined).map((key) => [key, task[key]])),
    ...(family ? { family } : {}),
    containerDefinitions: task.containerDefinitions.map((container: any) => container.name === 'Main' ? { ...container, ...mainPatch } : container),
  };
}

/** Self-contained mount identity proof used inside generated CI too. */
export function ecsVolumeFingerprint(task: any): string {
  function canonical(value: any): any {
    if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
  }
  if (!Array.isArray(task?.containerDefinitions) || !Array.isArray(task.volumes ?? [])) throw new Error('ECS volume configuration is unknown.');
  return JSON.stringify(canonical({ role: task.taskRoleArn, volumes: task.volumes ?? [], mounts: task.containerDefinitions.map((container: any) => ({ name: container.name, mounts: container.mountPoints ?? [], volumesFrom: container.volumesFrom ?? [] })) }));
}

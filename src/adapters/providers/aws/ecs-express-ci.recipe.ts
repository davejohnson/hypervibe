import { ecsInstalledConfigurationRuntime } from './ecs-installed-configuration.js';
import { ecsCurrentConfiguration, ecsTaskDefinitionInput } from './ecs-volume-runtime.js';

/** Shared generated release logic: a task-definition update must retain storage and runtime identity. */
export function buildEcsExpressTaskDefinitionRuntime(installed = false): string {
  return `const { DescribeTaskDefinitionCommand, RegisterTaskDefinitionCommand } = require('@aws-sdk/client-ecs');
${installed ? ecsInstalledConfigurationRuntime() : ''}${ecsTaskDefinitionInput.toString()}
${ecsCurrentConfiguration.toString()}
function ecsRegistrationInput(definition, tags) {
  return { ...ecsTaskDefinitionInput(definition, {}), ...(tags?.length ? { tags } : {}) };
}
function ecsPreserves(expected, observed) {
  if (Array.isArray(expected)) return Array.isArray(observed) && expected.length === observed.length && expected.every((value, i) => ecsPreserves(value, observed[i]));
  if (expected && typeof expected === 'object') return observed && typeof observed === 'object' && Object.entries(expected).every(([key, value]) => value === undefined || ecsPreserves(value, observed[key]));
  return expected === observed;
}
async function ecsReleaseContainer(client, config, serviceArn) {
  if (!config?.taskDefinitionArn) {
    if (!config?.primaryContainer) throw new Error('ECS returned no active container or task definition');
    return { container: config.primaryContainer, taskRoleArn: config.taskRoleArn${installed ? ', executionRoleArn: config.executionRoleArn' : ''} };
  }
  const arn = config.taskDefinitionArn;
  if (typeof arn !== 'string' || !arn.startsWith(serviceArn.split(':service/')[0] + ':task-definition/') || !/:\\d+$/.test(arn)) throw new Error('ECS task definition is outside the reviewed account or region');
  const response = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn, include: ['TAGS'] }));
  const definition = response.taskDefinition;
  if (definition?.taskDefinitionArn !== arn || definition.status !== 'ACTIVE'
    || arn !== serviceArn.split(':service/')[0] + ':task-definition/' + definition.family + ':' + definition.revision) throw new Error('ECS returned an invalid exact Express task definition');
  const input = ecsTaskDefinitionInput(definition, {});
  if (config.taskRoleArn !== undefined && config.taskRoleArn !== definition.taskRoleArn) throw new Error('ECS current task role disagrees with the exact task definition');
  return { container: input.containerDefinitions.find(item => item.name === 'Main'), definition, tags: response.tags, taskRoleArn: definition.taskRoleArn };
}
async function ecsPrepareRelease(client, config, serviceArn, exactImage, sha, digest${installed ? ', reviewed' : ''}) {
  const current = await ecsReleaseContainer(client, config, serviceArn);
${installed ? `  if (!reviewed) throw new Error('Installed ECS release configuration is unavailable');
  if (current.container.image === ECS_BOOTSTRAP_IMAGE) {
    if (!ecsInstalledBootstrapConfiguration(current.container, current.taskRoleArn)
      || (current.definition?.executionRoleArn ?? current.executionRoleArn) !== reviewed.executionRoleArn
      || current.definition && !ecsInstalledBootstrapTask(current.definition)) throw new Error('Installed ECS bootstrap has application access');
    current.container = { ...current.container, environment: reviewed.environment, secrets: reviewed.secrets };
    current.taskRoleArn = reviewed.taskRoleArn;
    if (current.definition) current.definition = { ...current.definition, taskRoleArn: reviewed.taskRoleArn };
  } else ecsInstalledFinalConfiguration(current, reviewed);
` : ''}  const environment = [...(current.container.environment || [])].filter(item => !['HYPERVIBE_DEPLOY_SHA', 'HYPERVIBE_IMAGE_DIGEST'].includes(item.name));
  const marker = name => environment.find(item => item.name === name)?.value;
  const startCommand = ${installed ? 'reviewed.startCommand' : "marker('HYPERVIBE_START_COMMAND')"};
  const healthPath = ${installed ? "reviewed.healthCheckPath || '/'" : "marker('HYPERVIBE_HEALTH_CHECK_PATH') || config.healthCheckPath || '/'"};
  environment.push({ name: 'HYPERVIBE_DEPLOY_SHA', value: sha }, { name: 'HYPERVIBE_IMAGE_DIGEST', value: digest });
  const container = { ...current.container, image: exactImage, environment, ...(startCommand ? { command: ['sh', '-lc', startCommand] } : ${installed ? '{ command: [] }' : '{}'}) };
  const common = { serviceArn, healthCheckPath: healthPath, networkConfiguration: config.networkConfiguration, scalingTarget: config.scalingTarget };
  if (!current.definition) return { healthPath, taskRoleArn: current.taskRoleArn, update: { ...common, primaryContainer: container, executionRoleArn: config.executionRoleArn, taskRoleArn: current.taskRoleArn, cpu: config.cpu, memory: config.memory } };
  const registration = ecsRegistrationInput(current.definition, current.tags);
  registration.containerDefinitions = registration.containerDefinitions.map(item => item.name === 'Main' ? container : item);
  // RegisterTaskDefinition has no idempotency token: a lost acknowledgement must
  // stop this release, not create more revisions via implicit SDK retries.
  const registrationClient = new ECSClient({ ...client.config, retryStrategy: undefined, maxAttempts: 1 });
  const registered = await registrationClient.send(new RegisterTaskDefinitionCommand(registration));
  const arn = registered.taskDefinition?.taskDefinitionArn;
  const familyPrefix = current.definition.taskDefinitionArn.replace(/:\\d+$/, ':');
  if (typeof arn !== 'string' || !arn.startsWith(familyPrefix) || !/^\\d+$/.test(arn.slice(familyPrefix.length))) throw new Error('ECS did not acknowledge the exact task-definition family');
  const verified = await ecsReleaseContainer(client, { taskDefinitionArn: arn }, serviceArn);
  if (!ecsPreserves(registration, ecsRegistrationInput(verified.definition, verified.tags))) throw new Error('Registered ECS task definition did not preserve reviewed runtime configuration');
  return { healthPath, taskDefinitionArn: arn, taskRoleArn: current.taskRoleArn, update: { ...common, taskDefinitionArn: arn } };
}
`;
}

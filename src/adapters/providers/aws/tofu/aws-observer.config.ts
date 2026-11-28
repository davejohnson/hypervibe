import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { observerSubjects, type ObserverFederation } from '../../../../domain/spec/runtime-observation.js';
import type { AwsEngineInput } from './aws-engine.config.js';

export function awsObserverPolicies(input: Pick<AwsEngineInput, 'accountId' | 'prefix' | 'region'>, intent: ObserverFederation) {
  const subjects = observerSubjects(intent);
  const oidc = 'token.actions.githubusercontent.com';
  const ref = 'refs/heads/' + intent.branch;
  return {
    trust: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRoleWithWebIdentity',
      Principal: { Federated: 'arn:aws:iam::' + input.accountId + ':oidc-provider/' + oidc },
      Condition: { StringEquals: { [oidc + ':aud']: 'sts.amazonaws.com', [oidc + ':sub']: [subjects.legacy, subjects.immutable], [oidc + ':repository_id']: intent.repositoryId,
        [oidc + ':ref']: ref, [oidc + ':workflow']: 'Hypervibe observe (' + intent.environmentName + ')' } },
    }] },
    policy: awsObserverReadPolicy(input),
  };
}
/** STS also intersects the temporary session with this exact read-only policy. */
export function awsObserverReadPolicy(input: Pick<AwsEngineInput, 'accountId' | 'prefix' | 'region'>) {
  const scope = input.region + ':' + input.accountId;
  return { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: 'logs:FilterLogEvents', Resource: 'arn:aws:logs:' + scope + ':log-group:/hypervibe/' + input.prefix + '/tasks:*' },
      { Effect: 'Allow', Action: 'ecs:ListTasks', Resource: '*', Condition: { ArnEquals: { 'ecs:cluster': 'arn:aws:ecs:' + scope + ':cluster/' + input.prefix } } },
      { Effect: 'Allow', Action: 'ecs:DescribeTasks', Resource: 'arn:aws:ecs:' + scope + ':task/' + input.prefix + '/*' },
    ] };
}
export function addAwsObserverConfiguration(input: AwsEngineInput, files: EngineConfiguration['files'], resources: Record<string, EngineResourceMapping>) {
  for (const address of ['aws_iam_role.observer', 'aws_iam_role_policy.observer']) resources[address] = {
    actionId: 'identity:runtime-observer', kind: 'service', name: 'runtime observer', requiresConfirm: true,
  };
  if (!input.observation) return;
  const { trust, policy } = awsObserverPolicies(input, input.observation);
  files['observer.tf.json'] = { resource: {
    aws_iam_role: { observer: { name: input.prefix + '-observer', path: '/hypervibe/app/',
      permissions_boundary: 'arn:aws:iam::' + input.accountId + ':policy/hypervibe/hypervibe-app-boundary',
      assume_role_policy: JSON.stringify(trust) } },
    aws_iam_role_policy: { observer: { name: 'observe', role: '${aws_iam_role.observer.id}', policy: JSON.stringify(policy) } },
  } };
}

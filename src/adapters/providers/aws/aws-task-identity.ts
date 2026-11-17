/** ECS families come only from an already recorded native task-definition ARN. */
export function taskDefinitionIdentity(value: string | undefined): { familyArn: string; family: string; revision: number } | undefined {
  const match = value?.match(/^(arn:aws:ecs:[a-z0-9-]+:\d{12}:task-definition\/([A-Za-z0-9_-]+)):([1-9]\d*)$/);
  if (!match || !Number.isSafeInteger(Number(match[3]))) return undefined;
  return { familyArn: match[1]!, family: match[2]!, revision: Number(match[3]) };
}

export function matchesTaskDefinitionFamily(value: string | undefined, bound: string): boolean {
  const current = taskDefinitionIdentity(value); const recorded = taskDefinitionIdentity(bound);
  return !!current && !!recorded && current.familyArn === recorded.familyArn;
}

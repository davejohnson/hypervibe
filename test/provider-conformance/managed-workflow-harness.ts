export type JsonObject = Record<string, any>;

export function actionIdsRequiringConfirmation(planEnvelope: JsonObject): string[] {
  return (planEnvelope.data.actions as JsonObject[])
    .filter((action) => (
      action.requiresConfirm === true
      || action.billable === true
      || action.dataBearing === true
    ))
    .map((action) => action.id);
}

export function nonNoopActions(planEnvelope: JsonObject): JsonObject[] {
  return (planEnvelope.data.actions as JsonObject[])
    .filter((action) => action.type !== 'noop');
}

export function terminalReceiptFailures(applyEnvelope: JsonObject): JsonObject[] {
  return (applyEnvelope.data.receipts as JsonObject[] ?? [])
    .filter((receipt) => [
      'failed',
      'blocked',
      'skipped_requires_confirm',
    ].includes(receipt.status));
}

export function pendingInfrastructureReview(
  applyEnvelope: JsonObject
): { actionId: string; pullRequestUrl: string } | null {
  for (const receipt of applyEnvelope.data.receipts as JsonObject[] ?? []) {
    const pullRequestUrl = receipt.data?.pullRequestUrl;
    if (
      receipt.status === 'pending'
      && typeof receipt.actionId === 'string'
      && typeof pullRequestUrl === 'string'
      && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pullRequestUrl)
    ) {
      return { actionId: receipt.actionId, pullRequestUrl };
    }
  }
  return null;
}

export function selectTriggeredWorkflowRun(
  runs: JsonObject[],
  params: {
    existingRunIds: Set<number>;
    triggeredAfterMs: number;
  }
): JsonObject | null {
  const threshold = params.triggeredAfterMs - 60_000;
  return runs
    .filter((run) => (
      run.event === 'workflow_dispatch'
      && typeof run.id === 'number'
      && !params.existingRunIds.has(run.id)
      && Date.parse(run.createdAt) >= threshold
    ))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
    ?? null;
}

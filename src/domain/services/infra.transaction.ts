export interface InfraTransactionStep {
  id: string;
  label: string;
  resource: {
    provider: string;
    type: string;
    id?: string;
    name?: string;
    metadata?: Record<string, unknown>;
  };
  compensate: () => Promise<{ success: boolean; message?: string; error?: string }>;
}

export interface InfraTransactionRollbackResult {
  success: boolean;
  rolledBack: Array<{ id: string; label: string; resource: InfraTransactionStep['resource']; message?: string }>;
  failed: Array<{ id: string; label: string; resource: InfraTransactionStep['resource']; error: string }>;
}

export class InfraTransaction {
  private readonly steps: InfraTransactionStep[] = [];

  addStep(step: InfraTransactionStep): void {
    this.steps.push(step);
  }

  listResources(): Array<InfraTransactionStep['resource']> {
    return this.steps.map((step) => step.resource);
  }

  async rollback(): Promise<InfraTransactionRollbackResult> {
    const rolledBack: InfraTransactionRollbackResult['rolledBack'] = [];
    const failed: InfraTransactionRollbackResult['failed'] = [];

    for (const step of [...this.steps].reverse()) {
      try {
        const result = await step.compensate();
        if (result.success) {
          rolledBack.push({
            id: step.id,
            label: step.label,
            resource: step.resource,
            message: result.message,
          });
        } else {
          failed.push({
            id: step.id,
            label: step.label,
            resource: step.resource,
            error: result.error || result.message || 'Compensation failed',
          });
        }
      } catch (error) {
        failed.push({
          id: step.id,
          label: step.label,
          resource: step.resource,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      success: failed.length === 0,
      rolledBack,
      failed,
    };
  }
}

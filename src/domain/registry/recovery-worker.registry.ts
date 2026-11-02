import type { IRecoveryWorker } from '../ports/recovery-worker.port.js';

/** Worker-only composition; importing a helper must not initialize application state. */
export class RecoveryWorkerRegistry {
  private readonly drivers = new Map<string, IRecoveryWorker>();
  register(provider: string, driver: IRecoveryWorker): void {
    if (!/^[a-z][a-z0-9-]*$/.test(provider) || this.drivers.has(provider)) throw new Error('Invalid or duplicate recovery worker registration.');
    this.drivers.set(provider, driver);
  }
  get(provider: string): IRecoveryWorker | undefined { return this.drivers.get(provider); }
  providers(): string[] { return [...this.drivers.keys()].sort(); }
}

export const recoveryWorkerRegistry = new RecoveryWorkerRegistry();

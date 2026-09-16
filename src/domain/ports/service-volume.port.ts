/** Exact provider scope; a mount path alone never identifies owned storage. */
export interface ServiceVolumeTarget {
  projectId: string;
  environmentId: string;
  serviceId: string;
  mountPath: string;
}

export type ServiceVolumeObservation =
  | { state: 'absent' }
  | { state: 'present'; externalId: string; pendingDeletion: boolean }
  | { state: 'unknown'; reason: string };

export interface ServiceVolumeBinding {
  provider: string;
  target: ServiceVolumeTarget;
  state: 'creating' | 'identified' | 'bound';
  externalId?: string;
}

export interface ObservedServiceVolume {
  provider: string;
  target?: ServiceVolumeTarget;
  binding?: ServiceVolumeBinding;
  observation: ServiceVolumeObservation;
}

/** V1 retains data: no delete, adoption, move, resize or implicit deployment. */
export interface IServiceVolumes {
  observe(target: ServiceVolumeTarget, externalId?: string): Promise<ServiceVolumeObservation>;
  create(target: ServiceVolumeTarget): Promise<{
    success: boolean;
    externalId?: string;
    mutationAttempted: boolean;
    error?: string;
  }>;
}

/** Exact provider scope; a mount path alone never identifies owned storage. */
export interface ServiceVolumeTarget {
  projectId: string;
  environmentId: string;
  serviceId: string;
  mountPath: string;
  /** Provider-native non-secret coordinates, including immutable placement. */
  instanceScope?: Record<string, string>;
}

export type ServiceVolumeObservation =
  | { state: 'absent' }
  | { state: 'present'; externalId: string; pendingDeletion: boolean; ready?: boolean }
  | { state: 'unknown'; reason: string };

export interface ServiceVolumeComponentBinding {
  state: 'creating' | 'identified' | 'bound';
  externalId?: string;
}

export type ServiceVolumeBinding = {
  provider: string;
  target: ServiceVolumeTarget;
  state: 'creating' | 'identified' | 'bound';
  externalId?: string;
  components?: never;
} | {
  provider: string;
  target: ServiceVolumeTarget;
  state: 'staged';
  externalId?: never;
  components: Record<string, ServiceVolumeComponentBinding>;
};

export interface ServiceVolumeComponent {
  key: string;
  dependsOn: string[];
  operation: 'create' | 'update';
  billable: boolean;
  description: string;
  /** An already-ready shared prerequisite satisfies intent, not ownership. */
  sharedPrerequisite?: boolean;
}

export interface ServiceVolumeMutationReceipt {
  success: boolean;
  externalId?: string;
  mutationAttempted: boolean;
  error?: string;
}

export interface IStagedServiceVolumes {
  /** Select acknowledged backing storage for providers that mount at workload creation. */
  runtimeMount?(target: ServiceVolumeTarget, bindings: Record<string, ServiceVolumeComponentBinding>): {
    externalId: string; mountPath: string; target: ServiceVolumeTarget;
  } | undefined;
  resolveTarget(input: {
    environment: Pick<import('../entities/environment.entity.js').Environment, 'platformBindings'> | null;
    environmentSpec: import('../spec/spec.schema.js').EnvironmentSpec;
    serviceName: string;
    mountPath: string;
  }): Promise<ServiceVolumeTarget | undefined>;
  components(target: ServiceVolumeTarget): ServiceVolumeComponent[];
  observeComponent(target: ServiceVolumeTarget, key: string, bindings: Record<string, ServiceVolumeComponentBinding>): Promise<ServiceVolumeObservation>;
  /** Exactly one component mutation; prerequisites have separate reviewed actions. */
  applyComponent(target: ServiceVolumeTarget, key: string, bindings: Record<string, ServiceVolumeComponentBinding>): Promise<ServiceVolumeMutationReceipt>;
}

export interface ObservedServiceVolume {
  provider: string;
  target?: ServiceVolumeTarget;
  binding?: ServiceVolumeBinding;
  observation: ServiceVolumeObservation;
  components?: Array<{ component: ServiceVolumeComponent; observation: ServiceVolumeObservation }>;
}

/** V1 retains data: no delete, adoption, move, resize or implicit deployment. */
export interface IServiceVolumes {
  staged?: IStagedServiceVolumes;
  observe(target: ServiceVolumeTarget, externalId?: string): Promise<ServiceVolumeObservation>;
  create(target: ServiceVolumeTarget): Promise<ServiceVolumeMutationReceipt>;
}

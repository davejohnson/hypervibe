export type WorkloadKind = 'web' | 'worker' | 'cron';

export interface BuildConfig {
  workloadKind?: WorkloadKind;
  builder?: 'nixpacks' | 'dockerfile' | 'buildpack';
  dockerfilePath?: string;
  buildCommand?: string;
  watchPaths?: string[];
  startCommand?: string;
  releaseCommand?: string;
  healthCheckPath?: string;
  cronSchedule?: string;
  public?: boolean;
}

export interface EnvVarSpec {
  required?: string[];
  optional?: string[];
  secrets?: string[];
}

export interface Service {
  id: string;
  projectId: string;
  name: string;
  buildConfig: BuildConfig;
  envVarSpec: EnvVarSpec;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateServiceInput {
  projectId: string;
  name: string;
  buildConfig?: BuildConfig;
  envVarSpec?: EnvVarSpec;
}

export function serviceWorkloadKind(service: Pick<Service, 'name' | 'buildConfig'>): WorkloadKind {
  if (service.buildConfig.workloadKind) {
    return service.buildConfig.workloadKind;
  }

  if (service.buildConfig.cronSchedule) {
    return 'cron';
  }

  const name = service.name.toLowerCase();
  if (/cron|sched|schedule/.test(name)) {
    return 'cron';
  }
  if (/worker|queue|consumer|processor/.test(name)) {
    return 'worker';
  }

  return 'web';
}

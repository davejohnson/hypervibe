export interface BuildConfig {
  builder?: 'nixpacks' | 'dockerfile' | 'buildpack';
  dockerfilePath?: string;
  buildCommand?: string;
  watchPaths?: string[];
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

export function requiresProductionConfirm(project: { policies: Record<string, unknown> }, environmentName: string): boolean {
  const policies = project.policies ?? {};
  const protectedEnvs = Array.isArray(policies.protectedEnvironments)
    ? (policies.protectedEnvironments as unknown[]).map((v) => String(v).toLowerCase())
    : [];
  return protectedEnvs.includes(environmentName.toLowerCase());
}

export function isProtectedEnvironment(project: { policies: Record<string, unknown> }, environmentName: string): boolean {
  const protectedEnvs = Array.isArray(project.policies?.protectedEnvironments)
    ? (project.policies.protectedEnvironments as unknown[]).map((v) => String(v).toLowerCase())
    : [];
  return protectedEnvs.includes(environmentName.toLowerCase());
}

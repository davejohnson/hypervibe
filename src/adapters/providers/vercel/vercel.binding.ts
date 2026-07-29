export interface VercelScopeBinding {
  kind: 'team' | 'user';
  id: string;
  binding: string;
}

export interface VercelServiceBinding {
  scope: VercelScopeBinding;
  projectId: string;
  binding: string;
}

export function formatVercelScopeBinding(
  kind: 'team' | 'user',
  id: string
): string {
  return `${kind}:${id}`;
}

export function parseVercelScopeBinding(
  value: string
): VercelScopeBinding {
  const match = /^(team|user):([^:]+)$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid Vercel scope binding "${value}". Expected team:<team-id> or user:<user-id>.`
    );
  }
  const kind = match[1] as 'team' | 'user';
  const id = match[2]!;
  if (kind === 'team' && !/^team_[A-Za-z0-9]+$/.test(id)) {
    throw new Error(
      `Invalid Vercel team scope binding "${value}".`
    );
  }
  return {
    kind,
    id,
    binding: formatVercelScopeBinding(kind, id),
  };
}

export function formatVercelServiceBinding(
  scopeBinding: string,
  projectId: string
): string {
  const scope = parseVercelScopeBinding(scopeBinding);
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId)) {
    throw new Error(
      `Invalid Vercel project binding "${projectId}". Expected a durable prj_ project ID.`
    );
  }
  return `${scope.binding}:${projectId}`;
}

export function parseVercelServiceBinding(
  value: string
): VercelServiceBinding {
  const match = /^((?:team|user):[^:]+):(prj_[A-Za-z0-9]+)$/.exec(
    value.trim()
  );
  if (!match) {
    throw new Error(
      `Invalid Vercel service binding "${value}". Expected <scope-binding>:<prj-project-id>.`
    );
  }
  const scope = parseVercelScopeBinding(match[1]!);
  const projectId = match[2]!;
  return {
    scope,
    projectId,
    binding: formatVercelServiceBinding(scope.binding, projectId),
  };
}

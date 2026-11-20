// Launch the built server with a repository and database owned by the Swift test.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { SqliteAdapter } from '../../dist/adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../dist/adapters/db/repositories/project.repository.js';
import { ProjectSpecRepository } from '../../dist/adapters/db/repositories/spec.repository.js';
import { ConnectionRepository } from '../../dist/adapters/db/repositories/connection.repository.js';
import { projectSpecSchema } from '../../dist/domain/spec/spec.schema.js';

globalThis.fetch = async (url) => {
  if (String(url).endsWith('/actions/workflows')) return Response.json({ total_count: 1, workflows: [{ id: 101, name: 'Hypervibe / release', path: '.github/workflows/hypervibe-release.yml', state: 'active' }] });
  throw new Error('Offline companion contract test');
};
process.env.HYPERVIBE_SECRET_KEY = '00'.repeat(32);
// The client starts one server per operation; seed the repository and database once.
if (!existsSync('.git')) {
  mkdirSync('.git');
  mkdirSync('.hypervibe');
  SqliteAdapter.getInstance().migrate();
  const name = 'companion-contract';
  const scope = `example/${name}`;
  const gitRemoteUrl = `https://github.com/${scope}`;
  const project = new ProjectRepository().create({ name, gitRemoteUrl, defaultPlatform: 'railway' });
  const spec = projectSpecSchema.parse({ version: 1, project: name, gitRemoteUrl, environments: {
    staging: { hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web' } },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' } },
    // Promotes through CI from the release branch.
    production: { hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web' } },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'release', autoDeploy: false, promoteFrom: 'staging' } },
    // A custom promotion target: only its settings mark it as one.
    live: { hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web' } },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'live', autoDeploy: false, promoteFrom: 'staging' } },
    // No deploy settings at all: a direct deploy.
    'production-eu': { hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web' } } },
  } });
  new ProjectSpecRepository().insert(project.id, 1, spec);
  writeFileSync('.hypervibe/spec.json', JSON.stringify(spec));
  // "verified-github" as an argument gives the deployment test a usable GitHub
  // connection; the connections test keeps the plain pending one.
  if (process.argv[2] === 'verified-github') {
    const { getSecretStore } = await import('../../dist/adapters/secrets/secret-store.js');
    const connections = new ConnectionRepository();
    connections.updateStatus(connections.create({ provider: 'github', scope, credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'fixture-token' }) }).id, 'verified');
  } else {
    new ConnectionRepository().create({ provider: 'github', scope, credentialsEncrypted: 'fixture' });
  }
}
await import('../../dist/mcp.js');

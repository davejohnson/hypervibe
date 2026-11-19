// Launch the built server with a repository and database owned by the Swift test.
import { mkdirSync, writeFileSync } from 'node:fs';
import { SqliteAdapter } from '../../dist/adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../dist/adapters/db/repositories/project.repository.js';
import { ProjectSpecRepository } from '../../dist/adapters/db/repositories/spec.repository.js';
import { ConnectionRepository } from '../../dist/adapters/db/repositories/connection.repository.js';
import { projectSpecSchema } from '../../dist/domain/spec/spec.schema.js';

globalThis.fetch = async () => { throw new Error('Offline companion contract test'); };
process.env.HYPERVIBE_SECRET_KEY = '00'.repeat(32);
mkdirSync('.git');
mkdirSync('.hypervibe');
SqliteAdapter.getInstance().migrate();
const name = 'companion-contract';
const scope = `example/${name}`;
const gitRemoteUrl = `https://github.com/${scope}`;
const project = new ProjectRepository().create({ name, gitRemoteUrl, defaultPlatform: 'railway' });
const spec = projectSpecSchema.parse({ version: 1, project: name, gitRemoteUrl, environments: {
  production: { hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web' } } },
} });
new ProjectSpecRepository().insert(project.id, 1, spec);
writeFileSync('.hypervibe/spec.json', JSON.stringify(spec));
new ConnectionRepository().create({ provider: 'github', scope, credentialsEncrypted: 'fixture' });
await import('../../dist/mcp.js');

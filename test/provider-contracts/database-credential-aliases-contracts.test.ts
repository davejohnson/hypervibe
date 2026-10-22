import { readFileSync } from 'node:fs';
import { buildSchema, getNamedType, isInputObjectType, isScalarType } from 'graphql';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';

const document = readFileSync(new URL('../../docs/database-credential-aliases.md', import.meta.url), 'utf8');
const rows = document.split('\n')
  .filter(line => /^\| [a-z][a-z-]* \|/.test(line))
  .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));

describe('database credential alias provider contract', () => {
  it('requires one explicit review for every registered database provider', () => {
    expect(rows.map(row => row[0]).sort()).toEqual(providerRegistry.namesFor('database').sort());
    for (const row of rows) {
      expect(row, row[0]).toHaveLength(4);
      expect(row.every(cell => cell.length > 0), row[0]).toBe(true);
    }
  });

  it('admits only Railway for implementation and cites official provider evidence', () => {
    expect(rows.filter(row => row[1] === 'Supported to implement').map(row => row[0])).toEqual(['railway']);
    const officialHosts: Record<string, string> = {
      railway: 'docs.railway.com',
      supabase: 'supabase.com',
      cloudsql: 'docs.cloud.google.com',
      rds: 'docs.aws.amazon.com',
      neon: 'neon.com',
      'azure-postgres': 'learn.microsoft.com',
      digitalocean: 'docs.digitalocean.com',
      fly: 'docs.fly.io',
    };
    for (const [provider, admission, evidence] of rows) {
      expect(admission, provider).toBe(provider === 'railway' ? 'Supported to implement' : 'Unsupported');
      const links = [...evidence.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map(match => new URL(match[1]));
      expect(links.length, provider).toBeGreaterThan(0);
      expect(links.every(url => url.hostname === officialHosts[provider]), provider).toBe(true);
    }
  });

  it('pins the raw-read and additive no-deploy shape without claiming scalar semantics', () => {
    const schema = buildSchema(readFileSync(new URL('./railway/schema.graphql', import.meta.url), 'utf8'));
    const variables = schema.getQueryType()!.getFields().variables;
    expect(variables.args.find(arg => arg.name === 'unrendered')?.type.toString()).toBe('Boolean');
    expect(variables.args.find(arg => arg.name === 'projectId')?.type.toString()).toBe('String!');
    expect(variables.args.find(arg => arg.name === 'environmentId')?.type.toString()).toBe('String!');
    expect(variables.args.find(arg => arg.name === 'serviceId')?.type.toString()).toBe('String');
    expect(isScalarType(getNamedType(variables.type))).toBe(true);

    const input = schema.getType('VariableCollectionUpsertInput');
    expect(isInputObjectType(input)).toBe(true);
    if (!isInputObjectType(input)) throw new Error('Missing pinned Railway variable input');
    const fields = input.getFields();
    expect(fields.replace.defaultValue).toBe(false);
    expect(fields.skipDeploys.defaultValue).toBe(false);
    expect(fields.skipDeploys.type.toString()).toBe('Boolean');
    expect(fields.variables.type.toString()).toBe('EnvironmentVariables!');
    expect(schema.getMutationType()!.getFields().variableCollectionUpsert.type.toString()).toBe('Boolean!');
  });
});

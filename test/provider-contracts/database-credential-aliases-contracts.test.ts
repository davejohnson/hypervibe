import { readFileSync } from 'node:fs';
import { buildSchema, getNamedType, isInputObjectType, isScalarType } from 'graphql';
import { describe, expect, it } from 'vitest';

describe('database credential alias provider contract', () => {
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

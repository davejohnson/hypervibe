#!/usr/bin/env node
// Offline only: the reviewed provider contract lives in the repository.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchema, parse, validate } from 'graphql';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractDirectory = path.join(root, 'test/provider-contracts/railway');
const provenance = JSON.parse(readFileSync(path.join(contractDirectory, 'source.json'), 'utf8'));
const source = readFileSync(path.join(contractDirectory, 'schema.graphql'), 'utf8');
if (createHash('sha256').update(source).digest('hex') !== provenance.schemaSha256) {
  throw new Error('Pinned Railway schema checksum mismatch; review the schema and provenance together.');
}
const schema = buildSchema(source);
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : [filename];
  });
}

const failures = [];
let checked = 0;
for (const filename of files(path.join(root, 'src/adapters/providers/railway'))) {
  if (!filename.endsWith('.ts') || filename.endsWith('.test.ts')) continue;
  const sourceFile = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  function inspect(node) {
    const taggedGraphql = node.parent && ts.isTaggedTemplateExpression(node.parent)
      && node.parent.tag.getText(sourceFile) === 'gql';
    const startsOperation = (value) => /^\s*(?:#[^\n]*(?:\n|$)\s*)*(query|mutation|subscription)\b/.test(value);
    if (ts.isTemplateExpression(node) && (taggedGraphql || startsOperation(node.head.text))) {
      failures.push(`${path.relative(root, filename)}: Dynamic GraphQL document needs explicit contract coverage; do not silently skip interpolated operations.`);
    }
    if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node))
      && (taggedGraphql || startsOperation(node.text))) {
      const location = `${path.relative(root, filename)}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      checked += 1;
      try {
        for (const error of validate(schema, parse(node.text))) failures.push(`${location}: ${error.message}`);
      } catch (error) {
        failures.push(`${location}: ${error.message}`);
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(sourceFile);
}
if (checked === 0) failures.push('No Railway operations were discovered; contract coverage is missing.');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${checked} Railway query variants against pinned schema ${provenance.sourceRevision}; no network access.`);
}

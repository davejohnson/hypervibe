import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// DG-011/DG-111: diagnostics and explicit backup setup own recovery readiness.
// Ordinary apply and emitted deployment programs may not import that policy.
// Executable plan/apply and generated-shell regressions cover actual behavior.
const ordinaryDeploymentFiles = [
  '../../application/apply-plan.ts',
  '../hv-deploy.tools.ts',
  '../../domain/services/github-ops.service.ts',
  '../../adapters/providers/gitlab/gitlab-ci.lifecycle.ts',
];
const backupAdmissionModule = /(?:^|\/)backup-(?:readiness|health\.service|policy\.service|deploy-gate\.service)(?:\.[cm]?[jt]s)?$/;

function backupAdmissionImports(source: string): string[] {
  const file = ts.createSourceFile('deployment.ts', source, ts.ScriptTarget.Latest, true);
  return file.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const name = statement.moduleSpecifier.text;
    return backupAdmissionModule.test(name) ? [name] : [];
  });
}

function unscopedBackupCompilation(source: string): number {
  const file = ts.createSourceFile('publication.ts', source, ts.ScriptTarget.Latest, true);
  let violations = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'compileManagedBackupFiles') {
      const input = node.arguments[0];
      if (!input || !ts.isObjectLiteralExpression(input) || !input.properties.some(property =>
        ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)
        && property.name.text === 'environmentName')) violations++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

describe('optional backup policy ownership', () => {
  it.each(ordinaryDeploymentFiles)('keeps backup admission outside %s', name => {
    expect(backupAdmissionImports(readFileSync(new URL(name, import.meta.url), 'utf8'))).toEqual([]);
  });

  it.each([
    ['backup-readiness.js', 'assessBackupReadiness'],
    ['backup-health.service.js', 'observeBackupHealth'],
    ['backup-policy.service.js', 'observeBackupPolicy'],
    ['backup-deploy-gate.service.js', 'buildGitHubBackupDeployGate'],
  ])('rejects a deliberately reintroduced %s admission dependency', (module, symbol) => {
    const violation = `import { ${symbol} as localGate } from '../services/${module}';\nlocalGate();`;
    expect(backupAdmissionImports(violation)).toEqual([`../services/${module}`]);
  });

  it('allows the separate confirmed backup action executor and diagnostic text', () => {
    expect(backupAdmissionImports([
      "import { applyBackupPolicyAction } from './apply-backup-policy.js';",
      "const message = 'backup-readiness is reported separately';",
    ].join('\n'))).toEqual([]);
  });

  it('requires the repository publisher to compile only the selected backup environment', () => {
    const source = readFileSync(new URL('../../domain/services/github-infrastructure.service.ts', import.meta.url), 'utf8');
    expect(source).toContain('compileManagedBackupFiles(');
    expect(unscopedBackupCompilation(source)).toBe(0);
  });

  it('rejects a deliberately reintroduced all-environment backup compilation', () => {
    expect(unscopedBackupCompilation('compileManagedBackupFiles({ project, spec });')).toBe(1);
    expect(unscopedBackupCompilation('compileManagedBackupFiles({ project, spec, environmentName: selected });')).toBe(0);
  });
});

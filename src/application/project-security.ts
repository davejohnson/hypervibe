import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CommandRegistrar } from './commands.js';
import { commandSuccess, HvError, wrapCommandHandler } from './results.js';
import { currentWorkspaceDirectories } from '../lib/workspace-context.js';
import { projectSpecSchema, type ProjectSpec } from '../domain/spec/spec.schema.js';
import { reviewProjectSecurity } from '../domain/services/project-security.service.js';
import { assessSecurityPolicy } from '../domain/services/security-policy.service.js';

function readSecurityIntent(root: string): { spec?: ProjectSpec; issue?: string } {
  let fd: number | undefined;
  try {
    const directory = path.join(root, '.hypervibe');
    const file = path.join(directory, 'spec.json');
    if (lstatSync(directory).isSymbolicLink()) return { issue: 'Repository security intent is unverified: linked spec directory.' };
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return { issue: 'Repository security intent is unreadable or exceeds the review bound.' };
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 1024 * 1024 || realpathSync(directory) !== directory) {
      return { issue: 'Repository security intent changed during inspection; no policy was inferred.' };
    }
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 1024 * 1024) return { issue: 'Repository security intent exceeds the review bound.' };
    const parsed = projectSpecSchema.safeParse(JSON.parse(buffer.subarray(0, length).toString('utf8')));
    return parsed.success ? { spec: parsed.data } : { issue: 'Repository desired state is invalid; no policy or runtime was inferred from it.' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : { issue: 'Repository security intent could not be read safely.' };
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function registerProjectSecurityCommands(commands: CommandRegistrar): void {
  commands.register('hv_security',
    'Review Node security releases, npm lockfile advisories, and security-review/credential-rotation cadence across local project checkouts. Read-only: does not install dependencies, run project scripts, fix files, deploy, or enable schedules. Defaults to interface workspace roots. Only public package names and exact versions are sent to OSV; scoped packages require publicPackageNames. Incomplete coverage is explicit. Runtime declarations do not prove deployed versions. Apply reviewed github.actions security-review and Dependabot settings through hv_spec/hv_plan/hv_apply for recurring checks.',
    {
      paths: z.array(z.string().min(1)).min(1).max(20).optional().describe('Explicit local project checkout directories; defaults to current interface workspace roots.'),
      lockfilePaths: z.array(z.string().min(1)).min(1).max(20).optional().describe('Relative package-lock.json/npm-shrinkwrap.json paths; default root package-lock.json. Include monorepo lockfiles explicitly.'),
      nodeVersions: z.array(z.object({ source: z.string().min(1).max(120), version: z.string().min(1).max(120) }).strict()).max(29).optional()
        .describe('Additional reviewed Node version declarations. Exact versions can be checked; ranges remain unknown.'),
      publicPackageNames: z.array(z.string().min(1).max(214)).max(500).optional()
        .describe('Scoped npm package names confirmed public and permitted for OSV disclosure. Custom registry packages remain excluded.'),
    }, wrapCommandHandler(async input => {
      const selected = input.paths ?? currentWorkspaceDirectories() ?? [process.cwd()];
      if (!selected.length || selected.length > 20) throw new HvError('VALIDATION', 'Select between one and twenty project checkout directories.');
      let roots: string[];
      try { roots = [...new Set(selected.map(root => realpathSync(root)))]; }
      catch { throw new HvError('VALIDATION', 'A selected project checkout is unavailable. No project was adopted or changed.'); }
      const repositories = [];
      // Bound concurrency and keep each project/source attribution independent.
      for (const root of roots) {
        const intent = readSecurityIntent(root);
        const nodeVersions = [...(input.nodeVersions ?? []), ...(intent.spec?.runtime?.kind === 'node'
          ? [{ source: '.hypervibe/spec.json runtime', version: intent.spec.runtime.version }] : [])];
        const report = await reviewProjectSecurity({ repositoryPath: root, lockfilePaths: input.lockfilePaths,
          nodeVersions, publicPackageNames: input.publicPackageNames });
        repositories.push({ repository: path.basename(root), report,
          policy: assessSecurityPolicy({ policy: intent.spec?.securityPolicy, now: new Date() }),
          ...(intent.issue ? { issues: [intent.issue] } : {}),
          recurringChecks: { declared: Object.values(intent.spec?.github?.actions ?? {}).some(action => action.kind === 'security-review' && action.enabled),
            active: 'unchecked' as const },
        });
      }
      return commandSuccess({ repositories, automationActive: 'unchecked', providerWrites: 0,
        complete: repositories.every(repository => repository.report.complete && !repository.issues),
        status: repositories.some(repository => repository.report.status === 'findings') ? 'findings'
          : repositories.some(repository => !repository.report.complete || repository.issues) ? 'incomplete' : 'clear' },
      { hint: 'Review findings and missing coverage across every checkout. Monthly credential rotation and weekly code review remain due until verified completion evidence exists. Declaring a policy does not activate a scheduler; publish recurring checks through spec/plan/apply.' });
    }));
}

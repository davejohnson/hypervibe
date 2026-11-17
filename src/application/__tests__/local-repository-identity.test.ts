import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { localRepositoryFor } from '../local-repository.js';

// #545: a checkout is built from only when it is the selected project's own repository.
// Two repositories can hold a spec with the same project name.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-repo-identity-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

function checkout(name: string, origin?: string): { root: string; spec: { kind: string; path: string } } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, `${name}-`)));
  execFileSync('git', ['-C', root, 'init', '-q']);
  if (origin) execFileSync('git', ['-C', root, 'remote', 'add', 'origin', origin]);
  return { root, spec: { kind: 'repo', path: path.join(root, '.hypervibe', 'spec.json') } };
}
const project = { gitRemoteUrl: 'https://github.com/acme/app-a.git' };

describe('the local checkout a release builds from', () => {
  it('uses the repository holding the spec when it is the project\'s repository', () => {
    const a = checkout('a', 'git@github.com:Acme/App-A.git');
    expect(localRepositoryFor(project, a.spec)).toBe(a.root);
  });
  it('refuses a same-named spec that lives in a different repository', () => {
    const b = checkout('b', 'https://github.com/acme/app-b.git');
    expect(() => localRepositoryFor(project, b.spec)).toThrow(/acme\/app-b.*acme\/app-a|different repository/i);
  });
  it('refuses a checkout whose origin cannot be read when the project has a known repository', () => {
    const none = checkout('none');
    expect(() => localRepositoryFor(project, none.spec)).toThrow(/could not confirm/i);
  });
  it('keeps working for a project with no recorded repository', () => {
    const b = checkout('c', 'https://github.com/acme/app-b.git');
    expect(localRepositoryFor({ gitRemoteUrl: undefined }, b.spec)).toBe(b.root);
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { findStripeProjectRoot } from '../stripe-projects.adapter.js';

// #378: a Stripe project belongs to the repository it was initialized in. A checkout
// with no .projects of its own must not borrow one from a folder above the repository.
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-stripe-root-')));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
const dir = (...parts: string[]) => { const full = path.join(base, ...parts); fs.mkdirSync(full, { recursive: true }); return full; };

describe('Stripe Projects root', () => {
  it('uses the .projects of the repository, also from a subfolder', () => {
    const repo = dir('own'); dir('own', '.git'); dir('own', '.projects'); const sub = dir('own', 'packages', 'api');
    expect(findStripeProjectRoot(sub)).toBe(repo);
  });
  it('never borrows a .projects from above the repository', () => {
    dir('parent', '.projects'); dir('parent', 'checkout', '.git'); const inside = dir('parent', 'checkout', 'src');
    expect(() => findStripeProjectRoot(inside)).toThrow(/No Stripe Projects project found/);
  });
  it('outside any repository, only the folder itself counts', () => {
    dir('loose', '.projects'); const child = dir('loose', 'child');
    expect(() => findStripeProjectRoot(child)).toThrow(/No Stripe Projects project found/);
    expect(findStripeProjectRoot(path.join(base, 'loose'))).toBe(path.join(base, 'loose'));
  });
});

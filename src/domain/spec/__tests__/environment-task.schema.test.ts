import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

function task(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'environment-task',
    environment: 'staging',
    service: 'web',
    command: ['node', 'scripts/tester-setup.js'],
    inputs: {
      email: { type: 'string', flag: '--email', description: 'Tester email', required: true },
      dry_run: { type: 'boolean', flag: '--dry-run', description: 'Preview changes', default: true },
    },
    ...overrides,
  };
}

function spec(automation: Record<string, unknown>) {
  return {
    version: 1,
    project: 'example',
    github: { repository: 'owner/example', actions: { 'tester-setup': automation } },
    environments: { staging: { hosting: { provider: 'railway' }, services: { web: {} } } },
  };
}

describe('reviewed environment-task desired state', () => {
  it('accepts fixed argv and typed inputs with explicit dry-run safety', () => {
    const parsed = projectSpecSchema.parse(spec(task({ receiptPrefix: '__HLS_TESTER_SETUP_RECEIPT:' })));
    expect(parsed.github?.actions['tester-setup']).toMatchObject({
      enabled: true,
      command: ['node', 'scripts/tester-setup.js'],
      receiptPrefix: '__HLS_TESTER_SETUP_RECEIPT:',
      receiptCountKeys: ['applied', 'skipped'],
      inputs: {
        email: { type: 'string', required: true, default: '' },
        dry_run: { type: 'boolean', default: true },
      },
    });
  });

  it('defaults optional strings and booleans without inventing a task argument', () => {
    const parsed = projectSpecSchema.parse(spec(task({ inputs: {
      name: { type: 'string', flag: '--name', description: 'Tester name' },
      keep_previous: { type: 'boolean', flag: '--keep-previous', description: 'Keep previous data' },
    } })));
    expect(parsed.github?.actions['tester-setup']).toMatchObject({ inputs: {
      name: { default: '' }, keep_previous: { default: false },
    } });
    expect(projectSpecSchema.parse(spec(task({ inputs: undefined }))).github?.actions['tester-setup'])
      .toMatchObject({ inputs: {} });
  });

  it('rejects unknown environments and services before workflow publication', () => {
    expect(projectSpecSchema.safeParse(spec(task({ environment: 'production' }))).success).toBe(false);
    expect(projectSpecSchema.safeParse(spec(task({ service: 'missing' }))).success).toBe(false);
    expect(projectSpecSchema.safeParse(spec(task({ environment: 'constructor' }))).success).toBe(false);
    expect(projectSpecSchema.safeParse(spec(task({ service: 'constructor' }))).success).toBe(false);
  });

  it('rejects oversized argv and dispatch input sets', () => {
    for (const command of [[], Array(17).fill('argument')]) {
      expect(projectSpecSchema.safeParse(spec(task({ command }))).success).toBe(false);
    }
    const inputs = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [
      `input_${index}`, { type: 'string', flag: `--input-${index}`, description: 'Input' },
    ]));
    expect(projectSpecSchema.safeParse(spec(task({ inputs }))).success).toBe(false);
  });

  it('accepts reviewed numeric receipt labels and rejects ambiguous or unsafe whitelists', () => {
    const keys = ['applied', 'skipped', 'accountInvited', 'propertyCreated'];
    expect(projectSpecSchema.parse(spec(task({ receiptPrefix: '__RECEIPT:', receiptCountKeys: keys }))))
      .toMatchObject({ github: { actions: { 'tester-setup': { receiptCountKeys: keys } } } });
    for (const receiptCountKeys of [
      ['applied', 'applied', 'skipped'], ['applied'], ['skipped'], [],
      ['applied', 'skipped', 'not-a-label'], ['applied', 'skipped', '${{ secrets.TOKEN }}'],
      ['applied', 'skipped', 'line\nbreak'], ['applied', 'skipped', 'a'.repeat(65)],
      ['applied', 'skipped', ...Array.from({ length: 31 }, (_, index) => `count${index}`)],
    ]) {
      expect(projectSpecSchema.safeParse(spec(task({ receiptPrefix: '__RECEIPT:', receiptCountKeys }))).success)
        .toBe(false);
    }
  });

  it('rejects control bytes, expressions, malformed flags, duplicates, and mismatched defaults', () => {
    const unsafeTasks = [
      task({ environment: 'staging\nproduction' }),
      task({ service: '${{ inputs.service }}' }),
      task({ command: ['node', '${{ secrets.TOKEN }}'] }),
      task({ command: ['node', 'script\u0000name'] }),
      task({ receiptPrefix: 'arbitrary:' }),
      task({ receiptPrefix: '${{ secrets.TOKEN }}' }),
      task({ triggers: { push: ['main'] } }),
      task({ inputs: { 'email-address': { type: 'string', flag: '--email', description: 'Email' } } }),
      task({ inputs: { name: { type: 'string', flag: '--Email', description: 'Name' } } }),
      task({ inputs: { name: { type: 'string', flag: '-e', description: 'Name' } } }),
      task({ inputs: { name: { type: 'string', flag: '--name=value', description: 'Name' } } }),
      task({ inputs: {
        name: { type: 'string', flag: '--name', description: 'Name' },
        other: { type: 'string', flag: '--name', description: 'Other name' },
      } }),
      task({ inputs: { name: { type: 'string', flag: '--name', description: 'Line\nbreak' } } }),
      task({ inputs: { name: { type: 'string', flag: '--name', description: 'Name', default: '${{ secrets.TOKEN }}' } } }),
      task({ inputs: { name: { type: 'string', flag: '--name', description: 'Name', default: true } } }),
      task({ inputs: { dry_run: { type: 'boolean', flag: '--dry-run', description: 'Preview', default: 'true' } } }),
    ];
    for (const automation of unsafeTasks) {
      expect(projectSpecSchema.safeParse(spec(automation)).success, JSON.stringify(automation)).toBe(false);
    }
  });
});

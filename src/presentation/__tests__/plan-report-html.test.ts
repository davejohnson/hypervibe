import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PlanReport, PlanReportAction } from '../../domain/plan/plan-report.js';
import { renderPlanReportHtml } from '../plan-report-html.js';
import { gcpInfrastructureNotes } from '../../domain/plan/gcp-infrastructure-notes.js';
import { buildReportMap } from '../plan-report-map.js';

const action = (id: string, name: string, extra: Partial<PlanReportAction> = {}): PlanReportAction => ({
  id, name, kind: 'project', provider: 'gcp', type: 'create', verified: true,
  requiresConfirm: false, billable: false, dataBearing: false, addresses: [], fields: [], dependsOn: [], ...extra,
});
const report = (actions: PlanReportAction[], extra: Partial<PlanReport> = {}): PlanReport => ({
  planId: 'saved-id', project: 'Example', scope: 'Project setup', blocked: [], warnings: [], actions, ...extra,
});

describe('standalone infrastructure plan report', () => {
  it('groups Google Cloud setup by purpose and wires only explicit cross-group dependencies', () => {
    const api1 = action('project-setup:google_project_service:run', 'Enable run.googleapis.com');
    const api2 = action('project-setup:google_project_service:build', 'Enable cloudbuild.googleapis.com', { dependsOn: [api1.id] });
    const grant = action('project-setup:google_project_iam_member:one', 'serviceAccount:build roles/run.admin', {
      dependsOn: [api1.id, api2.id, 'unresolved-id'], addresses: ['google_project_iam_member.one'],
    });
    const bucket = action('build-source', 'Private build source bucket', { kind: 'storage' });
    const actions = [api1, api2, grant, bucket];
    const map = buildReportMap(actions);
    expect(map.groups.map(group => [group.title, group.actions.length])).toEqual([
      ['Cloud APIs', 2], ['Project permissions', 1], ['Storage', 1],
    ]);
    expect(map.edges).toEqual([{ from: 0, to: 1 }]);
    const html = renderPlanReportHtml(report(actions));
    expect(html).toContain('Cloud Run API');
    expect(html).toContain('Enable run.googleapis.com');
    expect(html).toContain('Google Cloud · 2 actions');
    expect(html).toContain('serviceAccount:build roles/run.admin');
    expect(html).toContain('<code>unresolved-id</code>');
    expect(html).toContain('<a href="#action-0"><code>project-setup:google_project_service:run</code></a>');
    expect(html.match(/class="action-row"/g)).toHaveLength(4);
  });

  it('shows counts, confirmation flags, fields, blockers and warnings as static accessible text', () => {
    const html = renderPlanReportHtml(report([action('db', 'Catalog', {
      type: 'replace', requiresConfirm: true, billable: true, dataBearing: true, verified: false, fields: ['size'],
    })], { blocked: ['Choose target'], warnings: ['Check backup'] }));
    for (const text of ['Replace', 'May incur charges', 'Confirmation required', 'Contains data',
      'Unverified at planning time', '<code>size</code>', 'Choose target', 'Check backup', 'No recorded prerequisites']) {
      expect(html).toContain(text);
    }
    expect(html).toContain('data-type="replace"><strong>1</strong>');
    expect(html).toContain('data-type="create"><strong>0</strong>');
  });

  it('keeps real risks visible and leaves traffic changes in the scope of their plan', () => {
    const destructive = 'This environment declares no services; any previously created services will be deleted.';
    const html = renderPlanReportHtml(report([action('domain:example.com', 'example.com', { kind: 'domain' })], {
      scope: 'infrastructure-engine', warnings: [gcpInfrastructureNotes.release, destructive, 'A new provider warning.'],
    }));
    expect(html).toContain('Warnings (2)</h3><ul><li>' + destructive + '</li><li>A new provider warning.</li>');
    expect(html).toContain('Releasing the app is a separate step.');
    const trafficPlan = report([action('domain:example.com', 'example.com', { kind: 'domain' })], {
      scope: 'infrastructure-engine', warnings: [gcpInfrastructureNotes.release],
    });
    expect(renderPlanReportHtml(trafficPlan)).not.toContain('switching live traffic');
  });

  it('explains both connection prerequisites and preserves an unfamiliar qualification', () => {
    const qualifiedCost = 'Database: shared CPU, 0.6 GB, about US$10 a month plus storage. New databases start with 7 daily backups and 7 days of point-in-time recovery; existing backup and recovery settings are preserved. Deletion protection is off. Backup verification failed.';
    const html = renderPlanReportHtml(report([action('service:web', 'web', { kind: 'service' })], {
      scope: 'infrastructure-engine', warnings: [gcpInfrastructureNotes.release, gcpInfrastructureNotes.database, gcpInfrastructureNotes.redis, qualifiedCost],
    }));
    expect(html).toContain('creates the database login and makes the Redis address available');
    expect(html).toContain('connect your app to the database and Redis');
    expect(html).toContain('Warnings (1)</h3><ul><li>' + qualifiedCost + '</li>');
    expect(html).not.toContain('Database cost and protection');
  });

  it('gives named app resources individual cards and preserves the original review order', () => {
    const db = action('database:accounts', 'accounts', { kind: 'database' });
    const web = action('service:web', 'web', { kind: 'service', dependsOn: [db.id] });
    const worker = action('service:worker', 'worker', { kind: 'service', dependsOn: [web.id] });
    const map = buildReportMap([worker, web, db]);
    expect(map.groups).toHaveLength(3);
    expect(map.edges).toEqual([{ from: 1, to: 0 }, { from: 2, to: 1 }]);
    const html = renderPlanReportHtml(report([worker, web, db]));
    expect(html).toContain('<span class="node-title">worker</span>');
    expect(html.indexOf('<span class="action-name">worker</span>')).toBeLessThan(html.indexOf('<span class="action-name">web</span>'));
  });

  it('retains the empty plan and its blockers without an interactive map', () => {
    const html = renderPlanReportHtml(report([], { blocked: ['Project access required'] }));
    expect(html).toContain('No actions are recorded in this plan.');
    expect(html).toContain('Project access required');
    expect(html).not.toContain('class="map-canvas"');
  });

  it('explains how approval works when reviewing a saved project setup', () => {
    const setup = report([action('create-project', 'Google Cloud project')], { approval: 'whole-plan' });
    expect(renderPlanReportHtml(setup)).toContain('Applying this setup requires approval of the whole plan.');
    expect(renderPlanReportHtml(report([]))).not.toContain('approval of the whole plan');
  });

  it('escapes every untrusted text boundary and embeds only its hashed script and stylesheet', () => {
    const injection = '</style></script><img src="https://invalid.example" onerror="injected()">';
    const html = renderPlanReportHtml(report([action(injection, injection, {
      kind: injection, provider: injection, dependsOn: [injection], addresses: [injection], fields: [injection], reason: injection,
    })], { project: injection, target: injection, billingAccount: injection, createdAt: injection, blocked: [injection] }));
    expect(html).not.toContain(injection);
    expect(html).toContain('&lt;/script&gt;');
    expect(html.match(/<script>/g)).toHaveLength(1);
    for (const tag of ['style', 'script']) {
      const source = html.match(new RegExp('<' + tag + '>([\\s\\S]+?)</' + tag + '>'))![1];
      expect(html).toContain(tag + "-src 'sha256-" + createHash('sha256').update(source).digest('base64') + "'");
    }
    expect(html).not.toMatch(/(?:href|src)="(?:\/\/|https?:)/);
  });
});

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makePlanReport, planIdInSavedReport, type PlanReport, type PlanReportAction } from '../../domain/plan/plan-report.js';
import { reviewDetail } from '../local-review.js';
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

/** How many action rows of one type the page lists. */
const rowsOf = (html: string, type: string) => (html.match(new RegExp(`class="action-row" data-action="[^"]*" data-type="${type}"`, 'g')) ?? []).length;

describe('standalone infrastructure plan report', () => {
  it('shows exactly which buckets and account the user is approving and when the files move', () => {
    const scope = { storageName: 'documents', sourceBucket: 'documents-railway-abc', targetBucket: 'gcp-documents-example',
      copyAccount: 'copy@example.iam.gserviceaccount.com' };
    const input = { ...report([]), scope: 'Google Cloud project setup', setupPurpose: 'railway-bucket-copy' as const };
    const html = renderPlanReportHtml(makePlanReport({ ...input, bucketCopy: scope }), { localReview: true });
    expect(html).toContain(scope.sourceBucket);
    expect(html).toContain('href="https://console.cloud.google.com/storage/browser/' + scope.targetBucket + '"');
    expect(html).toContain(scope.copyAccount);
    expect(html).toContain('separate approval');
    expect(makePlanReport({ ...input, bucketCopy: { ...scope, targetBucket: '../secret' } }).bucketCopy).toBeUndefined();
  });
  it('distinguishes the stored secret and its read permission, including previously saved plans', () => {
    const key = 'hv-example-api-key';
    const stored = action('secret-container:' + key, key, { kind: 'secret', type: 'noop' });
    const grant = action('secret-runtime-access:' + key, key, { kind: 'secret', requiresConfirm: true });
    const html = renderPlanReportHtml(report([stored, grant]));
    expect(rowsOf(html, 'create')).toBe(0);
    expect(rowsOf(html, 'grant')).toBe(1);
    expect(html).toContain('<option value="grant">Grant access</option>');
    expect(html).toContain('<span class="status">Grant access</span>');
    expect(html).toContain('<span class="action-name">App read access to ' + key + '</span>');
    expect(html).toContain('<span class="node-title">Secret permissions</span>');
    // The stored secret already exists and nothing happens to it, so it is counted, not listed.
    expect(html).not.toContain('<span class="node-title">Secrets</span>');
    expect(html).not.toContain('data-action="' + stored.id + '"');
    expect(html).toContain('1 other thing already matches and is left alone.');
    expect(html).toContain('data-action="' + grant.id + '"');
    expect(html).toContain('Needs your OK');

    const mixed = renderPlanReportHtml(report([{ ...stored, type: 'create' }, { ...grant, type: 'destroy' }]));
    expect(rowsOf(mixed, 'create')).toBe(1);
    expect(rowsOf(mixed, 'revoke')).toBe(1);
    expect(mixed).toContain('<span class="status">Remove access</span>');
  });

  it.each(['azure', 'aws'])('distinguishes the bundled %s app identity from a service named runtime', provider => {
    const appIdentity = action('identity:runtime', 'runtime', { kind: 'service', provider });
    const service = action('service:runtime', 'runtime', { kind: 'service', provider });
    const html = renderPlanReportHtml(report([appIdentity, service]));
    expect(html).toContain('<span class="node-title">App identity and permissions</span>');
    expect(html).toContain('<span class="node-title">runtime</span>');
    expect(html).toContain('<span class="action-name">App runtime identity</span>');
    expect(rowsOf(html, 'create')).toBe(2);
    expect(html).not.toContain('<option value="grant">');
  });

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
    expect(html).not.toContain('unresolved-id');
    // A prerequisite is named like its own row; one the plan does not list is left out.
    expect(html).toContain('<a href="#action-0">Cloud Run API</a>');
    expect(html.match(/class="action-row"/g)).toHaveLength(4);
  });

  it('shows counts, confirmation flags, fields, blockers and warnings as static accessible text', () => {
    const html = renderPlanReportHtml(report([action('db', 'Catalog', {
      type: 'replace', requiresConfirm: true, billable: true, dataBearing: true, verified: false, fields: ['size'],
    })], { blocked: ['Choose target'], warnings: ['Check backup'] }));
    for (const text of ['Replace', 'Costs money', 'Needs your OK', 'Holds data',
      'Not confirmed with the provider when this plan was made', 'Choose target', 'Check backup']) {
      expect(html).toContain(text);
    }
    expect(rowsOf(html, 'replace')).toBe(1);
    expect(rowsOf(html, 'create')).toBe(0);
  });

  it('opens with one plain sentence and always says whether anything is deleted', () => {
    const sentence = (actions: PlanReportAction[]) => /<p class="headline"><span>([^<]*)<\/span>/.exec(renderPlanReportHtml(report(actions)))?.[1];
    expect(sentence([action('a', 'A'), action('b', 'B'), action('c', 'C', { type: 'update' })])).toBe('This plan adds 2 things and changes 1 thing. Nothing is deleted.');
    expect(sentence([action('a', 'A'), action('d', 'D', { type: 'destroy' })])).toBe('This plan adds 1 thing and deletes 1 thing.');
    expect(sentence([action('r', 'R', { type: 'replace' })])).toBe('This plan replaces 1 thing. Replacing removes the old one; nothing else is deleted.');
    expect(sentence([action('n', 'N', { type: 'noop' })])).toBe('Nothing needs to change. Everything already matches.');
    expect(sentence([])).toBe('This plan has nothing in it.');
    expect(sentence([action('a', 'A'), action('n', 'N', { type: 'noop' }), action('m', 'M', { type: 'noop' })])).toBe('This plan adds 1 thing. Nothing is deleted. 2 other things already match and are left alone.');
  });

  it('lists only what changes, plus anything unchanged that still needs an OK', () => {
    const html = renderPlanReportHtml(report([
      action('web', 'web', { dependsOn: ['kept'] }), action('kept', 'kept', { type: 'noop' }), action('ask', 'ask', { type: 'noop', requiresConfirm: true }),
    ]));
    expect(html.match(/class="action-row"/g)).toHaveLength(2);
    expect(html).not.toContain('data-action="kept"');
    expect(html).toContain('data-action="ask"');
    // A prerequisite that is already in place is not something that still has to happen first.
    expect(html).not.toContain('Happens after');
    expect(html).toContain('1 other thing already matches and is left alone.');
    // With nothing unchanged left on the page, the filter does not offer it.
    expect(renderPlanReportHtml(report([action('web', 'web'), action('kept', 'kept', { type: 'noop' })]))).not.toContain('<option value="noop">');
  });

  it('shows no ids, engine addresses or raw timestamps, and still names its plan for the saved-review catalog', () => {
    const planId = '6f1c2b1e-8f0a-4c56-9d55-0d1f3a6f6a10';
    const html = renderPlanReportHtml(report([action('service:web', 'web', { addresses: ['google_cloud_run_v2_service.web'], fields: ['template.containers'] })],
      { planId, createdAt: '2026-11-23T22:42:10.123Z' }));
    // The time is written for the reader's own clock, with a short readable fallback.
    expect(html).toContain('<time datetime="2026-11-23T22:42:10.123Z" data-local>Nov 23, 10:42 PM UTC</time>');
    // What a reader sees: the page without its head and without tag attributes.
    const visible = html.slice(html.indexOf('<body')).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ');
    for (const technical of [planId, 'service:web', 'google_cloud_run_v2_service.web', 'template.containers', 'Plan ID', 'Action ID', 'Technical details', '2026-11-23T22:42']) {
      expect(visible).not.toContain(technical);
    }
    // A friendly-named copy is matched to its native report through this, so it must survive.
    expect(planIdInSavedReport(html)).toBe(planId);
    expect(planIdInSavedReport(`<div><dt>Plan ID</dt><dd>${planId}</dd></div>`)).toBe(planId);
    expect(renderPlanReportHtml(report([], { createdAt: 'not a date"><script>' }))).not.toContain('<script>not');
  });

  it('puts what needs attention in small badges beside the sentence, explained in their tooltips', () => {
    const html = renderPlanReportHtml(report([
      action('db', 'Catalog', { requiresConfirm: true, billable: true, dataBearing: true }), action('web', 'web', { billable: true }), action('key', 'key'),
    ]));
    expect(html).toContain('<span class="badge" data-badge="confirm" title="1 step will not run until you approve." aria-label="1 step will not run until you approve.">1 needs your OK</span>');
    expect(html).toContain('title="2 steps create or change something you pay for."');
    expect(html).toContain('>2 cost money</span>');
    expect(html).toContain('title="1 step touches something that stores your data."');
    expect(html).not.toMatch(/class="(counts|stat|review-flags)[" ]/);
    expect(renderPlanReportHtml(report([action('key', 'key')]))).not.toContain('class="badge"');
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

  it('presents the reviewed access check without attributing future results to an infrastructure plan', () => {
    const html = renderPlanReportHtml(report([action('app-read', 'App read check')], {
      scope: 'Google Cloud transfer access check', approval: 'whole-plan',
    }));
    expect(html).toContain('<span class="brand-topic">Transfer access check</span>');
    expect(html).toContain('Google Cloud transfer access check');
    expect(html).toContain('<span class="node-title">App read check</span>');
    expect(html).not.toMatch(/infrastructure plan|verified at planning time/i);
  });

  it('explains how approval works when reviewing a saved project setup', () => {
    const setup = report([action('create-project', 'Google Cloud project')], { approval: 'whole-plan' });
    expect(renderPlanReportHtml(setup)).toContain('Approve the whole plan in the chat or terminal where you requested it.');
    expect(renderPlanReportHtml(report([]))).not.toContain('Approve the whole plan');
  });

  it('describes only the file and the app job in an export file access check', () => {
    const html = renderPlanReportHtml(report([action('app', 'Check direct file access'),
      action('cleanup', 'Remove test resources', { reason: 'The deleted file is recoverable for 7 days.' })], {
      scope: 'Google Cloud export file access check', approval: 'whole-plan',
    }));
    expect(html).toContain('<span class="brand-topic">Export file access check</span>');
    expect(html).toMatch(/one temporary Cloud Run job/i);
    expect(html).toMatch(/app account/i);
    expect(html).toContain('7 days');
    expect(html).not.toMatch(/infrastructure plan|verified at planning time|two temporary Cloud Run jobs|test secret|copy account/i);
  });

  it('explains replacing app access grants without reporting a data replacement or suppressing a real warning', () => {
    const actions = [action('runtime-access', 'App access to secrets', { type: 'replace' }),
      action('transfer-slot:secret:fixture', 'The copy job’s secret', { kind: 'secret', type: 'noop' })];
    const html = renderPlanReportHtml(report(actions, { scope: 'Google Cloud project setup',
      setupPurpose: 'railway-transfer-isolation', warnings: ['A separate permission requires review.'] }));
    expect(html).toContain('The two permissions reviewed here belong to the app');
    expect(html).toContain('the contents of temporary database exports');
    expect(html).toContain('A separate permission requires review.');
    expect(html).not.toContain('This plan reserves an empty Google Cloud secret');
  });

  it('takes the reader from the copy explanation to the reserved secret when its row is unambiguous', () => {
    const scope = { scope: 'Google Cloud project setup', setupPurpose: 'railway-transfer' as const };
    const unrelated = action('secret:app', 'App API key', { kind: 'secret', type: 'noop' });
    const slot = action('transfer-slot:secret:one', 'Empty migration secret', { kind: 'secret' });
    const render = (actions: PlanReportAction[]) => renderPlanReportHtml(report(actions, scope));
    const link = '<a href="#action-1">View the secret in this plan</a>';
    expect(render([unrelated, slot])).toContain(link);
    expect(render([unrelated, { ...slot, type: 'noop' }])).toContain(link);
    expect(render([slot, { ...slot, id: 'transfer-slot:secret:two' }])).not.toContain('View the secret in this plan');
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

describe('the review page states each fact once', () => {
  const createdAt = '2026-11-26T09:59:00.000Z';
  const engine = report([action('database:postgres', 'postgres', { kind: 'database', billable: true, requiresConfirm: true, reason: 'Create the database server.' }),
    action('service:web', 'web', { kind: 'service', type: 'update', reason: 'Update the web service.' })],
  { scope: 'infrastructure-engine', project: 'billforge', environment: 'production', createdAt, cloudTarget: { provider: 'gcp', projectId: 'hv-billforge-prod-012d0f4e' },
    warnings: ['The database is created with deletion protection on.'] });
  const setup = report([action('create-project', 'Google Cloud project', { requiresConfirm: true }), action('enable-apis', 'Cloud services')],
    { scope: 'Google Cloud project setup', project: 'billforge', createdAt, cloudTarget: { provider: 'gcp', projectId: 'hv-billforge-prod-012d0f4e' }, billingAccount: 'ABCDEF-123456-ABCDEF' });
  const local = (input: PlanReport) => reviewDetail({ id: input.planId, planId: input.planId, kind: 'plan', title: input.scope, project: input.project, createdAt, report: input, details: [], aliases: [],
    status: 'Awaiting approval', approval: { digest: 'a'.repeat(64) } }, '/v/token/', '/v/token/r/saved-id', [], 'csrf-token');
  const count = (html: string, text: string) => html.split(text).length - 1;

  it('names the plan and when it was saved in the heading only, and keeps the cloud project as one small link', () => {
    for (const input of [engine, setup]) {
      const html = local(input);
      // The heading has the plan's name and when it was saved; the old block said both again, each on a row of its own.
      expect(html).not.toContain('<dt>Scope</dt>');
      expect(html).not.toContain('<dt>Created</dt>');
      expect(html).not.toContain('<dt>Google Cloud project</dt>');
      expect(html).not.toContain('<dl class="meta">');
      expect(count(html, '<time ')).toBe(1);
      expect(html).toContain('<dt>Saved</dt>');
      expect(html).toContain('<p class="where"><span>Google Cloud project <a href="https://console.cloud.google.com/welcome?project=hv-billforge-prod-012d0f4e" target="_blank" rel="noopener noreferrer"');
      // What is being approved is all still there.
      expect(html).toContain('Approve plan');
      expect(count(html, 'class="action-row"')).toBe(2);
    }
    expect(local(engine)).toContain('The database is created with deletion protection on.');
    expect(local(setup)).toContain('Billing account reports <a href="https://console.cloud.google.com/billing/ABCDEF-123456-ABCDEF/reports"');
  });

  it('keeps the plan\'s kind and creation time in that same small line on a saved report file, which has no such heading', () => {
    const html = renderPlanReportHtml(engine);
    expect(html).toMatch(/<p class="where"><span>Infrastructure engine<\/span><span>Google Cloud project <a [^>]*>hv-billforge-prod-012d0f4e<\/a><\/span><span>Created <time /);
    expect(html).not.toContain('<dt>Scope</dt>');
    expect(count(html, '<time ')).toBe(1);
  });

  // HYPERVIBE_WRITE_REVIEW_SAMPLES=<directory> writes the pages above to files, to look at in a browser.
  it.runIf(Boolean(process.env.HYPERVIBE_WRITE_REVIEW_SAMPLES))('writes sample pages', () => {
    const directory = process.env.HYPERVIBE_WRITE_REVIEW_SAMPLES!;
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'review-google-cloud-infrastructure-plan.html'), local(engine));
    writeFileSync(path.join(directory, 'review-google-cloud-setup-plan.html'), local(setup));
    writeFileSync(path.join(directory, 'report-file-google-cloud-infrastructure-plan.html'), renderPlanReportHtml(engine));
  });
});

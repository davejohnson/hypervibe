import { createHash } from 'node:crypto';
import { planIdMeta, transferAccessCheckScope, transferFileAccessCheckScope, type PlanReport, type PlanReportAction } from '../domain/plan/plan-report.js';
import type { PlanActionType } from '../domain/plan/plan.types.js';
import { actionTitle, buildReportMap, humanize, isNamedResource, isSecretReadPermission, lanes, providerName, type MapGroup } from './plan-report-map.js';
import { planReportBrowser } from './plan-report-browser.js';
import { cloudFacts } from './plan-report-links.js';
import { groupPlanNotices } from './plan-report-notices.js';
import { planReportStyle } from './plan-report-style.js';
import { timeTag } from './local-time.js';

type ReviewActionType = PlanActionType | 'grant' | 'revoke';
/** The verb on each action. */
const types: Record<ReviewActionType, string> = {
  create: 'Add', update: 'Change', replace: 'Replace', destroy: 'Delete', noop: 'No change',
  grant: 'Grant access', revoke: 'Remove access',
};
/** The same types as a count: "3 new", "1 deleted". */
const tallies: Record<ReviewActionType, string> = {
  create: 'New', update: 'Changed', replace: 'Replaced', destroy: 'Deleted', noop: 'Unchanged',
  grant: 'Access granted', revoke: 'Access removed',
};

function reviewType(action: PlanReportAction): ReviewActionType {
  if (isSecretReadPermission(action)) {
    if (action.type === 'create') return 'grant';
    if (action.type === 'destroy') return 'revoke';
  }
  return action.type;
}

// Hypercloud's resource-map buttons use small line icons and a text description
// for every resource. SVGs here are fixed markup and require no external assets.
const icons: Record<MapGroup['icon'], string> = {
  project: '<path d="M3 7h7l2 2h9v11H3zM3 7V5h7l2 2"/>',
  service: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 3.3 15 3.3 15 0v-13M4.5 12c0 3.3 15 3.3 15 0"/>',
  storage: '<path d="M4 7h16v12H4zM4 7l2-3h12l2 3M10 11h4"/>',
  api: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
  key: '<circle cx="9" cy="9" r="5"/><path d="m12.5 12.5 7 7 2-2-2-2 1.5-1.5"/>',
  identity: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2c0-7 16-7 16 0v2"/>',
};
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const quantity = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const digest = (text: string) => createHash('sha256').update(text).digest('base64');
export const planReportPolicy = `default-src 'none'; script-src 'sha256-${digest(planReportBrowser)}'; style-src 'sha256-${digest(planReportStyle)}'; base-uri 'none'; form-action 'none'`;

function fact(label: string, value?: string) {
  return value ? `<div><dt>${label}</dt><dd>${value}</dd></div>` : '';
}
function notice(label: string, messages: string[], className: string, detail?: { index: number; label: string }) {
  const heading = className === 'info' ? label : `${label} (${messages.length})`;
  const link = detail ? ` <a href="#action-${detail.index}">${escape(detail.label)}</a>` : '';
  return messages.length ? `<div class="notice ${className}"><h3>${heading}</h3><ul>${messages.map(message => `<li>${escape(message)}</li>`).join('')}</ul>${link}</div>` : '';
}
function node(group: MapGroup, accessCheck: boolean) {
  const provider = providerName(group.provider);
  const first = group.actions[0];
  const named = isNamedResource(first);
  const title = named || (accessCheck && group.actions.length === 1) ? first.name : group.title;
  const subtitle = [provider, named ? humanize(first.kind) : '', quantity(group.actions.length, 'action')].filter(Boolean).join(' · ');
  const changes = Object.keys(types).flatMap((type) => {
    const count = group.actions.filter(action => reviewType(action) === type).length;
    if (!count) return [];
    const summary = type === 'grant' ? quantity(count, 'new permission') : type === 'revoke' ? quantity(count, 'permission removal') : `${count} ${tallies[type as ReviewActionType].toLowerCase()}`;
    return [`<span class="status" data-type="${type}">${summary}</span>`];
  }).join(' · ');
  return `<a class="map-node" href="#group-${group.index}" data-group="${group.index}">
    <span class="map-node-icon"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7">${icons[group.icon]}</svg></span>
    <span><span class="node-title">${escape(title)}</span><span class="node-description">${escape(subtitle)}</span>
    <span class="node-status">${changes}</span></span>
    <span class="map-arrow" aria-hidden="true">›</span></a>`;
}

function mapSection(map: ReturnType<typeof buildReportMap>, accessCheck: boolean) {
  if (!map.groups.length) return '';
  const zones = lanes.map(lane => {
    const groups = map.groups.filter(group => group.lane === lane);
    return groups.length ? `<div class="map-zone"><h3>${lane}</h3>${groups.map(group => node(group, accessCheck)).join('')}</div>` : '';
  }).join('');
  return `<section id="resource-map" aria-labelledby="map-title"><div class="section-head"><h2 id="map-title">Resource map</h2>
    <a href="#review">View all actions ↓</a></div>
    <div class="resource-map"><div class="map-canvas">
    <svg class="map-wires" aria-hidden="true"><defs><marker id="arrow" markerWidth="5" markerHeight="5" refX="5" refY="2.5" orient="auto"><path d="M0 0L5 2.5L0 5" fill="#728b97"/></marker></defs>
    ${map.edges.map(edge => `<path class="map-wire" marker-end="url(#arrow)" data-from="${edge.from}" data-to="${edge.to}"/>`).join('')}</svg>
    <div class="map-grid">${zones}</div></div>
    <p class="map-note">${map.edges.length ? 'Arrows point from a prerequisite to a group that depends on it.' : 'The plan records no dependencies between these groups.'}</p></div></section>`;
}

const listed = (parts: string[]) => parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;

/** Already as it should be, and nothing for the reader to decide. */
const leftAlone = (action: PlanReportAction) => action.type === 'noop' && !action.requiresConfirm;

/** One sentence in everyday words, so the reader knows the size of the plan before any detail. Deletion is always stated. */
function headline(actions: PlanReportAction[]): string {
  const count = (type: ReviewActionType) => actions.filter(action => reviewType(action) === type).length;
  const verbs: Array<[ReviewActionType, string]> = [['create', 'adds'], ['update', 'changes'], ['replace', 'replaces'], ['destroy', 'deletes'], ['grant', 'grants access for'], ['revoke', 'removes access for']];
  const parts = verbs.filter(([type]) => count(type)).map(([type, verb]) => `${verb} ${quantity(count(type), 'thing')}`);
  if (!parts.length) return actions.length ? 'Nothing needs to change. Everything already matches.' : 'This plan has nothing in it.';
  const removal = count('destroy') ? '' : count('replace') ? ' Replacing removes the old one; nothing else is deleted.' : ' Nothing is deleted.';
  const alone = actions.filter(leftAlone).length;
  const untouched = alone ? ` ${alone === 1 ? '1 other thing already matches and is' : `${alone} other things already match and are`} left alone.` : '';
  return `This plan ${listed(parts)}.${removal}${untouched}`;
}


function actionRow(action: PlanReportAction, index: number, group: MapGroup, indexes: Map<string, number | null>, titles: string[], accessCheck: boolean) {
  const type = reviewType(action);
  const title = actionTitle(action);
  const name = title !== action.name ? fact('Resource name', escape(action.name)) : '';
  const flags = [
    action.billable && 'Costs money', action.dataBearing && 'Holds data', action.requiresConfirm && 'Needs your OK',
  ].filter(Boolean);
  // A prerequisite is named the way its own row is. One the plan does not list has no name to show.
  const dependencies = action.dependsOn.flatMap(id => {
    const target = indexes.get(id);
    return typeof target === 'number' ? [`<li><a href="#action-${target}">${escape(titles[target]!)}</a></li>`] : [];
  });
  const anchor = group.actions[0] === action ? `<span id="group-${group.index}"></span>` : '';
  return `<li id="action-${index}" class="action-row" data-action="${escape(action.id)}" data-type="${escape(type)}" data-group="${group.index}">${anchor}
    <details><summary><span class="status">${types[type]}</span>
    <span class="action-main"><span class="action-name">${escape(title)}</span><span class="action-kind">${escape(group.title)} · ${escape(providerName(action.provider))}</span></span></summary>
    <div class="detail"><div class="bits">${flags.map(label => `<span>${label}</span>`).join('')}</div>
    ${action.reason ? `<p>${escape(action.reason)}</p>` : ''}<dl>
    ${name}
    ${accessCheck ? '' : fact('Checked', action.verified ? 'Confirmed with the provider when this plan was made' : 'Not confirmed with the provider when this plan was made')}
    ${fact('Happens after', dependencies.length ? `<ul>${dependencies.join('')}</ul>` : undefined)}</dl></div></details></li>`;
}

export function renderPlanReportContent(report: PlanReport, options: { localReview?: boolean } = {}): string {
  const accessCheck = report.scope === transferFileAccessCheckScope || report.scope === transferAccessCheckScope;
  // Things that already match are not listed: nothing happens to them, so they are only counted in the sentence.
  // One that still needs the reader's OK stays. An access check is a list of checks, not changes, so it shows every one.
  const actions = accessCheck ? report.actions : report.actions.filter(action => !leftAlone(action));
  const map = buildReportMap(actions);
  const indexes = new Map<string, number | null>();
  actions.forEach((action, i) => indexes.set(action.id, indexes.has(action.id) ? null : i));
  const visibleTypes = Object.entries(types).filter(([type]) => actions.some(action => reviewType(action) === type));
  const titles = actions.map(actionTitle);
  const rows = actions.map((action, index) =>
    actionRow(action, index, map.groupByAction.get(action)!, indexes, titles, accessCheck)).join('');
  const { warnings, costs, next, detail } = groupPlanNotices(report);
  const notices = notice('Blockers', report.blocked, 'blocked') + notice('Warnings', warnings, 'warning')
    + notice('Scheduled runtime monitoring', report.runtimeObservationAccess ?? [], 'info')
    + notice('GitHub release access', report.ciReleaseAccess ?? [], 'info')
    + notice('Database cost and protection', costs, 'info') + notice('What happens next', next, 'info', detail);
  // One small line says where the plan acts, each place a link to its own console. On the local review page the heading
  // above already names the plan and when it was saved, so neither is repeated here; a saved report file has no such
  // heading and keeps both, in this same line.
  const where = [
    options.localReview ? '' : escape(humanize(report.scope)),
    ...cloudFacts(report).map(({ label, value, href }) => typeof value === 'string' ? `${escape(label)} ${href
      ? `<a href="${escape(href)}" ${options.localReview ? 'target="_blank" rel="noopener noreferrer"' : 'rel="noreferrer"'} aria-label="${escape(label + ' ' + value)}">${escape(value)}</a>`
      : escape(value)}` : ''),
    options.localReview ? '' : `Created ${timeTag(report.createdAt)}`,
  ].filter(Boolean).map(item => `<span>${item}</span>`).join('');
  // What a file copy moves between, and how a whole plan is approved, are part of what is being agreed to and stay as they were.
  const metadata = [
    ...(report.bucketCopy ? [
      fact('Railway source bucket', escape(report.bucketCopy.sourceBucket)),
      fact('Google Cloud destination bucket', `<a href="https://console.cloud.google.com/storage/browser/${encodeURIComponent(report.bucketCopy.targetBucket)}" target="_blank" rel="noopener noreferrer">${escape(report.bucketCopy.targetBucket)}</a>`),
      fact('Copy job account', escape(report.bucketCopy.copyAccount)),
    ] : []),
    fact('Approval', !options.localReview && report.approval === 'whole-plan' ? 'Approve the whole plan in the chat or terminal where you requested it.' : undefined),
  ].join('');
  // Small badges beside the sentence; the explanation is in each badge's tooltip and accessible name.
  const steps = (count: number) => count === 1 ? '1 step' : `${count} steps`;
  const badges = ([
    [report.actions.filter(action => action.requiresConfirm).length, 'confirm', (n: number) => n === 1 ? 'needs your OK' : 'need your OK', (n: number) => `${steps(n)} will not run until you approve.`],
    [report.actions.filter(action => action.billable).length, 'cost', (n: number) => n === 1 ? 'costs money' : 'cost money', (n: number) => `${steps(n)} ${n === 1 ? 'creates or changes' : 'create or change'} something you pay for.`],
    [report.actions.filter(action => action.dataBearing).length, 'data', (n: number) => n === 1 ? 'holds data' : 'hold data', (n: number) => `${steps(n)} ${n === 1 ? 'touches' : 'touch'} something that stores your data.`],
  ] as Array<[number, string, (n: number) => string, (n: number) => string]>).filter(([count]) => count)
    .map(([count, kind, label, tip]) => `<span class="badge" data-badge="${kind}" title="${escape(tip(count))}" aria-label="${escape(tip(count))}">${count} ${label(count)}</span>`).join('');
  const lead = [accessCheck ? '' : `<span>${escape(headline(report.actions))}</span>`, badges ? `<span class="badges">${badges}</span>` : ''].join('');
  return `${lead ? `<p class="headline">${lead}</p>` : ''}${where ? `<p class="where">${where}</p>` : ''}${metadata ? `<dl class="meta">${metadata}</dl>` : ''}
${notices ? `<section class="notices" aria-label="Plan notices">${notices}</section>` : ''}
${mapSection(map, accessCheck)}
<section aria-labelledby="review"><div class="section-head"><h2 tabindex="-1" id="review">Plan actions</h2><span class="muted">${quantity(actions.length, 'action')}</span></div>
${rows ? `<div class="review-scope" id="selected-group" hidden><a id="back-map" class="button" href="#resource-map">← Back to map</a><strong id="group-name"></strong></div>
<div class="tools" data-interactive hidden><label>Search actions<input type="search" id="search" placeholder="Search by name"></label>
<label>Action type<select id="action-type"><option value="">All types</option>${visibleTypes.map(([type, label]) => `<option value="${type}">${label}</option>`).join('')}</select></label>
<button class="button" id="reset" type="button">Clear filters</button></div>
<p class="result-count" role="status" aria-live="polite" id="result-count"></p>
<p id="empty-filter" class="empty-filter" hidden>No actions match these filters.</p><ol class="action-list">${rows}</ol>` : '<p>No actions are recorded in this plan.</p>'}
</section>`;
}

export function renderPlanReportHtml(report: PlanReport, options: { localReview?: boolean } = {}): string {
  const title = report.scope === transferFileAccessCheckScope ? 'Export file access check'
    : report.scope === transferAccessCheckScope ? 'Transfer access check' : 'Infrastructure plan';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${planReportPolicy}">
<meta name="viewport" content="width=device-width,initial-scale=1">${planIdMeta(report.planId)}<title>${escape(report.project)} · ${title} · Hypervibe</title>
<style>${planReportStyle}</style></head><body>
<a class="skip" href="#review">Skip to plan actions</a>
${options.localReview ? '' : `<header class="mast"><div class="mast-inner"><div class="brand">
<svg class="brand-mark" aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.3"><path d="m3 18 5-12m1 12 5-12m1 12 5-12"/></svg>
Hypervibe <span class="brand-topic">${title}</span></div><button id="print" class="button" data-interactive hidden>Print report</button></div></header>`}
<main><div class="title-row"><h1>${escape(report.project)}</h1>${report.environment ? `<span class="environment">Environment · ${escape(report.environment)}</span>` : ''}</div>
${renderPlanReportContent(report, options)}</main><script>${planReportBrowser}</script></body></html>\n`;
}

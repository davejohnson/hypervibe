import { createHash } from 'node:crypto';
import { transferAccessCheckScope, type PlanReport, type PlanReportAction } from '../domain/plan/plan-report.js';
import type { PlanActionType } from '../domain/plan/plan.types.js';
import { actionTitle, buildReportMap, humanize, isNamedResource, isSecretReadPermission, lanes, providerName, type MapGroup } from './plan-report-map.js';
import { planReportBrowser } from './plan-report-browser.js';
import { cloudFacts } from './plan-report-links.js';
import { groupPlanNotices } from './plan-report-notices.js';
import { planReportStyle } from './plan-report-style.js';

type ReviewActionType = PlanActionType | 'grant' | 'revoke';
const types: Record<ReviewActionType, string> = {
  create: 'Create', update: 'Update', replace: 'Replace', destroy: 'Destroy', noop: 'No change',
  grant: 'Grant access', revoke: 'Revoke access',
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
const csp = `default-src 'none'; script-src 'sha256-${digest(planReportBrowser)}'; style-src 'sha256-${digest(planReportStyle)}'; base-uri 'none'; form-action 'none'`;

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
  const changes = Object.entries(types).flatMap(([type, label]) => {
    const count = group.actions.filter(action => reviewType(action) === type).length;
    if (!count) return [];
    const summary = type === 'grant' ? quantity(count, 'new permission') : type === 'revoke' ? quantity(count, 'permission removal') : `${count} ${label.toLowerCase()}`;
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

const codeList = (values: string[]) => values.length ? `<ul>${values.map(value => `<li><code>${escape(value)}</code></li>`).join('')}</ul>` : '';

function actionRow(action: PlanReportAction, index: number, group: MapGroup, indexes: Map<string, number | null>, accessCheck: boolean) {
  const type = reviewType(action);
  const title = actionTitle(action);
  const name = title !== action.name ? fact('Resource name', escape(action.name)) : '';
  const flags = [
    action.billable && 'May incur charges', action.dataBearing && 'Contains data', action.requiresConfirm && 'Confirmation required',
  ].filter(Boolean);
  const dependencies = action.dependsOn.map(id => {
    const target = indexes.get(id);
    const code = `<code>${escape(id)}</code>`;
    return `<li>${typeof target === 'number' ? `<a href="#action-${target}">${code}</a>` : code}</li>`;
  });
  const anchor = group.actions[0] === action ? `<span id="group-${group.index}"></span>` : '';
  return `<li id="action-${index}" class="action-row" data-type="${escape(type)}" data-group="${group.index}">${anchor}
    <details><summary><span class="status">${types[type]}</span>
    <span class="action-main"><span class="action-name">${escape(title)}</span><span class="action-kind">${escape(group.title)} · ${escape(providerName(action.provider))}</span></span></summary>
    <div class="detail"><div class="bits">${flags.map(label => `<span>${label}</span>`).join('')}</div>
    ${action.reason ? `<p>${escape(action.reason)}</p>` : ''}<dl>
    ${fact('Action ID', `<code>${escape(action.id)}</code>`)}${name}
    ${accessCheck ? '' : fact('Plan evidence', action.verified ? 'Verified at planning time' : 'Unverified at planning time')}
    ${fact('Changed fields', codeList(action.fields))}${fact('Resource addresses', codeList(action.addresses))}
    ${fact('Depends on', dependencies.length ? `<ul>${dependencies.join('')}</ul>` : 'No recorded prerequisites')}</dl></div></details></li>`;
}

export function renderPlanReportHtml(report: PlanReport): string {
  const accessCheck = report.scope === transferAccessCheckScope;
  const title = accessCheck ? 'Transfer access check' : 'Infrastructure plan';
  const map = buildReportMap(report.actions);
  const indexes = new Map<string, number | null>();
  report.actions.forEach((action, i) => indexes.set(action.id, indexes.has(action.id) ? null : i));
  const visibleTypes = Object.entries(types).filter(([type]) =>
    (type !== 'grant' && type !== 'revoke') || report.actions.some(action => reviewType(action) === type));
  const stats = visibleTypes.map(([type, label]) => {
    const count = report.actions.filter(action => reviewType(action) === type).length;
    return `<div class="stat${count ? ' has-actions' : ''}" data-type="${type}"><strong>${count}</strong><span>${label}</span></div>`;
  }).join('');
  const rows = report.actions.map((action, index) =>
    actionRow(action, index, map.groupByAction.get(action)!, indexes, accessCheck)).join('');
  const { warnings, costs, next, detail } = groupPlanNotices(report);
  const notices = notice('Blockers', report.blocked, 'blocked') + notice('Warnings', warnings, 'warning')
    + notice('Database cost and protection', costs, 'info') + notice('What happens next', next, 'info', detail);
  const metadata = [
    fact('Scope', escape(humanize(report.scope))),
    ...cloudFacts(report).map(({ label, value, href }) => typeof value === 'string' ? fact(label, href
      ? `<a href="${escape(href)}" rel="noreferrer" aria-label="${escape(label + ' ' + value)}">${escape(value)}</a>`
      : escape(value)) : ''),
    fact('Plan ID', escape(report.planId)), fact('Created', report.createdAt && escape(report.createdAt)),
    fact('Approval', report.approval === 'whole-plan' ? 'Approve the whole plan in the chat or terminal where you requested it.' : undefined),
  ].join('');
  const flaggedCounts = [
    [report.actions.filter(action => action.requiresConfirm).length, 'Confirmation required'],
    [report.actions.filter(action => action.billable).length, 'May incur charges'],
    [report.actions.filter(action => action.dataBearing).length, 'Handle persistent data'],
  ].filter(([count]) => count).map(([count, label]) => `<span>${label} <b>${count}</b></span>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(report.project)} · ${title} · Hypervibe</title>
<style>${planReportStyle}</style></head><body>
<a class="skip" href="#review">Skip to plan actions</a>
<header class="mast"><div class="mast-inner"><div class="brand">
<svg class="brand-mark" aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.3"><path d="m3 18 5-12m1 12 5-12m1 12 5-12"/></svg>
Hypervibe <span class="brand-topic">${title}</span></div><button id="print" class="button" data-interactive hidden>Print report</button></div></header>
<main><div class="title-row"><h1>${escape(report.project)}</h1>${report.environment ? `<span class="environment">Environment · ${escape(report.environment)}</span>` : ''}</div>
<dl class="meta">${metadata}</dl><div class="counts" aria-label="Action counts">${stats}</div>
${flaggedCounts ? `<div class="review-flags" aria-label="Actions to review">${flaggedCounts}</div>` : ''}
${notices ? `<section class="notices" aria-label="Plan notices">${notices}</section>` : ''}
${mapSection(map, accessCheck)}
<section aria-labelledby="review"><div class="section-head"><h2 tabindex="-1" id="review">Plan actions</h2><span class="muted">${quantity(report.actions.length, 'action')}</span></div>
${rows ? `<div class="review-scope" id="selected-group" hidden><a id="back-map" class="button" href="#resource-map">← Back to map</a><strong id="group-name"></strong></div>
<div class="tools" data-interactive hidden><label>Search actions<input type="search" id="search" placeholder="Name, field or action ID"></label>
<label>Action type<select id="action-type"><option value="">All types</option>${visibleTypes.map(([type, label]) => `<option value="${type}">${label}</option>`).join('')}</select></label>
<button class="button" id="reset" type="button">Clear filters</button></div>
<p class="result-count" role="status" aria-live="polite" id="result-count"></p>
<p id="empty-filter" class="empty-filter" hidden>No actions match these filters.</p><ol class="action-list">${rows}</ol>` : '<p>No actions are recorded in this plan.</p>'}
</section></main><script>${planReportBrowser}</script></body></html>\n`;
}

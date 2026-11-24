import { createHash } from 'node:crypto';
import type { ReviewArtifact } from '../adapters/storage/local-review-catalog.js';
import { renderPlanReportContent } from './plan-report-html.js';
import { planReportBrowser } from './plan-report-browser.js';
import { planReportStyle } from './plan-report-style.js';
import { LOCAL_PAGE_ICON_LINK } from '../utils/local-page-icon.js';
import { localTimeScript, timeTag } from './local-time.js';

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const style = `
:root { color-scheme: dark; font: 16px/1.5 -apple-system, BlinkMacSystemFont,"Segoe UI",sans-serif; color: #edf3f4; background: #0c1114 }
* { box-sizing: border-box }
body, h1, h2, p, ul, dl, dd { margin: 0 }
body { overflow-wrap: anywhere }
header { border-bottom: 1px solid #35444b }
.bar, main { width: min(1080px, calc(100% - 40px)); margin: auto }
.bar, nav, .review-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap }
.bar { min-height: 58px; justify-content: space-between }
.brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 650; color: #edf3f4; text-decoration: none }
.brand svg, a { color: #8ce2bb }
a { text-underline-offset: .2em }
nav { font-size: .9rem }
main { padding: clamp(28px, 5vw, 58px) 0 64px }
h1 { font-size: clamp(2rem, 4vw, 3rem); line-height: 1.12; letter-spacing: -.045em }
h2 { font-size: 1.2rem; letter-spacing: -.02em }
.kind { font-size: .87rem; color: #afc0c7; margin-bottom: 6px }
main > section { margin-top: 28px }
.review-meta { margin-top: 12px; color: #bac8cd; font-size: .9rem; gap: 8px 18px }
.review-meta div { display: flex; gap: 6px }
.review-meta dt { color: #93a6ae }
.current-state { margin-top: 14px }
.state { display: inline-flex; align-items: center; gap: 8px; color: #c6d3d8; font-size: .88rem; font-weight: 600 }
.state:before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none }
.pending { color: #ffd48a }
.done { color: #91e2ba }
.failed { color: #ffb0a0 }
.records { list-style: none; padding: 0; margin-top: 20px; border-top: 1px solid #35444b }
.records li { border-bottom: 1px solid #35444b }
.record { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px 20px; padding: 16px 4px; color: inherit; text-decoration: none }
.record:hover .name { text-decoration: underline; text-underline-offset: .2em }
.name { display: block; color: #eaf3ef; font-weight: 600 }
.sub { display: block; color: #afc0c7; font-size: .85rem; margin-top: 3px }
.arrow { color: #8ce2bb; font-size: 1.3rem }
.evidence { padding: 20px clamp(14px, 3vw, 26px); background: #131b1f; border: 1px solid #35444b; border-radius: 10px }
.review-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 16px 28px }
.review-heading > :first-child { flex: 1 1 26rem; min-width: 0 }
.decision { max-width: 23rem; margin: 0 }
.decision p { margin-top: 6px; color: #bac8cd; font-size: .9rem }
.decision p:empty { display: none }
.decision button { font: inherit; font-weight: 650; border: 0; border-radius: 6px; padding: 10px 20px; color: #0c221b; background: #90e4bc; cursor: pointer }
.decision button:hover { background: #a7efcd }
.decision button:disabled { opacity: .65; cursor: wait }
.evidence { margin-top: 28px }
.plan-details { padding-top: 12px; border-top: 1px solid #35444b }
.evidence ul { padding-left: 1.2rem; margin-top: 8px }
.evidence li+li { margin-top: .4rem }
a:focus-visible, button:focus-visible { outline: 2px solid #8ce2bb; outline-offset: 4px }
.search { display: grid; gap: 5px; margin: 24px 0 0; max-width: 30rem; font-weight: 600 }
.search input { width: 100%; padding: 9px 12px; background: #131b1f; border: 1px solid #52636b; border-radius: 6px; color: #edf3f4; font: inherit; font-weight: 400 }
.search input:focus { outline: 2px solid #8ce2bb; outline-offset: 2px }
[hidden] { display: none!important }
.empty { margin: 12px 0; color: #bac8cd }
@media(max-width:570px) { .bar, main { width: calc(100% - 28px) }
.record { grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px }
.record .state { grid-row: 2 }
.arrow { grid-column: 2; grid-row: 1/3 }
.review-meta { align-items: flex-start; column-gap: 10px }
}
@media print { #approval, nav, #feedback { display: none } }
`;

// A fetch in CORS mode retains the browser's exact Origin with a no-referrer policy.
const approvalScript = `
const form = document.querySelector('#approval');
form.hidden = false;
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  const status = document.querySelector('#feedback');
  button.disabled = true;
  try {
    const reply = await fetch(form.action, {method:'POST', mode:'cors', referrerPolicy:'no-referrer',
      body:new URLSearchParams(new FormData(form))});
    if (reply.status === 204) { location.reload(); return; }
    status.textContent = reply.status === 409 ? 'This plan changed. Reload the page to review its current status.' : 'Approval was not saved. Reload the page and try again.';
  } catch { status.textContent = 'The local service could not be reached. Reload to check whether approval was saved.'; }
  button.disabled = false;
});
`;
const filterScript = `
const input = document.querySelector('#query');
const rows = Array.from(document.querySelectorAll('.records li'));
document.querySelector('.search').hidden = false;
function filter() {
  const parts = input.value.toLowerCase().trim().split(/\\s+/);
  let visible = 0;
  for (const row of rows) {
    const text = row.textContent.toLowerCase() + ' ' + row.querySelector('a').pathname.split('/').pop().toLowerCase();
    row.hidden = !parts.every(part => text.includes(part));
    if (!row.hidden) visible++;
  }
  document.querySelector('#no-matches').hidden = visible !== 0;
}
input.addEventListener('input', filter);
filter();
`;
const hashSource = (text: string) => "'sha256-" + createHash('sha256').update(text).digest('base64') + "'";
export function reviewPagePolicy(withReport = false) {
  const styles = withReport ? [style, planReportStyle] : [style];
  // The report's own script already sets local times.
  const scripts = withReport ? [approvalScript, filterScript, planReportBrowser] : [approvalScript, filterScript, localTimeScript];
  return `default-src 'none'; img-src data:; style-src ${styles.map(hashSource).join(' ')}; script-src ${scripts.map(hashSource).join(' ')}; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`;
}

function page(title: string, home: string, body: string, script?: string, withReport = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Hypervibe</title>${LOCAL_PAGE_ICON_LINK}${withReport ? `<style>${planReportStyle}</style>` : ''}<style>${style}</style></head><body>
${withReport ? '<a class="skip" href="#review">Skip to plan actions</a>' : ''}<header><div class="bar"><a class="brand" href="${home}"><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.3"><path d="m3 18 5-12m1 12 5-12m1 12 5-12"/></svg>Hypervibe</a>
<nav aria-label="Review navigation"><a href="${home}">Saved reviews</a></nav></div></header>
<main>${body}</main>${withReport ? `<script>${planReportBrowser}</script>` : `<script>${localTimeScript}</script>`}${script ? `<script>${script}</script>` : ''}</body></html>`;
}
function state(item: ReviewArtifact) {
  const status = item.status;
  const label = item.previouslyApproved && status !== 'Approved' ? 'Approved · ' + status : status;
  const tone = /fail|block|cancel|error/i.test(status) ? 'failed' : /await|pending|running/i.test(status) ? 'pending'
    : /approved|applied|success|completed|passed/i.test(status) ? 'done' : '';
  return `<span class="state ${tone}">${escape(label)}</span>`;
}
const kind = (item: ReviewArtifact) => item.kind === 'plan' ? 'Plan' : 'Result';

function recordList(items: ReviewArtifact[], home: string) {
  return `<ul class="records">${items.map(item => {
    const context = [escape(kind(item)), item.project && escape(item.project), timeTag(item.createdAt)].filter(Boolean).join(' · ');
    const slug = encodeURIComponent(item.aliases[0] ?? item.id);
    return `<li><a class="record" href="${home}r/${slug}"><span><span class="name">${escape(item.title)}</span><span class="sub">${context}</span></span>${state(item)}<span class="arrow" aria-hidden="true">→</span></a></li>`;
  }).join('')}</ul>`;
}
export function reviewIndex(items: ReviewArtifact[], home: string) {
  const search = '<label class="search" hidden>Find a review<input type="search" id="query" placeholder="Search by name, project or status"></label>';
  return page('Saved reviews', home, '<h1>Saved reviews</h1>' + (items.length
    ? search + recordList(items, home) + '<p class="empty" id="no-matches" role="status" hidden>No reviews match this search.</p>'
    : '<p class="empty">Plans and results saved by Hypervibe will appear here.</p>'), items.length ? filterScript : undefined);
}
export function reviewDetail(item: ReviewArtifact, home: string, path: string, related: ReviewArtifact[], csrf?: string) {
  const meta = [['Project', item.project && escape(item.project)], ['Environment', item.report?.environment && escape(item.report.environment)], ['Saved', timeTag(item.createdAt)]]
    .filter(([, value]) => value).map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join('');
  const details = item.details.length ? `<section class="evidence"><h2>${item.kind === 'result' ? 'Recorded outcome' : 'Plan summary'}</h2>
<ul>${item.details.map(detail => `<li>${escape(detail)}</li>`).join('')}</ul></section>` : '';
  const report = item.report ? `<section class="plan-details" aria-label="Plan details">${renderPlanReportContent(item.report, { localReview: true })}</section>` : '';
  const approval = csrf && item.approval ? `<div class="decision"><form hidden id="approval" method="post" action="${path}/approve">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="digest" value="${escape(item.approval.digest)}"><button type="submit" aria-describedby="approval-note">Approve plan</button></form>
<p id="approval-note">Once you approve, your agent carries out exactly what is listed here, nothing more.</p><p id="feedback" role="status" aria-live="polite"></p><noscript>Enable JavaScript to approve this plan.</noscript></div>`
    : item.approval?.approvedAt ? `<div class="decision"><h2>Approval recorded</h2><p>Approved ${timeTag(item.approval.approvedAt)}.</p></div>` : '';
  const links = related.length ? `<section><h2>Related reviews</h2>${recordList(related, home)}</section>` : '';
  const heading = `<div class="review-heading"><div><p class="kind">${kind(item)}</p><h1>${escape(item.title)}</h1><dl class="review-meta">${meta}</dl><div class="current-state">${state(item)}</div></div>${approval}</div>`;
  return page(item.title, home, heading + details + report + links, csrf ? approvalScript : undefined, Boolean(item.report));
}

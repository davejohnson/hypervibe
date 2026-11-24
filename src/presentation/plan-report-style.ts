// Standalone versions of Hypercloud's resource-map canvas, zones, cards and wires.
// Keep the browser report independent of the dashboard's Tailwind build.
export const planReportStyle = `
:root {
  color-scheme: dark;
  --page: #0c1114; --surface: #131b1f; --frame: #35444b; --muted: #acbbc2;
  --text: #edf3f4; --signal: #8ce2bb;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--text); background: var(--page);
}
* { box-sizing: border-box; }
body { margin: 0; overflow-wrap: anywhere; }
main, .mast-inner { width: min(1170px, calc(100% - 48px)); margin-inline: auto; }
main { padding-block: 32px 70px; }
h1, h2, h3, p, dl, dd, ol, ul { margin: 0; }
h1 { font-size: clamp(2rem, 4.8vw, 3.4rem); line-height: 1.1; letter-spacing: -.045em; }
h2 { font-size: 1.38rem; letter-spacing: -.025em; }
h3 { font-size: 1rem; }
a { color: var(--signal); text-underline-offset: .2em; }
button, input, select { font: inherit; }
button, select { cursor: pointer; }
:focus-visible { outline: 2px solid var(--signal); outline-offset: 4px; }
[hidden] { display: none !important; }
.mast { border-bottom: 1px solid var(--frame); }
.mast-inner, .brand, .title-row, .section-head, .tools, .action-main, .counts, .bits {
  display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
}
.mast-inner { min-height: 54px; justify-content: space-between; }
.brand { font-size: .9rem; font-weight: 650; letter-spacing: -.015em; }
.brand-mark { color: var(--signal); }
.brand-topic { color: var(--muted); font-weight: 450; border-left: 1px solid var(--frame); padding-left: 12px; }
.button, select, input { color: var(--text); background: var(--surface); border: 1px solid var(--frame); border-radius: 6px; padding: 7px 11px; }
.button { font-size: .86rem; text-decoration: none; }
.button:hover, select:hover { border-color: var(--muted); }
.title-row { align-items: baseline; gap: 14px; }
.environment { border: 1px solid var(--frame); color: var(--muted); font-size: .86rem; padding: 2px 9px; border-radius: 5px; }
.meta { display: flex; gap: 12px 30px; flex-wrap: wrap; margin-top: 18px; }
dt, .muted, .node-description { color: var(--muted); }
dt { font-size: .78rem; }
dd { margin-top: 3px; }
code, .mono { font: .89em/1.45 ui-monospace, "SFMono-Regular", Consolas, monospace; }
.counts { align-items: stretch; margin-top: 23px; border-block: 1px solid var(--frame); gap: 0; }
.stat { flex: 1 1 90px; padding: 12px 12px 12px 0; }
.stat strong { display: block; font-size: 1.4rem; font-variant-numeric: tabular-nums; line-height: 1.25; }
.stat span, .node-status, .status { font-size: .82rem; }
.stat span { color: var(--muted); }
.review-flags { display: flex; gap: 6px 22px; flex-wrap: wrap; color: var(--muted); padding-top: 10px; font-size: .84rem; }
.review-flags b { color: var(--text); margin-left: 3px; font-variant-numeric: tabular-nums; }
[data-type="create"], [data-type="grant"] { --status: #8ce2bb; } [data-type="update"] { --status: #a6c7ed; }
[data-type="replace"] { --status: #f4c481; } [data-type="destroy"], [data-type="revoke"] { --status: #ffa29d; }
[data-type="noop"] { --status: #aab7bc; }
.stat.has-actions strong, .status { color: var(--status); }
section { margin-top: 30px; }
.section-head { align-items: baseline; justify-content: space-between; gap: 5px 20px; margin-bottom: 10px; }
.section-head .muted, .map-note { font-size: .88rem; }
.notices { display: grid; gap: 10px; }
.notice { border-left: 3px solid #f4c481; background: var(--surface); padding: 10px 14px; }
.notice.info { border-color: var(--frame); }
.notice.blocked { border-color: #ffa29d; }
.notice ul { padding-left: 20px; }
.resource-map {
  position: relative; padding: clamp(13px, 2vw, 24px); border-radius: 12px; border: 1px solid var(--frame);
  background: radial-gradient(circle, #29353a 1px, transparent 1px) 0 0 / 18px 18px, #0b1013;
}
.map-canvas { position: relative; }
.map-grid { position: relative; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: 24px; }
.map-zone { align-self: start; min-width: 0; padding: 10px; border: 1px dashed #3a4a51; border-radius: 9px; }
.map-zone h3 { margin: 0 1px 9px; color: var(--muted); text-transform: uppercase; letter-spacing: .07em; font-size: .69rem; font-weight: 600; }
.map-node { position: relative; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 9px;
  margin-top: 8px; padding: 10px; border: 1px solid var(--frame); border-radius: 8px; background: #161e22; text-decoration: none; color: var(--text); }
.map-node:hover, .map-node[aria-current="true"] { border-color: #b0c1c7; box-shadow: 0 0 0 3px #ffffff10; }
.map-node-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 5px; background: #263239; color: #d9e4e8; }
.map-node-icon svg { width: 17px; height: 17px; }
.node-title, .node-description { display: block; }
.node-title { font-size: .9rem; font-weight: 650; line-height: 1.3; }
.node-description { font-size: .75rem; margin-top: 2px; }
.map-arrow { color: var(--muted); }
.map-wires { position: absolute; inset: 0; height: 100%; width: 100%; overflow: visible; pointer-events: none; }
.map-wire { fill: none; stroke: #728b97; stroke-width: 1.8; }
.map-note { margin-top: 12px; color: var(--muted); }
.tools { align-items: end; gap: 10px 14px; margin-bottom: 10px; }
.tools label { display: grid; gap: 3px; font-size: .84rem; color: var(--muted); }
.tools label:first-child { flex: 1 1 200px; max-width: 35ch; }
input, select { width: 100%; font-size: .92rem; }
.review-scope { margin-bottom: 12px; }
.result-count { color: var(--muted); font-size: .84rem; margin-bottom: 7px; }
.action-list { list-style: none; padding: 0; border-block: 1px solid var(--frame); }
.action-row + .action-row { border-top: 1px solid #28363d; }
.action-row { scroll-margin-top: 14px; }
.action-row summary { cursor: pointer; display: flex; gap: 10px; padding: 12px 6px; align-items: baseline; }
.action-row summary::marker, .action-row summary::-webkit-details-marker { display: none; content: ''; }
.action-row summary::before { content: '›'; color: var(--muted); font-size: 1.05rem; line-height: 1; }
.action-row details[open] > summary::before { transform: rotate(90deg); }
.action-row summary:hover { background: var(--surface); }
.action-main { flex: 1; gap: 4px 14px; }
.action-name { flex: 1 1 17rem; min-width: 0; font-weight: 600; }
.action-kind { font-size: .8rem; color: var(--muted); }
.status { flex: 0 0 5.4em; font-weight: 650; }
.detail { padding: 3px 22px 17px; }
.detail dl { margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 10px 24px; }
.detail dd { font-size: .9rem; }
.detail ul { padding-left: 18px; }
.bits { gap: 5px 14px; color: #e9cc97; font-size: .85rem; }
.bits:empty { display: none; }
.review-scope a { margin-right: 9px; }
.skip { position: absolute; top: -10em; }
.skip:focus { top: .4em; z-index: 4; background: var(--page); }
@media (max-width: 760px) {
  .map-grid { grid-auto-flow: row; grid-template-columns: minmax(0,1fr); gap: 18px; }
  .stat { flex-basis: 75px; }
}
@media (max-width: 450px) {
  main, .mast-inner { width: calc(100% - 28px); }
  .action-kind { width: 100%; }
  .stat { flex: 1 0 30%; }
}
@media (prefers-reduced-motion: no-preference) {
  .map-node { transition: border-color 140ms, box-shadow 140ms; }
}
@media print {
  :root { color-scheme: light; --page: white; --surface: white; --text: black; --muted: #374047; --frame: #acb6bc; font-size: 10pt; }
  main, .mast-inner { width: 100%; }
  main { padding: 12px 0; }
  .mast, .tools, .button, .review-scope, .result-count, .empty-filter, .map-arrow, .skip { display: none !important; }
  .resource-map, .map-node, .notice { background: white; }
  .map-node, .map-node-icon, .stat.has-actions strong, .status, .bits, a { color: black; }
  .map-node-icon { background: transparent; }
  .map-grid { display: flex; flex-wrap: wrap; }
  .map-zone { flex: 1 1 120px; }
  .map-wires { display: none; }
  .action-row[hidden] { display: list-item !important; }
  details::details-content { display: block; content-visibility: visible; }
  .action-row summary, .detail { padding: 4px 0; }
  .detail dl { margin-top: 4px; }
  .detail { margin-bottom: 9px; }
  .action-row { break-inside: avoid; }
  section { margin-top: 14px; }
}
.headline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; font-size: 1.15rem; margin: 14px 0 4px }
.badges { display: inline-flex; flex-wrap: wrap; gap: 6px }
.badge { font-size: .78rem; font-weight: 600; padding: 2px 9px; border: 1px solid var(--frame); border-radius: 999px; color: var(--muted); cursor: help; white-space: nowrap }
.badge[data-badge="confirm"] { color: var(--text) }
`;

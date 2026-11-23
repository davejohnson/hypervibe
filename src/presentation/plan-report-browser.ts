// Only static program text is embedded in the report. User data stays in escaped
// HTML, and selectors and fragment identifiers use generated numeric indexes.
import { localTimeScript } from './local-time.js';

export const planReportBrowser = localTimeScript + `
(() => {
  const rows = [...document.querySelectorAll('.action-row')];
  const search = document.getElementById('search');
  const type = document.getElementById('action-type');
  const count = document.getElementById('result-count');
  const review = document.getElementById('review');
  const back = document.getElementById('back-map');
  const selected = document.getElementById('selected-group');
  const nodes = [...document.querySelectorAll('.map-node')];
  const canvas = document.querySelector('.map-canvas');
  let activeGroup = null;
  let previousGroup = null;

  function filter() {
    if (!search) return;
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const row of rows) {
      row.hidden = (activeGroup !== null && row.dataset.group !== activeGroup) ||
        (type.value && row.dataset.type !== type.value) || !row.textContent.toLowerCase().includes(query);
      if (!row.hidden) visible++;
    }
    count.textContent = visible + ' of ' + rows.length + ' actions';
    document.getElementById('empty-filter').hidden = visible !== 0;
  }
  function clearFilters() {
    search.value = '';
    type.value = '';
  }
  function synchronize(moveFocus) {
    if (!search) return;
    const hash = location.hash.slice(1);
    const node = nodes.find(item => 'group-' + item.dataset.group === hash);
    const row = rows.find(item => item.id === hash);
    activeGroup = node ? node.dataset.group : null;
    for (const item of nodes) {
      if (item === node) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
    selected.hidden = !node;
    if (node) {
      previousGroup = node;
      document.getElementById('group-name').textContent = node.querySelector('.node-title').textContent;
    }
    if (row || node) clearFilters();
    filter();
    if (row) {
      row.querySelector('details').open = true;
      if (moveFocus) row.querySelector('summary').focus();
    } else if (moveFocus && node) {
      review.focus();
      review.scrollIntoView({block: 'start'});
    } else if (moveFocus && hash === 'resource-map' && previousGroup) {
      previousGroup.focus();
    }
  }

  // As in Hypercloud, measure the real card positions after layout. The SVG
  // sits behind the buttons. Recompute on resize for the stacked mobile map.
  function drawWires() {
    if (!canvas) return;
    const svg = canvas.querySelector('svg');
    const origin = canvas.getBoundingClientRect();
    const boxFor = key => {
      const box = nodes.find(item => item.dataset.group === key).getBoundingClientRect();
      return { left: box.left - origin.left, right: box.right - origin.left, top: box.top - origin.top,
        bottom: box.bottom - origin.top, x: (box.left + box.right) / 2 - origin.left,
        y: (box.top + box.bottom) / 2 - origin.top };
    };
    for (const path of svg.querySelectorAll('[data-from]')) {
      const a = boxFor(path.dataset.from);
      const b = boxFor(path.dataset.to);
      let d;
      if (b.left >= a.right || b.right <= a.left) {
        const forward = b.left >= a.right;
        const start = forward ? a.right : a.left;
        const end = forward ? b.left : b.right;
        const mid = (start + end) / 2;
        d = ['M', start, a.y, 'C', mid, a.y, mid, b.y, end, b.y];
      } else {
        // Use the gutter so a wire between stacked cards doesn't cross the
        // cards in between, including when the layout fits a single column.
        const gutter = Math.max(a.right, b.right) + 7;
        d = ['M', a.right, a.y, 'C', gutter + 2, a.y, gutter, a.y, gutter, a.y + Math.sign(b.y - a.y) * 4,
          'L', gutter, b.y - Math.sign(b.y - a.y) * 4, 'Q', gutter, b.y, b.right, b.y];
      }
      path.setAttribute('d', d.join(' '));
    }
  }
  document.querySelectorAll('[data-interactive]').forEach(item => { item.hidden = false; });
  if (search) {
    search.addEventListener('input', filter);
    type.addEventListener('change', filter);
    document.getElementById('reset').addEventListener('click', () => { clearFilters(); filter(); search.focus(); });
    window.addEventListener('hashchange', () => synchronize(true));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && activeGroup !== null) { event.preventDefault(); back.click(); }
    });
    synchronize(Boolean(location.hash));
  }
  if (canvas) {
    if ('ResizeObserver' in window) new ResizeObserver(drawWires).observe(canvas);
    else window.addEventListener('resize', drawWires);
    drawWires();
  }
  document.getElementById('print')?.addEventListener('click', () => window.print());
  let closed = [];
  window.addEventListener('beforeprint', () => {
    closed = rows.map(row => row.querySelector('details')).filter(detail => !detail.open);
    closed.forEach(detail => { detail.open = true; });
  });
  window.addEventListener('afterprint', () => { closed.forEach(detail => { detail.open = false; }); });
})();
`;

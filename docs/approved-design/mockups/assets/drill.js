/* Drill-through layer for the redesign mockups.
   One consistent pattern everywhere: clicking a data row opens a right slide-over
   panel (same surface language as the live Data-health drawer) whose content is
   assembled from that row's real data. The commissions leaderboard instead expands
   INLINE (per the live app) — see commissions.html.
   Implementation note: in the real app these panels navigate to / fetch the full
   drilldown (job detail, technician detail, site jobs); the mockup panel shows the
   row's own facts plus the target described in each card's subtitle. */

function drillPanel(title, sub, bodyHtml) {
  let ov = document.querySelector('.drillover');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'drillover';
    ov.innerHTML = '<div class="drillscrim"></div><aside class="drillpanel" role="dialog" aria-modal="true"><header><div><h2></h2><p class="dsub"></p></div><button class="dclose" aria-label="Close">✕</button></header><div class="dbody"></div><p class="dnote">Mockup drill-through — the implementation opens the full record here (same slide-over pattern as the Data-health drawer).</p></aside>';
    document.body.appendChild(ov);
    ov.querySelector('.drillscrim').addEventListener('click', drillClose);
    ov.querySelector('.dclose').addEventListener('click', drillClose);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') drillClose(); });
  }
  ov.querySelector('h2').textContent = title;
  ov.querySelector('.dsub').textContent = sub || '';
  ov.querySelector('.dbody').innerHTML = bodyHtml;
  ov.classList.add('open');
  ov.querySelector('.dclose').focus();
}
function drillClose() { document.querySelector('.drillover')?.classList.remove('open'); }

function kv(label, value) {
  return `<div class="dkv"><span>${label}</span><b>${value}</b></div>`;
}

document.addEventListener('DOMContentLoaded', () => {
  // data-table rows (completed jobs, net-negative jobs, monthly breakdown)
  document.querySelectorAll('table.data tr.click').forEach((tr) => {
    tr.setAttribute('tabindex', '0');
    const open = () => {
      const heads = [...tr.closest('table').querySelectorAll('thead th')].map((h) => h.textContent.trim());
      const cells = [...tr.children];
      const first = cells[0];
      const title = first.querySelector('b')?.textContent || first.textContent.trim();
      const sub = first.querySelector('.cellsub')?.textContent || '';
      let html = '';
      cells.forEach((td, i) => {
        if (i === 0) return;
        const v = td.textContent.trim();
        if (v) html += kv(heads[i] || '', v);
      });
      drillPanel(title, sub, html);
    };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });

  // bar-list rows that promise drill-through (sites, deal-size tiers, work source, economics)
  document.querySelectorAll('.barlist .brow').forEach((row) => {
    if (row.classList.contains('total')) return;
    const name = row.querySelector('.name'); if (!name) return;
    row.classList.add('drillable');
    row.setAttribute('tabindex', '0');
    const open = () => {
      const rv = row.querySelector('.rv')?.textContent.trim() || '';
      const meta = row.querySelector('.meta')?.textContent.trim() || '';
      drillPanel(name.textContent.trim(), row.closest('.cardx')?.querySelector('.ti')?.textContent || '',
        kv('Value', rv) + (meta ? kv('Detail', meta) : ''));
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });

  // technician capacity rows + scorecard handled by table.data above; capacity rows:
  document.querySelectorAll('.caprows .crow').forEach((row) => {
    row.setAttribute('tabindex', '0');
    row.classList.add('drillable');
    const open = () => {
      const split = (row.dataset.split || '').split('|').filter(Boolean);
      drillPanel(row.querySelector('.cname').textContent.trim(), 'July hours · unbilled split from Simpro activity schedules',
        kv('This month', row.querySelector('.cmeta').textContent.trim()) +
        (split.length ? split.map((s) => { const i = s.lastIndexOf(' '); return kv(s.slice(0, i), s.slice(i + 1)); }).join('') : kv('Unbilled activity', 'none recorded')));
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });

  // heatmap cells: hover title + click detail
  document.querySelectorAll('.heatmap td.cell').forEach((cell) => {
    const tier = cell.parentElement.querySelector('.tier')?.textContent.trim();
    const headRow = cell.closest('table').querySelector('thead tr');
    const month = headRow?.children[cell.cellIndex]?.textContent.trim();
    const rep = cell.classList.contains('hatch') ? ' · representative' : ' · Simpro-verified';
    cell.setAttribute('title', `${tier} · ${month} · ${cell.textContent.trim()} acceptance${rep}`);
  });
});

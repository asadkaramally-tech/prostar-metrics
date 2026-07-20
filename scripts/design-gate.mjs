// Objective gate for the metrics redesign mockups (adversarial-ui-review harness).
// Run: node docs/design/metrics-mockups/review-workspace/gate.mjs
// Exits non-zero on any violation. Screenshots land in review-workspace/shots/.
// playwright is not (yet) a repo dependency; fall back to a sibling checkout's install.
let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  ({ chromium } = await import('file:///Users/asadkaramally/Documents/Codex/2026-05-28/prostar-quote-workflow-completion/node_modules/playwright/index.mjs'));
}
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Design gate for the LIVE APP (adapted from the approved-mockup gate).
// Usage: node scripts/design-gate.mjs [baseUrl] [page,page,...]
const BASE = process.argv[2] || 'http://localhost:3000';
const ONLY = (process.argv[3] || '').split(',').filter(Boolean);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = resolve(root, 'design-gate-shots');
mkdirSync(shots, { recursive: true });

const PAGES = {
  quotes: { url: '/quotes', primarySel: '[data-primary-viz]' },
  jobs: { url: '/jobs', primarySel: '[data-primary-viz]' },
  technicians: { url: '/technicians', primarySel: '[data-primary-viz]' },
  commissions: { url: '/commissions', primarySel: '[data-primary-viz]' },
  materials: { url: '/materials', primarySel: '[data-primary-viz]' },
};

const failures = [];
const notes = [];
function fail(page, rule, detail) { failures.push(`[${page}] ${rule}: ${detail}`); }

// WCAG relative luminance + ratio
function lum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const browser = await chromium.launch();
for (const [name, cfg] of Object.entries(PAGES)) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + cfg.url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // 1. no horizontal overflow at several widths — page-level AND card-level
  for (const w of [1440, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 1) fail(name, `overflow@${w}`, `page scrolls horizontally by ${over}px`);
    // content escaping its card (overflow:visible spill — invisible to page scrollWidth)
    const spills = await page.evaluate(() => {
      const bad = [];
      for (const card of document.querySelectorAll('.cardx, .kpi, .banner')) {
        if (card.scrollWidth > card.clientWidth + 1) {
          bad.push(`${card.className.toString().slice(0, 30)} scrollW=${card.scrollWidth} clientW=${card.clientWidth}`);
        }
      }
      return bad;
    });
    for (const s of spills) fail(name, `card-spill@${w}`, s);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);

  // 2. primary visualization fully above the fold (900px)
  const box = await page.locator(cfg.primarySel).first().boundingBox({ timeout: 3000 }).catch(() => null);
  if (!box) fail(name, 'fold', `primary selector ${cfg.primarySel} not found`);
  else if (box.y + box.height > 900) fail(name, 'fold', `${cfg.primarySel} bottom at ${Math.round(box.y + box.height)}px > 900px viewport`);

  // 2b. desktop composition: at 1440, multi-card rows end flush (≤28px bottom delta)
  // and no placeholder-empty KPI sub-lines exist
  const comp = await page.evaluate(() => {
    const bad = [];
    for (const grid of document.querySelectorAll('.grid12')) {
      const cards = [...grid.children].filter((c) => c.offsetHeight > 0);
      const rows = new Map();
      for (const c of cards) {
        const top = Math.round(c.getBoundingClientRect().top / 8) * 8;
        if (!rows.has(top)) rows.set(top, []);
        rows.get(top).push(c);
      }
      for (const [, row] of rows) {
        if (row.length < 2) continue;
        const bottoms = row.map((c) => c.getBoundingClientRect().bottom);
        const delta = Math.max(...bottoms) - Math.min(...bottoms);
        if (delta > 28) {
          bad.push(`row [${row.map((c) => c.querySelector('.ti')?.textContent || c.className).join(' | ')}] bottom delta ${Math.round(delta)}px > 28px`);
        }
      }
    }
    for (const sub of document.querySelectorAll('.kpi .sub')) {
      if (sub.textContent.replace(/ /g, '').trim() === '') bad.push('placeholder-empty .kpi .sub (banned)');
    }
    return bad;
  });
  for (const c of comp) fail(name, 'composition@1440', c);

  // 2c. interior voids: no content-free vertical block > 64px inside any card at 1440
  const voids = await page.evaluate(() => {
    const bad = [];
    for (const card of document.querySelectorAll('.cardx')) {
      const kids = [...card.children].filter((k) => {
        const cs = getComputedStyle(k);
        return cs.position !== 'absolute' && k.getBoundingClientRect().height > 0;
      });
      if (!kids.length) continue;
      const title = card.querySelector('.ti')?.textContent || card.className;
      let prev = null;
      for (const k of kids) {
        const r = k.getBoundingClientRect();
        if (prev !== null && r.top - prev > 64) bad.push(`"${title}": ${Math.round(r.top - prev)}px void between blocks`);
        prev = r.bottom;
      }
      const cardBottom = card.getBoundingClientRect().bottom - parseFloat(getComputedStyle(card).paddingBottom);
      if (cardBottom - prev > 64) bad.push(`"${title}": ${Math.round(cardBottom - prev)}px void below last block`);
    }
    return bad;
  });
  for (const v of voids) fail(name, 'interior-void@1440', v);

  // 3. no dark hero surface taller than the 204px primary card (the 751px slab stays dead)
  const darkTall = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const isHero = cs.backgroundImage.includes('23, 26, 38') || ['rgb(23, 26, 38)', 'rgb(16, 19, 32)', 'rgb(12, 14, 24)'].includes(cs.backgroundColor);
      if (isHero) {
        const r = el.getBoundingClientRect();
        if (r.height > 240) bad.push(`${el.className || el.tagName} h=${Math.round(r.height)}`);
      }
    }
    return bad;
  });
  for (const d of darkTall) fail(name, 'dark-slab', d);

  // 4. unique figures — DERIVED from the page: every KPI/stat value rendered in the
  // band must appear exactly once outside svg/table/[data-viz]
  const figList = await page.evaluate(() => {
    const els = document.querySelectorAll('.kpi .val, .focal .big, .stat .v');
    return [...new Set([...els].map((e) => e.textContent.trim()).filter((t) => /\d/.test(t) && t.length >= 2))];
  });
  const counts = await page.evaluate((figs) => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('svg, table, [data-viz], script').forEach((n) => n.remove());
    const text = clone.textContent;
    const out = {};
    for (const f of figs) {
      let c = 0, i = -1;
      while ((i = text.indexOf(f, i + 1)) !== -1) {
        // reject matches embedded in a longer number (e.g. "88%" inside "188%")
        const pre = text[i - 1] || ' ';
        if (!/[\d.,$]/.test(pre)) c++;
      }
      out[f] = c;
    }
    return out;
  }, figList);
  for (const [f, c] of Object.entries(counts)) {
    if (c !== 1) fail(name, 'duplicate-metric', `"${f}" appears ${c}× outside charts/tables (must be exactly 1)`);
  }

  // 5. contrast sweep: every visible text node vs effective background
  const contrastIssues = await page.evaluate(() => {
    function parse(c) {
      let m = c.match(/rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/);
      if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
      m = c.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/);
      if (m) return [255 * +m[1], 255 * +m[2], 255 * +m[3], m[4] === undefined ? 1 : +m[4]];
      return null;
    }
    function effBg(el) {
      let node = el;
      while (node && node !== document.documentElement) {
        const cs = getComputedStyle(node);
        if (cs.backgroundImage !== 'none' && cs.backgroundImage.includes('gradient')) {
          if (cs.backgroundImage.includes('23, 26, 38')) return [16, 19, 32, 1]; // hero
          if (cs.backgroundImage.includes('repeating')) {
            // hatch overlay: worst-case = own bg shifted toward the stripe color
            // (light bands use 12% white stripes, dark bands 14% black)
            const own = parse(cs.backgroundColor);
            if (own && own[3] > 0.05) {
              const stripe = cs.backgroundImage.replace(/rgba\(0, 0, 0, 0\)/g, ''); // 'transparent' computes as rgba(0,0,0,0)
              const toward = stripe.includes('255, 255, 255') ? 255 : 0;
              const a = toward === 0 ? 0.14 : 0.12;
              return [own[0] * (1 - a) + toward * a, own[1] * (1 - a) + toward * a, own[2] * (1 - a) + toward * a, 1];
            }
            node = node.parentElement; continue;
          }
        }
        const bg = parse(cs.backgroundColor);
        if (bg && bg[3] > 0.05) {
          if (bg[3] < 1) { node = node.parentElement; continue; }
          return bg;
        }
        node = node.parentElement;
      }
      return [242, 244, 247, 1]; // canvas-b
    }
    const issues = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (!t.textContent.trim()) continue;
      const el = t.parentElement;
      if (!el || seen.has(el) || el.closest('script,style')) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      let fg = parse(cs.color);
      if (!fg) continue;
      const bg = effBg(el);
      if (fg[3] < 1) fg = [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
      const size = parseFloat(cs.fontSize);
      const bold = parseInt(cs.fontWeight, 10) >= 600;
      const large = size >= 24 || (size >= 18.66 && bold);
      issues.push({
        text: t.textContent.trim().slice(0, 32), fg: fg.slice(0, 3).map(Math.round), bg: bg.slice(0, 3),
        size, large, cls: (el.className || el.tagName).toString().slice(0, 40),
      });
    }
    return issues;
  });
  for (const it of contrastIssues) {
    const r = ratio(it.fg, it.bg);
    const min = it.large ? 3 : 4.5;
    if (r < min) fail(name, 'contrast', `"${it.text}" (${it.cls}, ${it.size}px) ${r.toFixed(2)}:1 < ${min}:1  fg=rgb(${it.fg}) bg=rgb(${it.bg})`);
  }

  // screenshots
  await page.screenshot({ path: resolve(shots, `${name}-1440.png`), fullPage: true });
  const fold = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await fold.goto(BASE + cfg.url, { waitUntil: 'networkidle' });
  await fold.waitForTimeout(400);
  await fold.screenshot({ path: resolve(shots, `${name}-fold-1440x900.png`) });
  await fold.close();
  const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mob.goto(BASE + cfg.url, { waitUntil: 'networkidle' });
  await mob.waitForTimeout(400);
  await mob.screenshot({ path: resolve(shots, `${name}-390.png`), fullPage: true });
  await mob.close();

  notes.push(`[${name}] gate ran: fold=${box ? Math.round(box.y + box.height) + 'px' : 'n/a'}, textNodesChecked=${contrastIssues.length}`);
  await page.close();
}
await browser.close();

console.log(notes.join('\n'));
if (failures.length) {
  console.error('\nGATE FAIL (' + failures.length + '):');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('\nGATE PASS — all objective checks green.');

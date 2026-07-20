// Interaction checks against the running app (adapted from the approved-mockup drillcheck).
// Usage: node scripts/design-interactions.mjs [baseUrl]
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('file:///Users/asadkaramally/Documents/Codex/2026-05-28/prostar-quote-workflow-completion/node_modules/playwright/index.mjs')); }
const BASE = process.argv[2] || 'http://localhost:3000';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const out = [];
async function check(name, fn) {
  try { const d = await fn(); out.push([name, true, String(d ?? '')]); }
  catch (e) { out.push([name, false, e.message.slice(0, 80)]); }
}

await p.goto(BASE + '/quotes', { waitUntil: 'domcontentloaded', timeout: 150000 });
await check('quotes: primary viz marked', async () => p.locator('[data-primary-viz]').first().waitFor({ timeout: 5000 }));
await check('quotes: trend hover tooltip', async () => {
  const svg = p.locator('[data-primary-viz] svg').first();
  await svg.hover({ position: { x: 600, y: 150 } });
  await p.waitForTimeout(300);
  const tip = await p.evaluate(() => { const t = document.querySelector('.charttip, [data-chart-tip], .tip'); return t && getComputedStyle(t).display !== 'none' ? t.textContent.slice(0, 40) : null; });
  if (!tip) throw new Error('no tooltip rendered on chart hover');
  return tip;
});
await check('quotes: labeled delta pills', async () => {
  const bare = await p.evaluate(() => [...document.querySelectorAll('.pill, .chipd')].map((e) => e.textContent.trim()).filter((t) => /^[↑↓]\s*[\d.]+\s*(%|pts)$/.test(t)));
  if (bare.length) throw new Error('bare unlabeled pills: ' + bare.join(' | '));
  return 'all pills labeled';
});

await p.goto(BASE + '/jobs', { waitUntil: 'domcontentloaded', timeout: 150000 });
await check('jobs: completed-jobs row opens drawer', async () => {
  await p.locator('table tbody tr').last().click();
  await p.waitForTimeout(400);
  const open = await p.evaluate(() => !!document.querySelector('[role="dialog"], .drawer.open, .drawer[data-open="true"], aside'));
  if (!open) throw new Error('no drawer opened');
  await p.keyboard.press('Escape');
});

await p.goto(BASE + '/technicians', { waitUntil: 'domcontentloaded', timeout: 150000 });
await check('technicians: no capacity model, no flags strip', async () => {
  const t = await p.evaluate(() => document.body.innerText);
  if (/184h|capacity used/i.test(t)) throw new Error('capacity model text still present');
  if (/is an active technician with/i.test(t)) throw new Error('alert banner still present');
});

await p.goto(BASE + '/commissions', { waitUntil: 'domcontentloaded', timeout: 150000 });
await check('commissions: no eligibility wording', async () => {
  const t = await p.evaluate(() => document.body.innerText);
  if (/eligib/i.test(t)) throw new Error('eligibility wording present');
});
await check('commissions: hours-workers present', async () => {
  const t = await p.evaluate(() => document.body.innerText);
  const missing = ['Ochoa', 'Jimenez', 'Furtado', 'Jarquin', 'Sarmiento'].filter((n) => !t.includes(n));
  if (missing.length) throw new Error('missing from worksheet: ' + missing.join(', '));
  return 'all hour-workers listed';
});

console.table(out.map(([t, ok, d]) => ({ check: t, ok, detail: d })));
await b.close();
if (out.some(([, ok]) => !ok)) process.exit(1);
console.log('ALL INTERACTION CHECKS PASS');

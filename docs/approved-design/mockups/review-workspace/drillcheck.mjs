import { chromium } from 'playwright';
const base = 'file:///Users/asadkaramally/Documents/Codex/2026-05-28/prostar-quote-workflow-completion/docs/design/metrics-mockups/';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const out = [];

// 1. quotes: chart hover tooltip
await p.goto(base + 'quotes.html'); await p.waitForTimeout(500);
const svg = p.locator('#trend svg');
await svg.hover({ position: { x: 700, y: 150 } });
await p.waitForTimeout(200);
out.push(['quotes chart tooltip', await p.locator('.charttip').isVisible(), (await p.locator('.charttip').textContent() || '').slice(0, 60)]);
// 2. quotes: deal-size row -> panel
await p.click('.barlist .brow:nth-child(4)'); await p.waitForTimeout(200);
out.push(['quotes tier drill panel', await p.locator('.drillpanel').isVisible(), (await p.locator('.drillpanel h2').textContent() || '')]);
await p.keyboard.press('Escape');

// 3. jobs: net-negative row -> panel; both chart panels tooltip
await p.goto(base + 'jobs.html'); await p.waitForTimeout(500);
await p.hover('#trend .plot >> nth=0', { position: { x: 600, y: 120 } }); await p.waitForTimeout(200);
out.push(['jobs $ panel tooltip', await p.locator('.charttip >> visible=true').first().isVisible(), (await p.locator('.charttip >> visible=true').first().textContent() || '').slice(0, 50)]);
await p.click('table.data tr.click >> nth=0'); await p.waitForTimeout(200);
out.push(['jobs completed-job drill', await p.locator('.drillpanel').isVisible(), (await p.locator('.drillpanel h2').textContent() || '')]);
await p.keyboard.press('Escape');

// 4. technicians: scorecard row -> panel; punctuality drill
await p.goto(base + 'technicians.html'); await p.waitForTimeout(500);
await p.click('table.data tr.click >> nth=0'); await p.waitForTimeout(200);
out.push(['tech scorecard drill', await p.locator('.drillpanel').isVisible(), (await p.locator('.drillpanel h2').textContent() || '')]);
await p.keyboard.press('Escape'); await p.waitForTimeout(150);
await p.click('#punct'); await p.waitForTimeout(200);
out.push(['punctuality drill', (await p.locator('.drillpanel h2').textContent() || '') === 'Punctuality by technician', (await p.locator('.drillpanel .dkv').count()) + ' tech rows']);
await p.keyboard.press('Escape');

// 5. commissions: row 1 expands real table; row 4 opens panel
await p.goto(base + 'commissions.html'); await p.waitForTimeout(500);
await p.click('.lb .lrow >> nth=0'); await p.waitForTimeout(200);
const detailRows = await p.locator('#ld-1.open table tbody tr').count();
out.push(['leaderboard row1 expand', detailRows === 17, detailRows + ' allocation rows']);
await p.click('.lb .lrow.expandable >> nth=1'); await p.waitForTimeout(200);
out.push(['leaderboard row2 panel', await p.locator('.drillpanel').isVisible(), (await p.locator('.drillpanel h2').textContent() || '')]);
await p.keyboard.press('Escape'); await p.waitForTimeout(150);
out.push(['Escape closes panel', !(await p.locator('.drillover.open').count()), '']);

console.table(out.map(([t, ok, d]) => ({ test: t, ok, detail: d })));
if (out.some(([, ok]) => !ok)) process.exit(1);
console.log('ALL INTERACTIONS WORK');
await b.close();

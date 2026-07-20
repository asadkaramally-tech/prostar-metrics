import { chromium } from 'playwright';
const b = await chromium.launch();
for (const f of ['commissions.html', 'technicians.html']) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto('file:///Users/asadkaramally/Documents/Codex/2026-05-28/prostar-quote-workflow-completion/docs/design/metrics-mockups/' + f);
  await p.waitForTimeout(400);
  const bars = await p.evaluate(() => [...document.querySelectorAll('.hist .hcol')].map(col => ({
    label: col.querySelector('.hlbl')?.textContent, num: col.querySelector('.hnum')?.textContent,
    px: Math.round(col.querySelector('.hbar')?.getBoundingClientRect().height * 10) / 10,
  })));
  console.log(f); console.table(bars);
  await p.close();
}
await b.close();

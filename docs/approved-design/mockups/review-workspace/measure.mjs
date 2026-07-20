import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.addStyleTag !== undefined;
await p.goto('file:///Users/asadkaramally/Documents/Codex/2026-05-28/prostar-quote-workflow-completion/docs/design/metrics-mockups/jobs.html');
await p.waitForTimeout(500);
// neutralize stretch to observe natural content heights
await p.addStyleTag({ content: '.grid12{align-items:start!important}.cardx{justify-content:flex-start!important}.colstack>.cardx{flex:0 0 auto!important}' });
await p.waitForTimeout(300);
const out = await p.evaluate(() => [...document.querySelectorAll('.cardx')].map(c => ({
  card: (c.querySelector('.ti')?.textContent || c.className).slice(0, 40),
  h: Math.round(c.getBoundingClientRect().height),
})));
console.table(out);
await b.close();

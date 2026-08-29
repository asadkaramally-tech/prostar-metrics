import { chromium } from 'playwright';
const b = await chromium.launch();
for (const [file, w] of [['jobs.html', 768], ['jobs.html', 390], ['commissions.html', 390]]) {
  const p = await b.newPage({ viewport: { width: w, height: 900 } });
  await p.goto('file:///Users/asadkaramally/Documents/Codex/2026-05-28/prostar-quote-workflow-completion/docs/design/metrics-mockups/' + file);
  await p.waitForTimeout(300);
  const wide = await p.evaluate((vw) => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0) out.push(`${el.tagName}.${String(el.className).slice(0,50)} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
    }
    return out.slice(0, 12);
  }, w);
  console.log(`--- ${file} @${w}:`); console.log(wide.join('\n'));
  await p.close();
}
await b.close();

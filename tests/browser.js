/* Browser checks with Playwright: the page loads without errors, every control works, bad input
   cannot break it, it fits a phone, and it prints. Writes screenshots to <outdir>.

   Usage: node tests/browser.js [outdir]      (needs `npm i playwright` or a global install) */
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const out = path.resolve(process.argv[2] || 'shots');
fs.mkdirSync(out, { recursive: true });
const url = 'file://' + path.resolve(__dirname, '..', 'index.html');

async function open(browser, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1360, height: 900 } }, opts));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  // fonts are optional: the page must work without them
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, body: '' }));
  // the suite script is optional: without it the page must behave as before (an empty script = suite not there)
  await page.route(/coderenewables\.com\/suite\//, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.goto(url);
  await page.waitForSelector('#kNet:not(:empty)');
  return page;
}
const text = (p, s) => p.$eval(s, e => e.textContent.trim());
const num = s => parseFloat(s.replace(/[^0-9.\-]/g, ''));
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  const browser = await chromium.launch();
  const p = await open(browser);

  // wind defaults
  ok(/418\.1/.test(await text(p, '#kNet')), 'wind default net 418.1 GWh/yr');
  ok(await p.$$eval('#register .card', c => c.length) === 21, '21 wind loss items');
  await p.screenshot({ path: path.join(out, 'wind-desktop.png'), fullPage: true });

  // by item and N-year views draw
  await p.check('input[name=by][value=item]'); await p.check('input[name=when][value=N]');
  ok(await p.$$eval('#bridge svg rect', r => r.length) > 15, 'item bridge has bars');
  await p.screenshot({ path: path.join(out, 'wind-items.png'), clip: await (await p.$('#bridge')).boundingBox().then(b => ({ x: b.x - 20, y: b.y - 120, width: b.width + 40, height: b.height + 140 })) });
  await p.check('input[name=by][value=group]'); await p.check('input[name=when][value="1"]');

  // clearing or overfilling inputs never breaks the page and keeps the last valid value
  const before = await text(p, '#kNet');
  await p.fill('#windGross', ''); await p.fill('#windGross', '');
  ok(await text(p, '#kNet') === before, 'empty gross keeps last value');
  ok(await p.$eval('#windGross', e => e.closest('.inp').classList.contains('bad')), 'empty gross is flagged');
  await p.fill('#windGross', '0');
  ok(/^0/.test(await text(p, '#kNet')), 'zero gross gives zero net');
  await p.fill('#windGross', '525');

  // own value for a loss, out-of-range rejected
  await p.selectOption('select[data-mode=wake_int]', 'entered');
  await p.fill('#f-wake_int-L', '150');
  ok(await p.$eval('#f-wake_int-L', e => e.closest('.inp').classList.contains('bad')), '150 % loss is rejected');
  await p.fill('#f-wake_int-L', '12');
  ok(num(await text(p, '#kNet')) < 418, 'larger wake loss lowers net');
  await p.selectOption('select[data-mode=wake_int]', 'desc:1');

  // storage
  await p.check('#storeOn');
  ok(await p.$('#grp-storage') !== null, 'storage group appears');
  ok(num(await text(p, '#kNet')) < 418.1, 'storage takes energy');
  await p.fill('#share', '0');
  ok(/418\.1/.test(await text(p, '#kNet')), 'zero share costs nothing');
  await p.uncheck('#storeOn');

  // solar with bifacial and storage
  await p.check('#techSolar');
  ok(await p.$$eval('#register .card', c => c.length) === 20, '20 solar items without bifacial');
  await p.check('#bifacial');
  ok(await p.$('#card-bifacial') !== null, 'bifacial gain item appears');
  await p.check('#storeOn'); await p.fill('#share', '35');
  await p.check('input[name=by][value=item]');
  await p.screenshot({ path: path.join(out, 'solar-desktop.png'), fullPage: true });
  await p.check('input[name=by][value=group]');
  await p.check('#gmEnt'); await p.fill('#solarGross', '300');
  ok(/300/.test(await text(p, '#kGross')), 'entered solar gross');
  await p.check('#gmIrr');

  // loading suite files
  const load = async obj => { await p.$eval('details', d => d.open = true); await p.fill('#paste', JSON.stringify(obj)); await p.click('#pasteGo'); return text(p, '#loadNote'); };
  let note = await load({ tool: 'WindNudge', base: { gross_aep_mwh: 17000 }, turbine: { rated_kw: 4500 } });
  ok(/WindNudge/.test(note) && await p.$eval('#techWind', e => e.checked), 'WindNudge JSON loads');
  ok(/510/.test(await text(p, '#kGross')), 'gross = 17 GWh × 30 turbines');
  note = await load({ tool: 'SolarNudge', data: { annual_ghi_kwhm2: 1650, step_min: 60 }, system: { dc_kwp: 50000, ac_kw: 40000, soiling_pct: 2 }, base: { poa_kwhm2: 1900, clipping_loss_pct: 1.4 } });
  ok(/SolarNudge/.test(note) && await p.$eval('#techSolar', e => e.checked), 'SolarNudge JSON loads');
  note = await load({ categories: [{ id: 'x' }] });
  ok(/none of those/.test(note), 'unknown JSON is refused with a message');
  note = await load('{not json');
  ok(p.errors.length === 0, 'no errors after bad JSON');
  await p.fill('#paste', '{not json'); await p.click('#pasteGo');
  ok(/not valid JSON/.test(await text(p, '#loadNote')), 'invalid JSON message');

  // WattOdds project round trip through the download
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#wo')]);
  const proj = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  ok(proj.schema === 'wind-uncertainty/1' && proj.plant && proj.items && proj.items.soiling, 'WattOdds project file');
  fs.writeFileSync(path.join(out, 'project.uncertainty.json'), JSON.stringify(proj, null, 2));
  note = await load(proj);
  ok(/LossStack settings/.test(note), 'project file reloads into LossStack');

  // state survives a reload
  const netNow = await text(p, '#kNet');
  await p.reload(); await p.waitForSelector('#kNet:not(:empty)');
  ok(await text(p, '#kNet') === netNow, 'state kept in the browser');

  // CSV
  const [csv] = await Promise.all([p.waitForEvent('download'), p.click('#csv')]);
  const rows = fs.readFileSync(await csv.path(), 'utf8').trim().split('\n');
  ok(rows.length > 20 && /Net, year 1/.test(rows[rows.length - 2]), 'CSV has every step and the totals');

  // print
  await p.emulateMedia({ media: 'print' });
  await p.pdf({ path: path.join(out, 'print.pdf'), format: 'A4', printBackground: true });
  await p.emulateMedia({ media: 'screen' });
  ok(p.errors.length === 0, 'no page errors: ' + p.errors.join(' | '));

  // phone, dark
  const m = await open(browser, { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  ok(await m.evaluate(() => document.documentElement.scrollWidth) <= 375, 'no sideways scroll at 375 px');
  await m.screenshot({ path: path.join(out, 'phone-dark.png'), fullPage: false });
  await m.evaluate(() => window.scrollTo(0, document.querySelector('#bridge').getBoundingClientRect().top + window.scrollY - 80));
  await m.screenshot({ path: path.join(out, 'phone-dark-bridge.png') });
  ok(m.errors.length === 0, 'no page errors on phone');

  // suite project: needs a home-page checkout (argv[3]). LossStack runs on http://localhost so the hub accepts it,
  // and the hub's coderenewables.com URLs are answered from that checkout.
  const homeDir = process.argv[3] && path.resolve(process.argv[3]);
  if (homeDir && fs.existsSync(path.join(homeDir, 'suite/v1/suite.js'))) {
    const srv = spawn('python3', ['-m', 'http.server', '8102', '--directory', path.resolve(__dirname, '..')], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 1000));
    try {
      const base = 'http://localhost:8102/index.html';
      const suiteCtx = async () => {
        const c = await browser.newContext({ viewport: { width: 1360, height: 900 } });
        await c.route(/^https:\/\/coderenewables\.com\/suite\/v1\//, route => {
          const file = path.join(homeDir, new URL(route.request().url()).pathname);
          const type = file.endsWith('.js') ? 'application/javascript' : 'text/html';
          route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
        });
        return c;
      };
      const suiteOpen = async (c) => {
        const q = await c.newPage();
        q.errors = [];
        q.on('pageerror', e => q.errors.push(e.message));
        q.on('console', m => { if (m.type() === 'error') q.errors.push(m.text()); });
        await q.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, body: '' }));
        await q.goto(base);
        await q.waitForSelector('#kNet:not(:empty)');
        await q.waitForFunction(() => window.CRSuite && CRSuite.mode !== 'pending', null, { timeout: 8000 });
        return q;
      };
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const sctx = await suiteCtx();
      const p = await suiteOpen(sctx);

      // create a wind project from the bar's API: LossStack writes its section after the first settled state
      await p.evaluate(() => CRSuite.create({ name: 'Test wind', tech: 'wind' }));
      await sleep(1200);
      const saved = await p.evaluate(() => CRSuite.current());
      ok(saved && saved.sections.lossstack, 'LossStack writes its section to the project');
      ok(Math.abs(saved.sections.lossstack.value.summary.net1GWh - 418.1) < 0.05, 'stored year-1 net is 418.1 GWh');
      ok(await p.$eval('#projName', e => e.readOnly && e.value === 'Test wind'), 'project name shown read-only');
      ok(await p.$eval('#woOpen', e => !e.hidden && /project=/.test(e.href)), 'Open in WattOdds links to the project');

      // a change in LossStack is saved to the project, and a reload restores it
      await p.fill('#windGross', '500');
      await p.dispatchEvent('#windGross', 'input');
      await sleep(1200);
      const changedNet = await text(p, '#kNet');
      ok(!/418\.1/.test(changedNet), 'a new gross energy changes the net');
      const withWake = await p.evaluate(() => CRSuite.current());
      ok(Math.abs(withWake.sections.lossstack.value.summary.net1GWh - parseFloat(changedNet)) < 0.05, 'the project holds the new net');
      await p.reload();
      await p.waitForSelector('#kNet:not(:empty)');
      await p.waitForFunction(() => window.CRSuite && CRSuite.mode !== 'pending' && document.querySelector('#projName').value === 'Test wind', null, { timeout: 8000 });
      ok(await text(p, '#kNet') === changedNet, 'reload restores the saved result');

      // another page (a WindNudge stand-in) saves results: LossStack offers Apply, Apply sets the gross energy
      const q = await suiteOpen(sctx);
      await q.evaluate(() => CRSuite.write('windnudge', {
        export: { tool: 'WindNudge', base: { gross_aep_mwh: 16000 }, turbine: { rated_kw: 4500 } },
        inputs: {}, dataset: { name: 'Sample', period: '2019–2021', sample: true }
      }));
      await p.waitForFunction(() => /WindNudge has new results/.test((document.querySelector('.crs-notice') || {}).textContent || ''), null, { timeout: 8000 });
      ok(true, 'LossStack offers the WindNudge update');
      await p.click('.crs-notice button.crs-btn.primary');
      await p.waitForFunction(() => /480/.test(document.querySelector('#kGross').textContent), null, { timeout: 8000 });
      ok(/480/.test(await text(p, '#kGross')), 'Apply sets gross to 16 GWh × 30 turbines');
      await sleep(1000);
      const after = await p.evaluate(() => CRSuite.current());
      ok(after.sections.lossstack.value.appliedFrom.windnudge === after.sections.windnudge.rev, 'appliedFrom records the WindNudge revision');

      ok(p.errors.length === 0, 'no page errors in the suite flow: ' + p.errors.join(' | '));
      await q.close();
      await p.close();
      await sctx.close();
    } finally {
      srv.kill();
    }
  }

  await browser.close();
  console.log(`browser: ${checks} checks passed; screenshots in ${out}`);
})().catch(e => { console.error(e); process.exit(1); });

/* LossStack ↔ WattOdds parity.
   Builds stacks in LossStack, exports them as WattOdds project files, imports them with WattOdds'
   own normalise() and evaluates them with WattOdds' own engine. The year-1 P50 and the loss part
   of the uncertainty must agree.

   Usage: node tests/parity.test.js <path to a renewables-uncertainty checkout> */
'use strict';
const path = require('path');
const assert = require('assert');
const repo = process.argv[2] || process.env.WATTODDS;
if (!repo) { console.log('skip: pass the path to a renewables-uncertainty checkout'); process.exit(0); }
const Engine = require(path.resolve(repo, 'src/engine.js'));
const Library = require(path.resolve(repo, 'src/library.js'));
const W = require('../wattodds-items.js');
const LS = require('../engine.js');

let n = 0;
const close = (a, b, tol, msg) => { n++; assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg}: LossStack ${a} vs WattOdds ${b}`); };

function wattOddsLoss(project, N) {
  const p = Library.normalise(JSON.parse(JSON.stringify(project)));
  const model = Engine.buildModel(p, Library);
  const en = Engine.energy(p, model);
  const c = Engine.combine(p, model, en, N);
  return { p50: en.p50 * Engine.p50Factor(model, N), lossSigma: Math.sqrt(c.terms.loss2 + c.terms.lossIav2), eff: en.eff, project: p };
}

function check(label, state) {
  const r = LS.compute(W, state);
  const proj = LS.toWattOdds(W, state, r);
  assert.ok(proj.plant && proj.items, 'WattOdds import needs plant and items');
  for (const N of [1, 10, 25]) {
    const s = LS.sanitize(W, Object.assign({}, state, { years: N }));
    const rN = LS.compute(W, s);
    const wo = wattOddsLoss(LS.toWattOdds(W, s, rN), N);
    close(rN.netNoStoreN, wo.p50, 1e-9, `${label} P50 at ${N} yr`);
    close(rN.sigmaNoStoreN, wo.lossSigma, 1e-9, `${label} loss σ at ${N} yr`);
  }
  // every LossStack item the plant uses is also evaluated by WattOdds with the same value
  const wo = wattOddsLoss(proj, 1);
  const model = Engine.buildModel(wo.project, Library);
  r.steps1.filter(x => !x.storage).forEach(x => {
    const it = model.items.find(i => i.id === x.id);
    assert.ok(it, `${label}: WattOdds has no item ${x.id}`);
    close(x.rawL, it.L, 1e-12, `${label} ${x.id} L`); close(x.rawS, it.sigma, 1e-12, `${label} ${x.id} s`);
  });
  return r;
}

const base = LS.defaultState(W, 'wind');
check('wind defaults', base);

const w2 = LS.defaultState(W, 'wind');
w2.items.wake_int = { mode: 'entered', entered: { L: 11.3, s: 2.4, iav: 0 } };
w2.items.av_wtg = { mode: 'desc', choice: 2 };
w2.items.cur_grid = { mode: 'entered', entered: { L: 4, s: 2.5, iav: 1.8 } };
w2.items.env_icing = { mode: 'none' };
w2.items.cur_ops = { mode: 'entered', entered: { L: 0.7, s: 0.3, iav: 0 } };
check('wind edited', w2);

const s1 = LS.defaultState(W, 'solar');
check('solar defaults', s1);

const s2 = LS.defaultState(W, 'solar');
Object.assign(s2.solar, { dcMWp: 195, acMW: 150, bifacial: true, mount: 'tracker', ghi: 1950, poaRatio: 1.24 });
s2.items.temperature = { mode: 'desc', choice: 2 };
s2.items.soiling = { mode: 'entered', entered: { L: 4.5, s: 1.8, iav: 0 } };
s2.items.degradation = { mode: 'desc', choice: 2 };
s2.items.bifacial = { mode: 'desc', choice: 1 };
check('solar bifacial tracker', s2);

const s3 = LS.defaultState(W, 'solar');
Object.assign(s3.solar, { grossMode: 'entered', grossGWh: 312.5, dcMWp: 150, acMW: 100 });
s3.storage = { enabled: true, share: 35 };
const r3 = check('solar entered gross with storage', s3);
assert.ok(r3.net1 < r3.netNoStore1, 'storage takes energy');

// clipping estimate from the DC/AC ratio matches WattOdds at every band
for (const ratio of [1.1, 1.2, 1.3, 1.35, 1.45, 1.6]) {
  const s = LS.defaultState(W, 'solar'); s.solar.acMW = s.solar.dcMWp / ratio;
  check(`clipping at DC/AC ${ratio}`, s);
}
console.log(`parity: ${n} checks passed against WattOdds`);

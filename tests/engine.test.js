/* LossStack engine checks that need nothing but this repository.  Usage: node tests/engine.test.js */
'use strict';
const assert = require('assert');
const W = require('../wattodds-items.js');
const LS = require('../engine.js');
let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const near = (a, b, m, tol = 1e-9) => ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${m}: ${a} vs ${b}`);

// the item library is complete and every default evaluates to a finite value
for (const t of ['wind', 'solar']) {
  const s = LS.defaultState(W, t); s.solar.bifacial = true; s.storage.enabled = true;
  const r = LS.compute(W, s);
  ok(r.steps1.every(x => Number.isFinite(x.L) && Number.isFinite(x.s) && Number.isFinite(x.after)), `${t}: finite steps`);
  W[t].forEach(d => (d.desc ? d.desc.options : []).forEach((_, i) => {
    const st = LS.defaultState(W, t); st.items[d.id] = { mode: 'desc', choice: i };
    ok(Number.isFinite(LS.compute(W, st).net1), `${t} ${d.id} option ${i}`);
  }));
}

// net = gross × Π(1 − L), independent of order; total loss in % matches
{
  const r = LS.compute(W, LS.defaultState(W, 'wind'));
  const prod = r.steps1.reduce((a, x) => a * (1 - x.L / 100), 1);
  near(r.net1, r.gross * prod, 'cascade');
  near(r.steps1.reduce((a, x) => a + x.lost, 0), r.gross - r.net1, 'step energies add up');
  near(r.groups.reduce((a, g) => a + g.lost, 0), r.gross - r.net1, 'group energies add up');
  near(r.contrib.reduce((a, x) => a + x.share, 0), 1, 'variance shares add to 1');
}

// storage: share 0 costs nothing, σ scales with the share, RTE 100 % costs only aux
{
  const s = LS.defaultState(W, 'solar');
  const base = LS.compute(W, s);
  s.storage = { enabled: true, share: 0 };
  near(LS.compute(W, s).net1, base.net1, 'zero share');
  near(LS.compute(W, s).sigma1, base.sigma1, 'zero share adds no σ');
  s.storage.share = 50;
  s.items.bess_rte = { mode: 'entered', entered: { L: 90, s: 2 } };
  s.items.bess_aux = { mode: 'entered', entered: { L: 2, s: 1 } };
  const r = LS.compute(W, s), st = r.steps1.filter(x => x.storage);
  near(st[0].L, 5, 'RTE loss = share × (100 − RTE)'); near(st[0].s, 1, 'RTE σ × share');
  near(st[1].L, 1, 'aux = share × aux'); near(st[1].s, 0.5, 'aux σ × share');
  near(r.netNoStore1, base.net1, 'net before storage unchanged');
}

// degradation is zero in year 1 and grows with the period
{
  const s = LS.defaultState(W, 'solar'); s.years = 1;
  const r1 = LS.compute(W, s); near(r1.net1, r1.netN, 'year 1 = 1-yr average');
  s.years = 11; const r11 = LS.compute(W, s);
  const deg = r11.stepsN.find(x => x.id === 'degradation');
  near(deg.L, 0.55 * 5, 'average degradation over 11 years = rate × 5');
}

// hostile or broken input never produces NaN, Infinity or a crash
{
  const junk = [null, 42, 'x', [], { tech: 'tidal' }, { wind: { grossGWh: 'abc', nTurbines: -5, ratedMW: 1e9 }, years: 1e6 },
    { items: { wake_int: { mode: 'entered', entered: { L: 500, s: -3, iav: 'z' } }, soiling: { mode: 'desc', choice: 99 }, nope: {} } },
    { tech: 'solar', solar: { dcMWp: 0, acMW: 0, ghi: -1, poaRatio: 99, grossMode: 'entered', grossGWh: '' } }];
  junk.forEach((j, i) => {
    const r = LS.compute(W, j);
    ok([r.net1, r.netN, r.sigma1, r.sigmaN, r.cf1, r.lossPct1].every(Number.isFinite), `junk ${i} gives finite results`);
    ok(r.net1 >= 0, `junk ${i} net not negative`);
  });
  const s = LS.sanitize(W, junk[6]);
  ok(s.items.wake_int.entered.L === 95 && s.items.wake_int.entered.s === 0, 'entered loss clamped');
  ok(s.items.soiling.choice === W.solar.find(d => d.id === 'soiling').desc.options.length - 1, 'choice clamped');
  const z = LS.compute(W, { wind: { grossGWh: 0 } });
  ok(z.net1 === 0 && z.lossPct1 === 0 && Number.isFinite(z.pv1.P90), 'zero gross');
}

// suite files
{
  const cur = LS.defaultState(W, 'wind');
  ok(LS.fromJson(W, '{', cur).error, 'invalid JSON refused');
  ok(LS.fromJson(W, { categories: [] }, cur).error, 'old LossStack v1 config refused with a message');
  ok(LS.fromJson(W, { schema: 'wind-uncertainty/1', tech: 'hybrid', items: {}, plant: {} }, cur).error, 'hybrid refused');
  const wn = LS.fromJson(W, { tool: 'WindNudge', base: { gross_aep_mwh: 16000 }, turbine: { rated_kw: 4500 } }, cur);
  near(wn.state.wind.grossGWh, 16 * 30, 'WindNudge gross × turbines'); near(wn.state.wind.ratedMW, 4.5, 'WindNudge rating');
  const sn = LS.fromJson(W, { tool: 'SolarNudge', data: { annual_ghi_kwhm2: 2000, step_min: 15 }, system: { dc_kwp: 1000, ac_kw: 800 }, base: { poa_kwhm2: 2300, clipping_loss_pct: 2 } }, cur);
  near(sn.state.solar.poaRatio, 1.15, 'SolarNudge POA ratio'); near(sn.state.items.clipping.entered.s, 0.5, 'sub-hourly clipping σ = 25 %');
  const proj = LS.toWattOdds(W, sn.state);
  const back = LS.fromJson(W, JSON.parse(JSON.stringify(proj)), cur);
  near(LS.compute(W, back.state).net1, LS.compute(W, sn.state).net1, 'WattOdds project round trip');
}
console.log(`engine: ${n} checks passed`);

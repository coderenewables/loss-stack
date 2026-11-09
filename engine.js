/* LossStack — energy loss stack from gross to the meter.
   Copyright 2026 Nithish Seenivasagam (coderenewables.com)
   SPDX-License-Identifier: Apache-2.0

   No DOM. The loss arithmetic and the loss uncertainty follow WattOdds' engine exactly
   (src/engine.js in coderenewables/renewables-uncertainty), so a stack built here gives the
   same P50 and the same loss uncertainty once opened in WattOdds:
     net        = gross × Π(1 − L/100)                         (losses compound)
     variance  += (s/η)² + (iav/η)² / N,  η = max(0.05, 1 − L/100)
     horizon items (module degradation): L and s are yearly rates; over N years
                  the average loss is L × (N − 1)/2 and its σ is s × (N − 1)/2
   Storage is LossStack's own step: only the share of energy routed through the battery
   pays the round-trip and auxiliary losses, and their σ is scaled by the same share. */
const LossStack = (() => {
  'use strict';
  const Z = { P50: 0, P75: 0.6744898, P90: 1.2815516, P95: 1.6448536, P99: 2.3263479 };
  const PLEVELS = ['P50', 'P75', 'P90', 'P95', 'P99'];
  const num = (v, d) => { const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v); return Number.isFinite(n) ? n : d; };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  /* WattOdds' clipping estimate from the DC/AC ratio (library.js clipL) */
  const clipL = r => (r <= 1.2 ? 0.3 : r <= 1.35 ? 1.0 : r <= 1.5 ? 2.5 : 4.0);
  const RULES = { clip_dcac: ctx => { const L = clipL(ctx.dcac); return { L, s: Math.max(0.2, 0.5 * L) }; } };
  const WHEN = { bifacial: ctx => !!ctx.bifacial };

  /* Groups in the order energy meets them on the way from the resource to the meter. */
  const ORDER = {
    wind: [
      ['turbine_interaction', 'Wakes and blockage'],
      ['turbine_performance', 'Turbine performance'],
      ['environmental', 'Environmental'],
      ['storage', 'Storage round trip'],
      ['electrical', 'Electrical'],
      ['availability', 'Availability'],
      ['curtailment', 'Curtailment'],
    ],
    solar: [
      ['plane_of_array', 'Plane of array'],
      ['shading_optical', 'Shading and optics'],
      ['thermal', 'Temperature'],
      ['module', 'Modules'],
      ['dc_inverter', 'DC side and inverter'],
      ['storage', 'Storage round trip'],
      ['electrical', 'Electrical'],
      ['availability', 'Availability'],
      ['curtailment', 'Curtailment'],
      ['degradation', 'Degradation'],
    ],
  };

  const MODES = ['desc', 'default', 'entered', 'none'];

  function itemsFor(W, tech) { return tech === 'solar' ? W.solar : W.wind; }
  function defById(W) {
    const m = {};
    [...W.wind, ...W.solar, ...W.storage].forEach(d => { m[d.id] = d; });
    return m;
  }

  /* ---------- state ---------- */
  function itemDefaultState(def) {
    const v = def.def && !def.def.fn ? def.def : { L: 0, s: 0 };
    return { mode: def.defaultMode, choice: def.desc ? def.desc.def || 0 : 0, entered: { L: num(v.L, 0), s: num(v.s, 0), iav: num(v.iav, 0) } };
  }
  function defaultState(W, tech) {
    const items = {};
    [...W.wind, ...W.solar, ...W.storage].forEach(d => { if (!items[d.id]) items[d.id] = itemDefaultState(d); });
    return {
      schema: 'lossstack/1',
      tech: tech === 'solar' ? 'solar' : 'wind',
      name: '',
      wind: { nTurbines: 30, ratedMW: 5, grossGWh: 525 },
      solar: { dcMWp: 130, acMW: 100, mount: 'fixed', bifacial: false, grossMode: 'irradiation', ghi: 1900, poaRatio: 1.10, grossGWh: 270 },
      storage: { enabled: false, share: 30 },
      years: 10,
      items,
    };
  }

  /* Rebuild a state from anything (saved, imported, typed) with every number checked. */
  function sanitize(W, raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const s = defaultState(W, r.tech);
    s.name = typeof r.name === 'string' ? r.name.slice(0, 120) : '';
    const w = r.wind || {}, p = r.solar || {}, b = r.storage || {};
    s.wind.nTurbines = Math.round(clamp(num(w.nTurbines, s.wind.nTurbines), 1, 2000));
    s.wind.ratedMW = clamp(num(w.ratedMW, s.wind.ratedMW), 0.1, 30);
    s.wind.grossGWh = clamp(num(w.grossGWh, s.wind.grossGWh), 0, 1e6);
    s.solar.dcMWp = clamp(num(p.dcMWp, s.solar.dcMWp), 0.01, 1e5);
    s.solar.acMW = clamp(num(p.acMW, s.solar.acMW), 0.01, 1e5);
    s.solar.mount = p.mount === 'tracker' ? 'tracker' : 'fixed';
    s.solar.bifacial = !!p.bifacial;
    s.solar.grossMode = p.grossMode === 'entered' ? 'entered' : 'irradiation';
    s.solar.ghi = clamp(num(p.ghi, s.solar.ghi), 1, 3500);
    s.solar.poaRatio = clamp(num(p.poaRatio, s.solar.poaRatio), 0.5, 1.6);
    s.solar.grossGWh = clamp(num(p.grossGWh, s.solar.grossGWh), 0, 1e6);
    s.storage.enabled = !!b.enabled;
    s.storage.share = clamp(num(b.share, s.storage.share), 0, 100);
    s.years = Math.round(clamp(num(r.years, s.years), 1, 40));
    const D = defById(W), its = r.items || {};
    Object.keys(s.items).forEach(id => {
      const src = its[id]; if (!src || typeof src !== 'object') return;
      const def = D[id], st = s.items[id];
      if (MODES.includes(src.mode) && (src.mode !== 'desc' || def.desc)) st.mode = src.mode;
      if (def.desc) st.choice = Math.round(clamp(num(src.choice, st.choice), 0, def.desc.options.length - 1));
      const e = src.entered || {};
      if (def.domain === 'bess') {
        const lim = def.id === 'bess_rte' ? [40, 100] : [0, 30];
        st.entered = { L: clamp(num(e.L, st.entered.L), lim[0], lim[1]), s: clamp(num(e.s, st.entered.s), 0, 30), iav: 0 };
      } else {
        st.entered = { L: clamp(num(e.L, st.entered.L), -30, 95), s: clamp(num(e.s, st.entered.s), 0, 50), iav: clamp(num(e.iav, st.entered.iav), 0, 30) };
      }
    });
    return s;
  }

  /* ---------- items ---------- */
  function context(state) {
    const p = state.solar;
    return { tech: state.tech, dcac: p.dcMWp / Math.max(0.01, p.acMW), bifacial: p.bifacial };
  }
  function asOut(v) { return v && typeof v === 'object' ? { L: num(v.L, 0), s: num(v.s ?? v.sigma, 0), iav: num(v.iav, 0) } : { L: 0, s: num(v, 0), iav: 0 }; }
  function valueOf(def, rule, ctx) { return rule && rule.fn ? RULES[rule.fn](ctx) : rule; }

  /* The value an item takes in its current mode, exactly as WattOdds evaluates it. */
  function evalItem(def, st, ctx) {
    const mode = st && st.mode ? st.mode : def.defaultMode;
    let o;
    if (mode === 'none') o = { L: 0, s: 0, iav: 0 };
    else if (mode === 'desc' && def.desc) {
      const opts = def.desc.options;
      const i = clamp(Math.round(num(st && st.choice, def.desc.def || 0)), 0, opts.length - 1);
      const op = opts[i];
      o = asOut(op.fn ? RULES[op.fn](ctx) : op.v);
    } else if (mode === 'entered') {
      const e = (st && st.entered) || {};
      o = { L: num(e.L, 0), s: num(e.s, 0), iav: num(e.iav, 0) };
    } else o = asOut(valueOf(def, def.def, ctx));
    o.s = Math.max(0, num(o.s, 0));
    o.iav = def.domain === 'bess' ? 0 : Math.max(0, num(o.iav, 0));
    o.L = def.domain === 'bess' ? o.L : clamp(num(o.L, 0), -30, 95);
    o.mode = mode === 'desc' && !def.desc ? 'default' : mode;
    return o;
  }
  function describe(def, st) {
    const mode = st && st.mode ? st.mode : def.defaultMode;
    if (mode === 'none') return 'Excluded';
    if (mode === 'entered') return 'Your value';
    if (mode === 'desc' && def.desc) return def.desc.options[clamp(Math.round(num(st.choice, 0)), 0, def.desc.options.length - 1)].label;
    return 'Generic value';
  }

  /* ---------- the stack ---------- */
  function lossAt(L, s, time, N) {
    if (time !== 'horizon') return { L, s };
    const f = Math.max(0, (N - 1) / 2);
    return { L: L * f, s: s * f };
  }
  function grossOf(state) {
    if (state.tech === 'solar') {
      const p = state.solar;
      return p.grossMode === 'entered' ? p.grossGWh : p.dcMWp * p.ghi * p.poaRatio / 1000;
    }
    return state.wind.grossGWh;
  }
  function capacityOf(state) { return state.tech === 'solar' ? state.solar.acMW : state.wind.nTurbines * state.wind.ratedMW; }

  /* One pass of the stack at horizon N (years). Returns every step with its energy. */
  function cascade(W, state, N) {
    const ctx = context(state);
    const D = defById(W);
    const gross = Math.max(0, grossOf(state));
    const groups = ORDER[state.tech];
    const defs = itemsFor(W, state.tech).filter(d => !d.when || WHEN[d.when](ctx));
    const steps = [];
    let e = gross, eNoStore = gross, varSum = 0, varNoStore = 0;
    const share = state.storage.enabled ? state.storage.share / 100 : 0;
    groups.forEach(([gid, gname]) => {
      let list;
      if (gid === 'storage') {
        if (!state.storage.enabled) return;
        list = W.storage.map(def => {
          const v = evalItem(def, state.items[def.id], ctx);
          const raw = def.id === 'bess_rte' ? 100 - v.L : v.L; // RTE 86 % → 14 % lost on the stored energy
          return { def, v, L: raw * share, s: v.s * share, iav: 0, time: 'static', storage: true, raw };
        });
      } else {
        list = defs.filter(d => (gid === 'plane_of_array' ? d.cat === 'plane_of_array' : d.cat === gid)).map(def => {
          const v = evalItem(def, state.items[def.id], ctx);
          const la = lossAt(v.L, v.s, def.time, N);
          return { def, v, L: la.L, s: la.s, iav: def.time === 'horizon' ? 0 : v.iav, time: def.time, storage: false, raw: v.L };
        });
      }
      list.forEach(x => {
        const before = e;
        const lost = before * x.L / 100;
        e = before - lost;
        if (!x.storage) eNoStore -= eNoStore * x.L / 100;
        const eta = Math.max(0.05, 1 - x.L / 100);
        const v = (x.s / eta) ** 2 + (x.iav / eta) ** 2 / N;
        varSum += v; if (!x.storage) varNoStore += v;
        steps.push({
          id: x.def.id, name: x.def.name, group: gid, groupName: gname, cat: x.def.cat, sub: x.def.sub,
          mode: x.v.mode, choiceLabel: describe(x.def, state.items[x.def.id]),
          rawL: x.raw, rawS: x.v.s, L: x.L, s: x.s, iav: x.iav, time: x.time, storage: x.storage,
          before, after: e, lost, variance: v, excluded: x.v.mode === 'none',
        });
      });
    });
    return { gross, net: e, netNoStore: eNoStore, sigma: Math.sqrt(varSum), sigmaNoStore: Math.sqrt(varNoStore), steps, defs: D };
  }

  function pvalues(p50, sigma) {
    const o = {};
    PLEVELS.forEach(p => { o[p] = p50 * Math.max(0, 1 - Z[p] * sigma / 100); });
    return o;
  }

  function compute(W, rawState) {
    const state = sanitize(W, rawState);
    const N = state.years;
    const y1 = cascade(W, state, 1);
    const yN = cascade(W, state, N);
    const cap = capacityOf(state);
    const groups = [];
    ORDER[state.tech].forEach(([gid, gname]) => {
      const st = y1.steps.filter(x => x.group === gid);
      if (!st.length) return;
      const before = st[0].before, after = st[st.length - 1].after;
      groups.push({ id: gid, name: gname, before, after, lost: before - after, L: before > 0 ? (1 - after / before) * 100 : 0, variance: st.reduce((a, x) => a + x.variance, 0), steps: st });
    });
    const tot1 = y1.sigma ** 2;
    const contrib = y1.steps.filter(x => x.variance > 0).map(x => ({ id: x.id, name: x.name, group: x.groupName, variance: x.variance, share: tot1 > 0 ? x.variance / tot1 : 0 })).sort((a, b) => b.variance - a.variance);
    return {
      state, tech: state.tech, N,
      gross: y1.gross, capacityMW: cap,
      net1: y1.net, netNoStore1: y1.netNoStore, netN: yN.net, netNoStoreN: yN.netNoStore,
      lossPct1: y1.gross > 0 ? (1 - y1.net / y1.gross) * 100 : 0,
      lossPctN: yN.gross > 0 ? (1 - yN.net / yN.gross) * 100 : 0,
      sigma1: y1.sigma, sigmaN: yN.sigma, sigmaNoStore1: y1.sigmaNoStore, sigmaNoStoreN: yN.sigmaNoStore,
      pv1: pvalues(y1.net, y1.sigma), pvN: pvalues(yN.net, yN.sigma),
      cf1: cap > 0 ? y1.net * 1000 / (cap * 8760) : 0, grossCf: cap > 0 ? y1.gross * 1000 / (cap * 8760) : 0,
      dcac: context(state).dcac,
      steps1: y1.steps, stepsN: yN.steps, groups, contrib,
    };
  }

  /* ---------- WattOdds project file ---------- */
  /* A project WattOdds can import (Import project file). WattOdds fills every part not given
     here (resource, measurement, extrapolation) with its own defaults. Storage is modelled by
     WattOdds' hourly simulation, so the P50 passed on is generation before storage, and the
     round-trip and auxiliary values travel as WattOdds' battery items. */
  function toWattOdds(W, rawState, result) {
    const state = sanitize(W, rawState);
    const r = result || compute(W, state);
    const items = {};
    [...itemsFor(W, state.tech), ...W.storage].forEach(def => {
      const st = state.items[def.id];
      const o = { mode: st.mode };
      if (st.mode === 'desc') o.choice = st.choice;
      if (st.mode === 'entered') o.entered = def.domain === 'loss' ? { L: st.entered.L, s: st.entered.s, iav: st.entered.iav } : { L: st.entered.L, s: st.entered.s };
      items[def.id] = o;
    });
    const solarComputed = state.tech === 'solar' && state.solar.grossMode === 'irradiation';
    const name = state.name || (state.tech === 'solar' ? `${fmtNum(state.solar.acMW)} MWac solar loss stack` : `${fmtNum(capacityOf(state))} MW wind loss stack`);
    const p = {
      schema: 'wind-uncertainty/1',
      tech: state.tech,
      meta: {
        name, site: '',
        notes: `Plant losses from LossStack (lossstack.coderenewables.com) on ${new Date().toISOString().slice(0, 10)}. `
          + (solarComputed ? 'Gross from DC capacity × plane-of-array irradiation, as WattOdds computes it. '
            : `P50 entered as LossStack's year-1 net before storage: ${r.netNoStore1.toFixed(2)} GWh/yr from ${r.gross.toFixed(2)} GWh/yr gross. `)
          + 'Resource, measurement and extrapolation items are WattOdds defaults: set them for your site.'
          + (state.storage.enabled ? ` Storage: ${state.storage.share} % of energy routed through the battery; set its size under Battery storage.` : ''),
        example: false, updated: new Date().toISOString(),
      },
      plant: state.tech === 'wind' ? { nTurbines: state.wind.nTurbines, ratedMW: state.wind.ratedMW } : {},
      energy: solarComputed ? { p50Mode: 'computed', p50: 0 } : { p50Mode: 'entered', p50: r.netNoStore1 },
      horizon: { life: 25 },
      view: { horizon: state.years === 1 ? 1 : 10 },
      items,
      lossstack: { schema: 'lossstack/1', state },
    };
    if (state.tech === 'solar') {
      p.pv = { dcMWp: state.solar.dcMWp, acMW: state.solar.acMW, mount: state.solar.mount, bifacial: state.solar.bifacial, ghi: state.solar.ghi, poaRatio: state.solar.poaRatio };
    }
    return p;
  }
  function fmtNum(n) { return Math.round(n * 10) / 10; }

  /* ---------- reading files from the suite ---------- */
  /* Accepts a LossStack export, a WattOdds project that came from LossStack, a WattOdds project
     made in WattOdds, a WindNudge JSON or a SolarNudge JSON. Returns { state, note } or { error }. */
  function fromJson(W, text, current) {
    let o;
    try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { error: 'That is not valid JSON.' }; }
    if (!o || typeof o !== 'object') return { error: 'That file holds no settings LossStack can read.' };
    const base = sanitize(W, current || defaultState(W));
    if (o.schema === 'lossstack/1') return { state: sanitize(W, o), note: 'Loaded the LossStack settings.' };
    if (o.lossstack && o.lossstack.schema === 'lossstack/1') return { state: sanitize(W, o.lossstack.state), note: 'Loaded the LossStack settings carried in the WattOdds project.' };
    if (o.tool === 'WindNudge' && o.base && o.turbine) {
      const s = base; s.tech = 'wind';
      const rated = num(o.turbine.rated_kw, 0) / 1000, g = num(o.base.gross_aep_mwh, 0) / 1000;
      if (!(rated > 0 && g > 0)) return { error: 'This WindNudge file has no gross energy or rated power.' };
      s.wind.ratedMW = clamp(rated, 0.1, 30);
      s.wind.grossGWh = g * s.wind.nTurbines;
      return { state: sanitize(W, s), note: `Gross set from WindNudge: ${g.toFixed(2)} GWh/yr per turbine × ${s.wind.nTurbines} turbines, free-stream with no wakes. Change the turbine count if needed.` };
    }
    if (o.tool === 'SolarNudge' && o.system && o.base) {
      const s = base; s.tech = 'solar';
      const dc = num(o.system.dc_kwp, 0) / 1000, ac = num(o.system.ac_kw, 0) / 1000;
      const ghi = num(o.data && o.data.annual_ghi_kwhm2, 0), poa = num(o.base.poa_kwhm2, 0);
      if (!(dc > 0 && ghi > 0 && poa > 0)) return { error: 'This SolarNudge file has no DC capacity or irradiation.' };
      Object.assign(s.solar, { dcMWp: dc, acMW: ac > 0 ? ac : dc / 1.3, ghi, poaRatio: poa / ghi, grossMode: 'irradiation' });
      const notes = [`DC ${dc.toFixed(2)} MWp, GHI ${ghi.toFixed(0)} kWh/m², POA/GHI ${(poa / ghi).toFixed(3)}`];
      const clip = num(o.base.clipping_loss_pct, NaN);
      if (Number.isFinite(clip)) {
        const sub = num(o.data && o.data.step_min, 60) < 60;
        s.items.clipping = { mode: 'entered', choice: 0, entered: { L: clip, s: Math.max(0.2, (sub ? 0.25 : 0.5) * clip), iav: 0 } };
        notes.push(`clipping ${clip.toFixed(2)} % from the time series`);
      }
      const soil = num(o.system.soiling_pct, NaN);
      if (Number.isFinite(soil) && soil > 0) {
        s.items.soiling = { mode: 'entered', choice: 0, entered: { L: soil, s: Math.max(0.3, 0.4 * soil), iav: 0 } };
        notes.push(`soiling ${soil.toFixed(1)} %`);
      }
      return { state: sanitize(W, s), note: 'Loaded from SolarNudge: ' + notes.join(', ') + '.' };
    }
    if (o.schema === 'wind-uncertainty/1' && o.items) {
      const s = base; s.tech = o.tech === 'solar' ? 'solar' : 'wind';
      if (o.tech === 'hybrid') return { error: 'LossStack builds one plant at a time. Open the wind or the solar part of this hybrid in WattOdds and export it separately.' };
      Object.keys(o.items).forEach(id => { if (s.items[id]) s.items[id] = Object.assign({}, s.items[id], o.items[id]); });
      if (o.pv) Object.assign(s.solar, { dcMWp: o.pv.dcMWp, acMW: o.pv.acMW, mount: o.pv.mount, bifacial: o.pv.bifacial, ghi: o.pv.ghi, poaRatio: o.pv.poaRatio, grossMode: 'irradiation' });
      if (o.plant) Object.assign(s.wind, { nTurbines: o.plant.nTurbines, ratedMW: o.plant.ratedMW });
      if (o.meta && o.meta.name) s.name = String(o.meta.name);
      return { state: sanitize(W, s), note: 'Loaded the loss items from the WattOdds project. Set the gross energy: WattOdds computes it from its own wind or irradiance inputs.' };
    }
    return { error: 'LossStack reads its own files, WattOdds projects, and WindNudge or SolarNudge JSON. This file is none of those.' };
  }

  return { Z, PLEVELS, ORDER, clipL, num, clamp, defaultState, sanitize, evalItem, describe, compute, cascade, grossOf, capacityOf, pvalues, toWattOdds, fromJson, defById, itemsFor };
})();
if (typeof module !== 'undefined') module.exports = LossStack;

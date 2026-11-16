# LossStack

**Where does your energy go between gross and the meter?**

LossStack builds a wind or solar plant's loss stack, from gross energy to net energy at the meter, with the same loss items and the same arithmetic as WattOdds. Each loss takes its share of what is left, carries its own uncertainty, and the finished stack opens in WattOdds as a project for the full P50 to P99.

Live: [lossstack.coderenewables.com](https://lossstack.coderenewables.com) · Part of the [CodeRenewables](https://coderenewables.com) suite, alongside [WattOdds](https://wattodds.coderenewables.com), [WindNudge](https://windnudge.coderenewables.com) and [SolarNudge](https://solarnudge.coderenewables.com).

## What it shows

- **Net energy at the meter** for year 1 and as an N-year average, with total loss, capacity factor and loss uncertainty.
- **Loss bridge** from gross to net, by group or by item, with ±1σ on each loss. The axis starts above zero so a 0.2 % loss is still visible.
- **Which losses carry the uncertainty**: each item's share of the loss variance.
- **Losses alone**: P50 to P99 if the gross energy were known exactly. These are not bankable P-values; resource uncertainty is added in WattOdds.
- **Loss table** with every step, how it was set, and the energy it takes. CSV download and a print layout that includes the inputs.

## Where it sits in the suite

```
WindNudge / SolarNudge  ──JSON──▶  LossStack  ──project file──▶  WattOdds
 gross energy, clipping              plant losses                 resource + losses → P50…P99
```

| From | What LossStack reads |
| --- | --- |
| WindNudge JSON | Gross AEP per turbine (free-stream, before losses) × number of turbines, and the rated power. |
| SolarNudge JSON | DC and AC capacity, GHI and plane-of-array irradiation, clipping loss from the time series (σ 25 % of the loss for sub-hourly data, 50 % for hourly, as in WattOdds) and soiling. |
| WattOdds project | Every loss item and how it was set. Gross energy is set in LossStack. |

**To WattOdds:** *Download WattOdds project*, then *Import project file* in WattOdds. Each loss item keeps its value and its mode (described, generic, your own value or excluded), so WattOdds' evidence tiers carry over. For solar with gross from irradiation, WattOdds computes the same gross; otherwise the project carries LossStack's year-1 net as an entered P50. Resource, measurement and extrapolation start at WattOdds' defaults.

## Method

1. **Gross.** Wind: entered, free-stream energy of all turbines before wakes. Solar: DC capacity × GHI × POA/GHI ratio, as WattOdds computes it, or entered.
2. **Cascade.** `net = gross × Π(1 − Lᵢ)`. Each loss is a share of what is left; the order changes each step's GWh but not the total. Groups follow the path of the energy: wind from wakes to curtailment, solar from the plane of array to degradation.
3. **Loss uncertainty**, as in WattOdds' engine: each item adds `(sᵢ/ηᵢ)²` with `ηᵢ = max(0.05, 1 − Lᵢ)`; year-to-year variability adds `(iavᵢ/ηᵢ)²/N` over an N-year average; items are independent. Module degradation is a yearly rate: over N years the average loss is `rate × (N − 1)/2`, and its σ scales the same way.
4. **Storage** is LossStack's own step. Only the stored share `f` pays round-trip and auxiliary losses: `L = f × (100 − RTE)` and `L = f × aux`, with σ scaled by `f`. WattOdds simulates storage hour by hour, so the project file passes on generation before storage, and the RTE and auxiliary values as WattOdds' battery items.
5. **P-levels**, losses only: `P = net × (1 − z·σ)`.

Limits: one plant at a time (build hybrids in WattOdds); no correlation between loss items; storage is a share of energy, not a dispatch simulation. Use it to build and explain the loss stack, not to replace an independent energy yield assessment.

## Loss items come from WattOdds

`wattodds-items.js` is generated from WattOdds' `src/library.js`: names, IEC 61400-15-2 and IEA PVPS Task 13 categories, descriptive options, defaults, explanations and sources. Don't edit it by hand. When WattOdds changes, sync it:

```sh
git clone https://github.com/coderenewables/renewables-uncertainty ../renewables-uncertainty
node tools/sync-wattodds.js ../renewables-uncertainty
node tests/parity.test.js ../renewables-uncertainty
```

The sync stops with a message if WattOdds adds an option LossStack can't evaluate yet.

## Tests

```sh
node tests/engine.test.js                          # arithmetic, storage, degradation, bad input, suite files
node tests/parity.test.js ../renewables-uncertainty # exports projects and evaluates them with WattOdds' own engine
npm i playwright && node tests/browser.js shots ../home-page   # Chromium: controls, bad input, phone, print, suite project
```

The parity test checks that year-1, 10-year and 25-year P50 and loss σ agree with WattOdds to 1e-9, for wind and solar, edited items, bifacial gain, every clipping band and storage.

## Suite project

LossStack can work on the same project as WindNudge, SolarNudge and WattOdds, with no files in between. The project bar (loaded from `https://coderenewables.com/suite/v1/suite.js`) lists the projects in this browser and links each tool. The page works the same without it.

- **Reads:** the project's `windnudge` or `solarnudge` section, when it has one, to set gross energy and rated power (WindNudge's gross AEP × turbines; SolarNudge's DC/AC capacity, irradiation and clipping). When the upstream tool saves new results, LossStack offers **Apply** and never applies them silently.
- **Writes:** its own `lossstack` section: the settings, the summary (year-1 and N-year net, losses and σ), the WattOdds project, and the upstream revisions it was built from. It writes only after you change something, 600 ms after the last change.
- **Open in WattOdds** opens the same project in WattOdds. The download stays available.

Without a project, LossStack saves its settings in this browser as before. The suite's storage is described in the home page repository, `suite/v1/README.md`.

## Run locally

It's a static page with no build step:

```sh
python3 -m http.server
# open http://localhost:8000
```

## Deploy

Cloudflare Pages, connected to this repository, as for WindNudge and SolarNudge: no build command, output directory `/`, custom domain `lossstack.coderenewables.com`. Every push to `main` deploys.

## License

[Apache 2.0](LICENSE). Copyright 2026 Nithish Seenivasagam (coderenewables.com). The loss item library is WattOdds', also Apache 2.0.

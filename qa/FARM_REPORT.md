# Tunables backtest farm — report (2026-07-06)

Every projection tunable in the app, walk-forward backtested against the **real shipped
JS modules** (`cone_data.js`, `kalman_data.js`) on **800 synthetic athletes** with known
latent-strength truth (`qa/athlete_gen.js`: saturating gains, detraining, bad days, RPE
reporting noise/bias, personal RPE curves, 5s→3s switches), cross-checked against
Martin's real 2026-07-04 backup. Harness: `qa/farm.js`; raw aggregates:
`qa/farm_results.jsonl` (seeds 200000+ and 300000+). Targets: every future observation
≤35 days past each walk-forward cutpoint (66k targets for the cone sweeps, 51k for the
Kalman sweeps, 38k latent-truth probes for band calibration).

## Decisions applied

| Tunable | Was | Now | Evidence |
|---|---|---|---|
| Cone OLS fit window | last 10 | **last 14** | Median-path MAE 3.08 → 2.95 kg (−4%) on synthetics at every clamp; provably a no-op on histories shorter than 14 points (Martin's 13-point history: identical output). win=20 was marginally better still (2.89) but slower to adapt after regime changes (deloads/block switches), which the synthetic population does not model — 14 is the robust step. |
| Kalman lower-band stall rate `PHI_LO` | 0.90 | **0.85** | The "gains stall" scenario edge was slightly optimistic: true strength fell below the 90% band's lower edge 7.3% of the time (nominal: 5%). 0.85 → 5.3% ≈ nominal, costing +2% band width. Overall 90% latent coverage after change: 89.7% — essentially exact. |
| Cone slope clamp | ±0.12 kg/day | **kept** | Genuine regime conflict: plateau-heavy synthetics prefer 0.08 (MAE 2.85 vs 2.95), Martin's real fast-gain phase prefers 0.16 (1.78 vs 1.97). 0.12 splits the difference, and fast phases are covered by the un-clamped Kalman display. Revisit if his trend flattens for a full cycle. |
| Cone sigma floor | 0.4 kg | **kept** | No measurable effect on this population (residual spread almost never below 0.8); retained as protection on very quiet data. |
| Kalman median damping `PHI_MED` | 0.985 | **kept** | Regime-dependent optimum: 0.97 wins on plateauing synthetics (MAE 2.78 vs 2.92), ~1.0 wins on Martin's fast-gain backup (1.02 vs 2.40 at ≥10d horizons, from the 2026-07-06 design backtest). 0.985 is near-optimal in both regimes; picking either extreme is worse in the other. |
| Kalman slow-loss cap `DRIFT_DN` | 0.03 kg/day | **kept** | 0.03 with PHI_LO=0.85 lands the below-band rate at nominal; 0.06 over-covers (3.8%, wider bands), 0.015 under-covers (6.7%). |
| Kalman R floor | 0.4² | **kept** | Insensitive on this population; guards degenerate flat histories. |
| durFactor window / clamp | 42d / [1.05, 1.15] | **kept** | Factor MAE 0.039 — best or statistically tied-best of all 9 combinations (win=28: 0.038, within noise). Tight clamp wins by construction and by test. |

## Known limitation (documented, not "fixed")

The cone's sqrt-widening **"90%" band actually covers ~77%** of future observations
(its bands are a heuristic sketch, not a calibrated interval). This is now a measured
fact rather than a suspicion. Deliberately left as-is: the cone is the simple
inspectable narrative view; the Kalman display below it is the calibrated one
(measured 89.7% latent coverage at nominal 90%). Widening the cone to true 90% would
roughly +17% its width and duplicate the Kalman's job.

## Reproduce

```
node qa/farm.js cone      200000 400 out.jsonl
node qa/farm.js conefloor 200000 400 out.jsonl
node qa/farm.js kalman    200000 400 out.jsonl
node qa/farm.js kalmanlo  200000 400 out.jsonl
node qa/farm.js durfactor 200000 800 out.jsonl
```

Related: `qa/rpe_validate.js` / `qa/rpe_sweep.js` / `qa/rpe_chart_eval.js` (personal RPE
curve estimator: tuning + fresh-seed holdout), `qa/fuzz_run.js` + `qa/fuzz_drive.js` +
`qa/fuzz_gen.js` (1,520-scenario robustness fuzz, all clean as of this date).

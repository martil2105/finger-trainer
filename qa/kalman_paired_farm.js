/* qa/kalman_paired_farm.js — synthetic validation for the paired (3-state)
 * Kalman filter in kalman_data.js.
 *
 * WHY THIS EXISTS
 * The paired filter's claim is that treating the two hands as two noisy reads
 * of one latent strength state (plus a slowly drifting asymmetry) beats the
 * obvious alternatives: two independent scalar filters, or filtering the
 * bilateral mean. That claim has to be tested BEFORE it touches real data,
 * because with zero logged pickup sessions there is nothing to backtest
 * against — and "it looked smoother" is not evidence.
 *
 * Synthetic athletes give us the one thing real data never does: the true
 * latent level and the true asymmetry at every point in time, so estimator
 * error is measurable rather than inferred.
 *
 * Run: node qa/kalman_paired_farm.js [seed0] [nAthletes]
 */
'use strict';

global.window = global.window || {};
require('../kalman_data.js');
const { buildKalmanTrack, buildPairedKalmanTrack } = global.window;

const DAY = 86400000;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function gauss(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }

/* One athlete: 3x/week block pulls, latent level with a drifting slope, a
 * slowly wandering asymmetry, per-session expression noise, occasional
 * degraded top sets and occasional missing hands. */
function athlete(seed, opts) {
  const r = rng(seed);
  const o = opts || {};
  const n = o.n || 18;
  const t0 = Date.parse('2026-08-03');
  const sigma = o.sigma != null ? o.sigma : 1.7;   // matches his real hang data
  let level = 42 + r() * 12;
  let slope = 0.05 + r() * 0.2;                    // kg/day
  let asym = (r() - 0.5) * 8;                      // signed, R − L
  const days = [0];
  for (let i = 1; i < n; i++) days.push(days[i - 1] + (i % 3 === 2 ? 3 : 2));

  const truth = [], obsL = [], obsR = [];
  for (let i = 0; i < n; i++) {
    const gap = i ? days[i] - days[i - 1] : 0;
    level += slope * gap;
    slope *= 0.995;                                 // gains slow gradually
    asym += gauss(r) * 0.25 * Math.sqrt(gap || 1);  // slow drift
    const x = iso(t0 + days[i] * DAY);
    truth.push({ x, level, asym });

    const trueL = level - asym / 2, trueR = level + asym / 2;
    const degL = r() < (o.degradeRate != null ? o.degradeRate : 0.10);
    const degR = r() < (o.degradeRate != null ? o.degradeRate : 0.10);
    // A degraded top set reads HIGH and noisy: position broke, so the load was
    // not expressed in position. That is exactly the bias the R-inflation is
    // meant to absorb.
    const mk = (mu, deg) => Math.round((mu + gauss(r) * sigma * (deg ? 2.2 : 1) + (deg ? 1.8 : 0)) * 10) / 10;
    const missL = r() < (o.missRate || 0);
    const missR = r() < (o.missRate || 0);
    obsL.push(missL ? null : { x, y: mk(trueL, degL), rpe: 8.5 + Math.floor(r() * 4) * 0.5, degraded: degL });
    obsR.push(missR ? null : { x, y: mk(trueR, degR), rpe: 8.5 + Math.floor(r() * 4) * 0.5, degraded: degR });
  }
  return { truth, histL: obsL.filter(Boolean), histR: obsR.filter(Boolean) };
}

function mae(a, b) {
  let s = 0, n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] == null || b[i] == null) continue;
    s += Math.abs(a[i] - b[i]); n++;
  }
  return n ? s / n : null;
}

function run(seed0, N, opts) {
  const res = { paired: [], indep: [], meanFilt: [], asymPaired: [], asymRaw: [], skipped: 0 };
  for (let k = 0; k < N; k++) {
    const a = athlete(seed0 + k, opts);
    const P = buildPairedKalmanTrack(a.histL, a.histR, { horizonWeeks: 6, rpeK: 0.065 });
    if (!P) { res.skipped++; continue; }

    const byDate = {};
    a.truth.forEach(t => { byDate[t.x] = t; });
    const trueLevel = P.filtered.map(p => byDate[p.x] ? byDate[p.x].level : null);
    const trueAsym = P.filtered.map(p => byDate[p.x] ? byDate[p.x].asym : null);

    res.paired.push(mae(P.filtered.map(p => p.y), trueLevel));

    // Alternative (a): two independent scalar filters, level = mean of the two
    const kL = buildKalmanTrack(a.histL, { horizonWeeks: 6, rpeK: 0.065 });
    const kR = buildKalmanTrack(a.histR, { horizonWeeks: 6, rpeK: 0.065 });
    if (kL && kR) {
      const mapL = {}, mapR = {};
      kL.filtered.forEach(p => mapL[p.x] = p.y);
      kR.filtered.forEach(p => mapR[p.x] = p.y);
      const est = P.filtered.map(p => (mapL[p.x] != null && mapR[p.x] != null)
        ? (mapL[p.x] + mapR[p.x]) / 2 : null);
      res.indep.push(mae(est, trueLevel));
      // asymmetry from two independent tracks
      const asymIndep = P.filtered.map(p => (mapL[p.x] != null && mapR[p.x] != null)
        ? (mapR[p.x] - mapL[p.x]) : null);
      res.asymRaw.push(mae(asymIndep, trueAsym));
    }

    // Alternative (b): filter the bilateral mean as a single series
    const meanSeries = [];
    const lmap = {}, rmap = {};
    a.histL.forEach(p => lmap[p.x] = p.y);
    a.histR.forEach(p => rmap[p.x] = p.y);
    Object.keys(lmap).forEach(x => {
      if (rmap[x] != null) meanSeries.push({ x, y: (lmap[x] + rmap[x]) / 2, rpe: 9 });
    });
    const kM = buildKalmanTrack(meanSeries, { horizonWeeks: 6, rpeK: 0.065 });
    if (kM) {
      const mm = {}; kM.filtered.forEach(p => mm[p.x] = p.y);
      res.meanFilt.push(mae(P.filtered.map(p => mm[p.x] != null ? mm[p.x] : null), trueLevel));
    }

    res.asymPaired.push(mae(P.asym.map(p => p.y), trueAsym));
  }
  return res;
}

function stat(arr) {
  const a = arr.filter(v => v != null).sort((x, y) => x - y);
  if (!a.length) return { n: 0 };
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  return { n: a.length, mean, median: a[Math.floor(a.length / 2)], p90: a[Math.floor(a.length * 0.9)] };
}
function fmt(s) { return s.n ? `mean ${s.mean.toFixed(3)} · median ${s.median.toFixed(3)} · p90 ${s.p90.toFixed(3)} (n=${s.n})` : 'no data'; }

const seed0 = parseInt(process.argv[2], 10) || 1000;
const N = parseInt(process.argv[3], 10) || 400;

console.log(`\n=== paired Kalman farm · ${N} synthetic athletes from seed ${seed0} ===\n`);

const scenarios = [
  ['baseline (18 sessions, 10% degraded)', {}],
  ['long block (36 sessions)', { n: 36 }],
  ['short (9 sessions)', { n: 9 }],
  ['noisy (sigma 2.6)', { sigma: 2.6 }],
  ['clean (no degraded sets)', { degradeRate: 0 }],
  ['15% missing hands', { missRate: 0.15 }]
];

/* The shipped claim is narrow and specific: the paired filter is the better
 * ASYMMETRY estimator. It is NOT claimed to be the better level estimator —
 * measurement says it isn't, so app.js takes the level and the fan from two
 * independent filters and only the asymmetry from here. This gate enforces
 * exactly that claim, so a future change that breaks it fails loudly. */
let asymRegressions = 0, levelNotes = 0;
scenarios.forEach(([name, opts]) => {
  const r = run(seed0, N, opts);
  const p = stat(r.paired), ind = stat(r.indep), m = stat(r.meanFilt);
  const ap = stat(r.asymPaired), ar = stat(r.asymRaw);
  console.log(`--- ${name} ---`);
  console.log(`  level MAE · paired      : ${fmt(p)}`);
  console.log(`  level MAE · 2x independ.: ${fmt(ind)}   <- what the app actually uses`);
  console.log(`  level MAE · mean-series : ${fmt(m)}`);
  if (p.n && ind.n) {
    const d = (p.mean - ind.mean) / ind.mean * 100;
    console.log(`  -> level: paired is ${d >= 0 ? '+' : ''}${d.toFixed(1)}% vs independent (informational)`);
    if (d > 0) levelNotes++;
  }
  console.log(`  asym MAE  · paired      : ${fmt(ap)}   <- what the app actually uses`);
  console.log(`  asym MAE  · 2x independ.: ${fmt(ar)}`);
  if (ap.n && ar.n) {
    const d = (ap.mean - ar.mean) / ar.mean * 100;
    console.log(`  -> asym: paired is ${d >= 0 ? '+' : ''}${d.toFixed(1)}% ${d < 0 ? 'BETTER' : 'WORSE'}`);
    if (d >= 0) { asymRegressions++; console.log('     ^^ GATE FAILURE'); }
  }
  if (r.skipped) console.log(`  skipped (insufficient paired sessions): ${r.skipped}`);
  console.log('');
});

console.log(`Level estimation: paired was worse in ${levelNotes}/${scenarios.length} scenarios — expected, and`);
console.log('why the app uses two independent filters for the strength track. See the');
console.log('module header in kalman_data.js for the mechanism.\n');
console.log(asymRegressions === 0
  ? 'VERDICT: PASS — paired filter beats differencing on asymmetry in every scenario.'
  : `VERDICT: FAIL — paired asymmetry was not better in ${asymRegressions} scenario(s).`);
process.exit(asymRegressions === 0 ? 0 : 1);

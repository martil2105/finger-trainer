/* qa/farm.js — walk-forward backtest farm for the app's projection tunables,
 * run against the REAL shipped modules (cone_data.js / kalman_data.js) on
 * synthetic athletes with known latent truth. Node-only test infra.
 *
 *   node farm.js cone      <seedStart> <nAthletes> <out.jsonl>
 *   node farm.js conefloor <seedStart> <nAthletes> <out.jsonl>
 *   node farm.js kalman    <seedStart> <nAthletes> <out.jsonl>
 *   node farm.js kalmanlo  <seedStart> <nAthletes> <out.jsonl>
 *   node farm.js durfactor <seedStart> <nAthletes> <out.jsonl>
 *
 * Athlete -> the 5s-equivalent E1RM series the app would chart (stored
 * e1rmKg, generic RPE curve), plus the hidden latent5 truth for scoring.
 * Cutpoints walk forward; every future observation <= 35d ahead is a target.
 */
'use strict';
const fs = require('fs');
const { makeAthlete } = require('./athlete_gen.js');
global.window = {};
require('../cone_data.js');
require('../kalman_data.js');
const { buildConeProjection, estimateDurationFactor, buildKalmanTrack } = global.window;

const [mode, S0s, Ns, OUT] = [process.argv[2], process.argv[3], process.argv[4], process.argv[5]];
const S0 = parseInt(S0s || '200000', 10), N = parseInt(Ns || '200', 10);
const DAY = 86400000;

function series(a) {
  const pts = a.data.logEntries.map(e => ({ x: e.date, y: e.e1rmKg }));
  const latent = {}; a.truth.forEach(t => { latent[t.iso] = t.latent5; });
  return { pts, latent, t0: Date.parse(a.data.logEntries[0].date) };
}
function interp(arr, xms) {   // linear interp of [{x,y}] at epoch ms
  if (!arr || !arr.length) return null;
  let prev = null;
  for (const p of arr) {
    const pm = Date.parse(p.x);
    if (pm === xms) return p.y;
    if (pm > xms) {
      if (!prev) return p.y;
      const f = (xms - Date.parse(prev.x)) / (pm - Date.parse(prev.x));
      return prev.y + (p.y - prev.y) * f;
    }
    prev = p;
  }
  return arr[arr.length - 1].y;
}
function bands(model) {
  const out = {};
  (model.bands || model.forecast && model.forecast.bands || []).forEach(b => { out[b.level] = b; });
  return out;
}
const acc = {};   // key -> {n, sae, cov90, cov50, w90, nb, latCov, latN, latBelow}
function bump(key) { return acc[key] || (acc[key] = { n: 0, sae: 0, cov90: 0, cov50: 0, w90: 0, nb: 0, latCov: 0, latN: 0, latBelow: 0 }); }

function walkCone(a, cfg, tag) {
  const { pts } = series(a);
  if (pts.length < 12) return;
  for (let i = 8; i < pts.length - 1; i += 3) {
    const hist = pts.slice(0, i);
    const proj = buildConeProjection(hist, { horizonWeeks: 6, clampKgPerDay: cfg.clamp, sigmaFloor: cfg.floor, fitWindow: cfg.win });
    if (!proj) continue;
    const b = bands(proj);
    const lastMs = Date.parse(hist[hist.length - 1].x);
    for (let j = i; j < pts.length; j++) {
      const dt = (Date.parse(pts[j].x) - lastMs) / DAY;
      if (dt <= 0) continue;
      if (dt > 35) break;
      const m = interp(proj.median, Date.parse(pts[j].x));
      if (m == null) continue;
      const A = bump(tag);
      A.n++; A.sae += Math.abs(m - pts[j].y);
      if (b[0.9]) {
        const up = interp(b[0.9].upper, Date.parse(pts[j].x)), lo = interp(b[0.9].lower, Date.parse(pts[j].x));
        A.nb++; if (pts[j].y >= lo && pts[j].y <= up) A.cov90++;
        A.w90 += (up - lo);
        if (b[0.5]) {
          const u5 = interp(b[0.5].upper, Date.parse(pts[j].x)), l5 = interp(b[0.5].lower, Date.parse(pts[j].x));
          if (pts[j].y >= l5 && pts[j].y <= u5) A.cov50++;
        }
      }
    }
  }
}

function walkKalman(a, cfg, tag) {
  const { pts, latent } = series(a);
  if (pts.length < 12) return;
  for (let i = 8; i < pts.length - 1; i += 4) {
    const hist = pts.slice(0, i);
    const km = buildKalmanTrack(hist, { horizonWeeks: 6, phiMed: cfg.phiMed, phiLo: cfg.phiLo, driftDn: cfg.driftDn, rFloor: cfg.rFloor });
    if (!km) continue;
    const b = bands(km.forecast);
    const lastMs = Date.parse(hist[hist.length - 1].x);
    // point accuracy vs future observations
    for (let j = i; j < pts.length; j++) {
      const dt = (Date.parse(pts[j].x) - lastMs) / DAY;
      if (dt <= 0) continue;
      if (dt > 35) break;
      const m = interp(km.forecast.median, Date.parse(pts[j].x));
      if (m == null) continue;
      const A = bump(tag);
      A.n++; A.sae += Math.abs(m - pts[j].y);
    }
    // latent (true strength) coverage of the 90% band at fixed horizons
    if (b[0.9]) {
      for (const h of [7, 14, 21, 28, 35]) {
        const xms = lastMs + h * DAY;
        const isoX = new Date(xms).toISOString().slice(0, 10);
        if (latent[isoX] == null) continue;
        const up = interp(b[0.9].upper, xms), lo = interp(b[0.9].lower, xms);
        const A = bump(tag);
        A.latN++;
        if (latent[isoX] >= lo && latent[isoX] <= up) A.latCov++;
        if (latent[isoX] < lo) A.latBelow++;   // the asymmetry claim: should be ~0
        A.w90 += (up - lo); A.nb++;
      }
    }
  }
}

function walkDurFactor(a, cfg, tag) {
  const logs = a.data.logEntries;
  const p5 = logs.filter(e => e.hangDurationSeconds === 5).map(e => ({ x: e.date, y: e.e1rmKg }));
  const p3 = logs.filter(e => e.hangDurationSeconds === 3)
    .map(e => ({ x: e.date, y: Math.round(e.e1rmKg * 1.1 * 10) / 10 }));   // raw 3s, app pipeline
  if (p5.length < 6 || p3.length < 3) return;
  const trueFac = a.params.factor3 / 1.1;   // raw-3s vs 5s-eq premium net of the generic 1.1
  for (let k = 2; k < p3.length; k++) {
    const est = estimateDurationFactor(p5, p3.slice(0, k), { default: 1.10, min: cfg.min, max: cfg.max, windowDays: cfg.win });
    const A = bump(tag);
    A.n++;
    A.sae += Math.abs(est.factor - (1.1 * trueFac));  // compare in the app's factor units
    if (est.source === 'calibrated') A.cov90++;        // reuse field: calibration rate
  }
}

(function main() {
  const t0 = Date.now();
  let done = 0;
  for (let s = S0; s < S0 + N; s++) {
    const a = makeAthlete(s, {});
    if (mode === 'cone') {
      for (const clamp of [0.08, 0.12, 0.16, 0.2, 999]) {
        for (const win of [6, 10, 14, 20]) {
          walkCone(a, { clamp, win, floor: 0.4 }, `cone|clamp=${clamp}|win=${win}`);
        }
      }
    } else if (mode === 'conefloor') {
      for (const floor of [0.2, 0.4, 0.8, 1.2]) {
        walkCone(a, { clamp: 0.12, win: 10, floor }, `conefloor|floor=${floor}`);
      }
    } else if (mode === 'kalman') {
      for (const phiMed of [0.97, 0.985, 1.0]) {
        walkKalman(a, { phiMed, phiLo: 0.90, driftDn: 0.03, rFloor: 0.4 }, `kalman|phiMed=${phiMed}`);
      }
    } else if (mode === 'kalmanlo') {
      for (const phiLo of [0.85, 0.90, 0.95]) {
        for (const driftDn of [0.015, 0.03, 0.06]) {
          walkKalman(a, { phiMed: 0.985, phiLo, driftDn, rFloor: 0.4 }, `kalmanlo|phiLo=${phiLo}|dd=${driftDn}`);
        }
      }
    } else if (mode === 'durfactor') {
      for (const win of [28, 42, 60]) {
        for (const [min, max] of [[1.05, 1.15], [1.03, 1.18], [1.0, 1.25]]) {
          walkDurFactor(a, { win, min, max }, `durfactor|win=${win}|clamp=${min}-${max}`);
        }
      }
    }
    done++;
    if (Date.now() - t0 > 33000) break;    // stay under the call budget; report actual count
  }
  const rows = Object.entries(acc).map(([key, v]) => ({ key, athletes: done, seedStart: S0, ...v }));
  fs.appendFileSync(OUT, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log('mode', mode, 'athletes', done, 'elapsed', Date.now() - t0, 'ms');
})();

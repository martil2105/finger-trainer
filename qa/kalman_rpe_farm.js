/* Walk-forward: does RPE-weighted R beat scalar R?
   Synthetic athletes from qa/athlete_gen.js (RPE reporting noise with
   per-athlete kTrue — same generator the 2026-07-06 farm used).
   Variants: OFF (strip rpe) | GENERIC (rpeK 0.06) | TRUE-K (rpeK = athlete kTrue).
   Metrics vs latent truth: filtered-level MAE now, median-forecast MAE at
   +14/+28d, 90% band coverage of latent at +28d.
   Usage: node kalman_rpe_farm.js <seed0> <n> */
'use strict';
const REPO = require('path').resolve(__dirname, '..');
const { makeAthlete } = require('./athlete_gen.js');
global.window = {};
require(REPO + '/kalman_data.js');
const buildKalmanTrack = global.window.buildKalmanTrack;
const DAY = 86400000;

const seed0 = parseInt(process.argv[2] || '500000', 10);
const N = parseInt(process.argv[3] || '150', 10);

const acc = {};
function bump(k) { return acc[k] || (acc[k] = { n: 0, saeNow: 0, sae14: 0, sae28: 0, cov: 0, covN: 0 }); }

function latAt(latent, iso) { return latent[iso]; }

for (let s = 0; s < N; s++) {
  const a = makeAthlete(seed0 + s);
  const pts = a.data.logEntries.map(e => ({ x: e.date, y: e.e1rmKg, rpe: e.topSetRPE }));
  const latent = {}; a.truth.forEach(t => { latent[t.iso] = t.latent5; });
  const kTrue = a.params.kTrue;
  if (pts.length < 12) continue;

  for (let i = 8; i < pts.length - 1; i += 4) {
    const hist = pts.slice(0, i);
    const lastIso = hist[hist.length - 1].x;
    const lastMs = Date.parse(lastIso);
    const variants = {
      off: [hist.map(p => ({ x: p.x, y: p.y })), {}],
      gen: [hist, { rpeK: 0.06 }],
      truek: [hist, { rpeK: kTrue }]
    };
    for (const key of Object.keys(variants)) {
      const km = buildKalmanTrack(variants[key][0], Object.assign({ horizonWeeks: 6 }, variants[key][1]));
      if (!km) continue;
      const A = bump(key);
      const lNow = latAt(latent, lastIso);
      if (lNow != null) { A.n++; A.saeNow += Math.abs(km.filtered[km.filtered.length - 1].y - lNow); }
      // forecast points are weekly from lastMs; index h/7
      [14, 28].forEach(h => {
        const isoH = new Date(lastMs + h * DAY).toISOString().slice(0, 10);
        const lat = latAt(latent, isoH);
        const fp = km.forecast.median[h / 7];
        if (lat == null || !fp) return;
        A['sae' + h] += Math.abs(fp.y - lat);
        if (h === 28) {
          const up = km.forecast.bands[0].upper[4], lo = km.forecast.bands[0].lower[4];
          if (up && lo) { A.covN++; if (lat >= lo.y && lat <= up.y) A.cov++; }
        }
      });
    }
  }
}

for (const k of Object.keys(acc)) {
  const A = acc[k];
  console.log(k.padEnd(6),
    'n=' + A.n,
    'MAEnow=' + (A.saeNow / A.n).toFixed(3),
    'MAE14=' + (A.sae14 / A.n).toFixed(3),
    'MAE28=' + (A.sae28 / A.n).toFixed(3),
    'cov90@28=' + (100 * A.cov / A.covN).toFixed(1) + '%');
}

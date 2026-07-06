/* qa/rpe_validate.js — offline validation of rpe_cal.js on synthetic
 * athletes with KNOWN true RPE curves. Node-only test infra.
 *   node rpe_validate.js <nAthletes> [startSeed]                     */
'use strict';
const { makeAthlete } = require('./athlete_gen.js');
global.window = {};
const { fitRpeCurve } = require('../rpe_cal.js');

const N = parseInt(process.argv[2] || '300', 10);
const S0 = parseInt(process.argv[3] || '70000', 10);

function toPoints(a) {
  return a.data.logEntries.map(e => ({ date: e.date, load: e.topSetLoadKg, rpe: e.topSetRPE, dur: e.hangDurationSeconds }))
    .concat(a.data.benchmarks.map(b => ({ date: b.date, load: b.maxLoadKg, rpe: b.rpe, dur: b.durationSeconds })));
}
function median(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; }

const errsCal = [], errsAll = [], looGain = [];
let calibrated = 0, defaulted = 0, nearGenericDefault = 0, nearGenericTotal = 0, wrongSide = 0;
for (let i = 0; i < N; i++) {
  const a = makeAthlete(S0 + i, {});
  const fit = fitRpeCurve(toPoints(a));
  const kT = a.params.kTrue;
  if (Math.abs(kT - 0.06) < 0.008) { nearGenericTotal++; if (fit.source === 'default') nearGenericDefault++; }
  errsAll.push(Math.abs((fit.source === 'calibrated' ? fit.k : 0.06) - kT));
  if (fit.source === 'calibrated') {
    calibrated++;
    errsCal.push(Math.abs(fit.k - kT));
    looGain.push((fit.looGeneric - fit.looPersonal) / fit.looGeneric);
    // did calibration move k AWAY from truth relative to generic?
    if (Math.abs(fit.k - kT) > Math.abs(0.06 - kT) + 0.005) wrongSide++;
  } else defaulted++;
}
console.log('athletes:', N, '| calibrated:', calibrated, '| default:', defaulted);
console.log('median |k_hat - k_true| when calibrated:', median(errsCal).toFixed(4));
console.log('median |k_used - k_true| overall (incl. defaults):', median(errsAll).toFixed(4));
console.log('median |0.06 - k_true| (do-nothing baseline):', median(
  Array.from({ length: N }, (_, i) => Math.abs(makeAthlete(S0 + i, {}).params.kTrue - 0.06))).toFixed(4));
console.log('median LOO improvement when calibrated:', (median(looGain) * 100).toFixed(1) + '%');
console.log('calibrations that moved k away from truth vs generic:', wrongSide, '/', calibrated);
console.log('true-k near generic (±0.008): default kept', nearGenericDefault, '/', nearGenericTotal);

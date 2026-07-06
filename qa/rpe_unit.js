'use strict';
global.window = {};
const { fitRpeCurve } = require('../rpe_cal.js');
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FAIL:', n)); };
// degenerates: no throw, default fallback
ok(fitRpeCurve(null).source === 'default', 'null -> default');
ok(fitRpeCurve([]).source === 'default', 'empty -> default');
ok(fitRpeCurve([{date:'2026-01-01',load:30,rpe:9,dur:5}]).source === 'default', 'single -> default');
const junk = fitRpeCurve([{date:'bad',load:NaN,rpe:99,dur:7},{date:null,load:-5,rpe:0}]);
ok(junk.source === 'default' && junk.n === 0, 'junk -> default, n=0');
// same-RPE data: no contrast -> default even with many points
const flatR = Array.from({length:20},(_,i)=>({date:'2026-01-'+String(i+1).padStart(2,'0'),load:30,rpe:9,dur:5}));
ok(fitRpeCurve(flatR).source === 'default', 'no RPE spread -> default');
// clean synthetic with known k, zero noise: recovers shrunk k, gate passes
const kT = 0.045; const pts = [];
for (let i = 0; i < 30; i++) {
  const day = 1 + i * 3, M = 30 + day * 0.05, rpe = [7,8,9,10][i % 4];
  pts.push({ date: '2026-' + String(1 + Math.floor(day/28)).padStart(2,'0') + '-' + String(1 + (day % 28)).padStart(2,'0'),
             load: Math.round(M * (1 - kT * (10 - rpe)) * 100) / 100, rpe, dur: 5 });
}
const f = fitRpeCurve(pts);
ok(f.source === 'calibrated', 'noise-free known curve -> calibrated (got ' + f.source + ')');
ok(Math.abs((f.kRaw ?? 0) - kT) < 0.006, 'raw pairwise recovers kT=0.045 (got ' + f.kRaw + ')');
ok(f.k > 0.045 && f.k < 0.06, 'shrunk k between kT and generic (got ' + f.k + ')');
// e1rm helper: 5s pass-through + 3s normalisation + rpe<5 -> null
ok(f.e1rm(30, 10, 5) === 30, 'e1rm @10 = load');
ok(f.e1rm(33, 10, 3) === 30, 'e1rm 3s normalised by 1.1');
ok(f.e1rm(30, 4.5, 5) === null, 'rpe<5 -> null');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

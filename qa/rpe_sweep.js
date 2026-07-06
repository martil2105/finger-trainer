/* sweep lambda x margin on tuning seeds; report the frontier */
'use strict';
const { makeAthlete } = require('./athlete_gen.js');
global.window = {};
const { fitRpeCurve } = require('../rpe_cal.js');
function toPoints(a){return a.data.logEntries.map(e=>({date:e.date,load:e.topSetLoadKg,rpe:e.topSetRPE,dur:e.hangDurationSeconds})).concat(a.data.benchmarks.map(b=>({date:b.date,load:b.maxLoadKg,rpe:b.rpe,dur:b.durationSeconds})));}
function median(a){const s=a.slice().sort((x,y)=>x-y);return s.length?s[s.length>>1]:NaN;}
const N=250, S0=70000;
const ath=[]; for(let i=0;i<N;i++){const a=makeAthlete(S0+i,{});ath.push({pts:toPoints(a),kT:a.params.kTrue});}
const base=median(ath.map(a=>Math.abs(0.06-a.kT)));
console.log('baseline median |0.06-kT|:', base.toFixed(4));
for (const lambda of [0.3,0.5,0.7,1.0]) {
  for (const margin of [0,0.02,0.05]) {
    const used=[],away=[];let cal=0;
    for (const a of ath) {
      const f=fitRpeCurve(a.pts,{lambda,margin});
      const ku=f.source==='calibrated'?f.k:0.06;
      used.push(Math.abs(ku-a.kT));
      if(f.source==='calibrated'){cal++;if(Math.abs(f.k-a.kT)>Math.abs(0.06-a.kT)+0.005)away.push(1);}
    }
    console.log(`lambda=${lambda} margin=${margin}: median|k_used-kT|=${median(used).toFixed(4)} calibrated=${cal} moved-away=${away.length}`);
  }
}

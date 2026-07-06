/* score configs by what the user actually sees: |displayed e1rm - true latent|
 * on 5s sessions, generic vs personal curve. Fresh-seed holdout supported. */
'use strict';
const { makeAthlete } = require('./athlete_gen.js');
global.window = {};
const { fitRpeCurve } = require('../rpe_cal.js');
function toPoints(a){return a.data.logEntries.map(e=>({date:e.date,load:e.topSetLoadKg,rpe:e.topSetRPE,dur:e.hangDurationSeconds})).concat(a.data.benchmarks.map(b=>({date:b.date,load:b.maxLoadKg,rpe:b.rpe,dur:b.durationSeconds})));}
function median(a){const s=a.slice().sort((x,y)=>x-y);return s.length?s[s.length>>1]:NaN;}
const N=parseInt(process.argv[2]||'250',10), S0=parseInt(process.argv[3]||'70000',10);
const cfgs=[[0.3,0.02],[0.5,0.02],[0.5,0.05],[0.7,0.02]];
const res={}; cfgs.forEach(c=>res[c.join('/')]={imp:[],cal:0,harm:0});
for (let i=0;i<N;i++){
  const a=makeAthlete(S0+i,{});
  const latentByIso={}; a.truth.forEach(t=>{latentByIso[t.iso]=t.latent5;});
  const sess=a.data.logEntries.filter(e=>e.hangDurationSeconds===5);
  if (sess.length<6) continue;
  const err=(k)=>{let s=0,n=0;sess.forEach(e=>{const d=e.topSetLoadKg/(1-k*(10-e.topSetRPE));s+=Math.abs(d-latentByIso[e.date]);n++;});return s/n;};
  const eg=err(0.06);
  const pts=toPoints(a);
  for (const [lambda,margin] of cfgs){
    const f=fitRpeCurve(pts,{lambda,margin});
    const r=res[[lambda,margin].join('/')];
    if (f.source==='calibrated'){
      r.cal++;
      const ep=err(f.k);
      r.imp.push((eg-ep)/eg);
      if (ep>eg*1.02) r.harm++;
    }
  }
}
console.log('chart-accuracy improvement vs generic AMONG CALIBRATED athletes:');
for (const c in res){const v=res[c].imp.slice().sort((a,b)=>a-b);const q=p=>v.length?v[Math.floor(p*(v.length-1))]:NaN;
  console.log(`  lambda/margin ${c}: median ${(median(v)*100).toFixed(1)}% | p10 ${(q(0.1)*100).toFixed(1)}% | p90 ${(q(0.9)*100).toFixed(1)}% | calibrated ${res[c].cal} | harmed>2% ${res[c].harm}`);}
// distribution for the leading config on calibrated athletes only

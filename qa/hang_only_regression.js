/* Regression: with ONLY hang data (Martin's current state), every screen must
   behave exactly as before — no modality toggle, no pickup cards, hang
   analytics intact. This is the state the app ships into. */
'use strict';
const fs=require('fs'),path=require('path');
const {JSDOM}=require('jsdom');
const FDBFactory=require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange=require('fake-indexeddb/lib/FDBKeyRange');
const APP=path.resolve(__dirname,'..');
const SCRIPTS=['calc.js','templates.js','db.js','sync.js','timer.js','builder.js','cone_data.js','cone.js','kalman_data.js','kalman.js','rpe_cal.js','app.js','motion.js'];
const SRC={};SCRIPTS.forEach(f=>SRC[f]=fs.readFileSync(path.join(APP,f),'utf8'));
const SHELL=fs.readFileSync(path.join(APP,'index.html'),'utf8').replace(/<script src="[^"]*"><\/script>/g,'').replace(/<script>[\s\S]*?<\/script>/g,'');
const tick=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
let pass=0,fail=0;const ok=(c,n)=>{if(c)pass++;else{fail++;console.log('FAIL: '+n);}};
const dom=new JSDOM(SHELL,{pretendToBeVisual:true,runScripts:'outside-only',url:'https://localhost/'});
const w=dom.window;w.indexedDB=new FDBFactory();w.IDBKeyRange=FDBKeyRange;
w.alert=()=>{};w.confirm=()=>true;
w.matchMedia=q=>({matches:true,media:q,addEventListener(){},addListener(){}});
w.AudioContext=class{constructor(){this.state='running';this.currentTime=0;this.destination={};}resume(){}createOscillator(){return{connect(){},start(){},stop(){},frequency:{value:0},type:''};}createGain(){return{connect(){},gain:{value:0,setValueAtTime(){},exponentialRampToValueAtTime(){}}};}};
w.fetch=()=>Promise.reject(new Error('no network'));
const uncaught=[];w.addEventListener('error',e=>uncaught.push(e.message));
const errs=[];w.console.error=(...a)=>errs.push(a.map(String).join(' '));
for(const f of SCRIPTS)w.eval(SRC[f]);
await tick(80);
// seedIfEmpty() gives exactly the shipped hang history — no pickups anywhere.
await w.DB.seedIfEmpty();
const logs=await w.DB.logsNewestFirst();
ok(logs.length>0,'seeded hang history present ('+logs.length+' logs)');
ok(logs.every(l=>!w.Calc.isPickup(l)),'no pickup records exist');
const view=()=>w.document.getElementById('view');const txt=()=>view().textContent||'';
for(const tab of ['today','program','analytics','history','settings']){
  w.App.state.tab=tab;await w.App.render();await tick(120);
  ok(!/Something went wrong/.test(txt()),tab+' renders without the error boundary');
}
w.App.state.tab='analytics';await w.App.render();await tick(140);
const a=txt();
ok(/5s E1RM/.test(a),'hang hero intact');
ok(/3s E1RM · raw/.test(a),'raw 3s plot intact');
ok(/E1RM projection · 3s/.test(a),'projection cone intact');
ok(/Filtered strength · 3s/.test(a),'kalman card intact');
ok(/% BW|set bodyweight|no 5s E1RM yet/.test(a),'%BW stat still present for hangs');
ok(!/Best · left|Asymmetry|Day of week/.test(a),'no pickup cards leak in');
const segs=[...view().querySelectorAll('.seg button')].map(b=>b.textContent);
ok(!segs.includes('Pickup'),'no modality toggle when there is no pickup data (got: '+segs.join(',')+')');
ok(segs.includes('All')&&segs.includes('Cycle'),'Cycle/All range toggle still there');
// manual hang log must still open the HANG editor
w.App.openManualLog(logs.find(l=>l.type==='Yielding'));
await tick(60);
const sheet=w.document.querySelector('#modal-host .sheet');
ok(!!sheet&&/Hang duration/.test(sheet.textContent),'hang editor still opens for hang records');
ok(!!sheet&&!/Left hand · sets/.test(sheet.textContent),'hang editor is not the pickup editor');
ok(uncaught.length===0,'no uncaught errors: '+uncaught.join(' | '));
ok(errs.filter(e=>!/Not implemented/.test(e)).length===0,'no console.error: '+errs.slice(0,2).join(' | '));
console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
})().catch(e=>{console.error('HARNESS ERROR',e);process.exit(1);});

/* rerun one seed with full stack capture on render error */
const { JSDOM } = require('jsdom');
const fs = require('fs'); const path = require('path');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');
const { makeScenario } = require('./fuzz_gen.js');
const APP = path.resolve(__dirname, '..');
const seed = parseInt(process.argv[2], 10);
const scen = makeScenario(seed);
const html = fs.readFileSync(path.join(APP,'index.html'),'utf8').replace(/<script src="[^"]*"><\/script>/g,'').replace(/<script>[\s\S]*?<\/script>/g,'');
const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://localhost/' });
const w = dom.window;
w.indexedDB = new FDBFactory(); w.IDBKeyRange = FDBKeyRange;
w.alert = () => {}; w.matchMedia = q => ({matches:false, media:q, addEventListener(){}, addListener(){}});
w.AudioContext = class { constructor(){this.state='running';this.currentTime=0;this.destination={};} resume(){} createOscillator(){return{connect(){},start(){},stop(){},frequency:{value:0},type:''};} createGain(){return{connect(){},gain:{value:0,setValueAtTime(){},exponentialRampToValueAtTime(){}}};} };
w.fetch = () => Promise.reject(new Error('none'));
['calc.js','templates.js','db.js','sync.js','timer.js','builder.js','cone_data.js','cone.js','kalman_data.js','kalman.js','rpe_cal.js','app.js','motion.js'].forEach(f => w.eval(fs.readFileSync(path.join(APP,f),'utf8')));
const tick = ms => new Promise(r=>setTimeout(r,ms));
process.on('unhandledRejection', e => console.log('ASYNC-REJ:', (e && e.stack)||e));
(async () => {
  await tick(100);
  try { await w.DB.importBackup(scen.data); } catch(e) { console.log('import rejected:', e.message); }
  const origErr = w.console.error;
  w.eval('console.error = function(){ if(String(arguments[0]).indexOf("Render error")>=0 && arguments[1] && arguments[1].stack) console.log("STACK>>>", arguments[1].stack); }');
  for (const tab of ['today','program','analytics','history']) {
    w.App.state.tab = tab; await w.App.render(); await tick(30);
  }
  // manual log flow
  w.App.openManualLog(); await tick(40);
  const sheet = w.document.querySelector('#modal-host .sheet');
  if (sheet) { const save=[...sheet.querySelectorAll('button')].find(b=>/save/i.test(b.textContent)); if (save) { save.click(); await tick(150);} }
  console.log('probe done', seed);
})();

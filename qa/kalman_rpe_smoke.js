/* Render smoke: full app in jsdom with a synthetic athlete, assert the
   Analytics tab renders and the Kalman card note shows the RPE-weighting
   clause (and does NOT when rpe data is absent). */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = require('path').resolve(__dirname, '..');
const { JSDOM } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');
const { makeAthlete } = require('./athlete_gen.js');

const SCRIPTS = ['calc.js', 'templates.js', 'db.js', 'sync.js', 'timer.js', 'builder.js',
  'cone_data.js', 'cone.js', 'kalman_data.js', 'kalman.js', 'rpe_cal.js', 'app.js', 'motion.js'];
const SRC = {};
SCRIPTS.forEach(f => { SRC[f] = fs.readFileSync(path.join(APP, f), 'utf8'); });
const SHELL_HTML = fs.readFileSync(path.join(APP, 'index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '')
  .replace(/<script>[\s\S]*?<\/script>/g, '');

const tick = (ms) => new Promise(r => setTimeout(r, ms));

async function boot(data) {
  const dom = new JSDOM(SHELL_HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://localhost/' });
  const w = dom.window;
  w.indexedDB = new FDBFactory();
  w.IDBKeyRange = FDBKeyRange;
  w.alert = () => {}; w.confirm = () => true;
  w.matchMedia = (q) => ({ matches: /reduced-motion/.test(q), media: q, addEventListener() {}, addListener() {} });
  w.AudioContext = class { constructor(){ this.state='running'; this.currentTime=0; this.destination={}; }
    resume(){} createOscillator(){ return { connect(){}, start(){}, stop(){}, frequency:{value:0}, type:'' }; }
    createGain(){ return { connect(){}, gain:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){} } }; } };
  w.fetch = () => Promise.reject(new Error('no network'));
  const uncaught = [];
  w.addEventListener('error', (e) => uncaught.push(e.message));
  for (const f of SCRIPTS) w.eval(SRC[f]);
  await tick(80);
  await w.DB.resetAll();          // drop seeded demo data — import must be the only content
  await w.DB.importBackup(data);
  return { w, uncaught };
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL: ' + n); } };

  const a = makeAthlete(910001);
  // A: with rpe data (generator logs carry topSetRPE)
  {
    const { w, uncaught } = await boot(a.data);
    w.App.state.tab = 'analytics';
    await w.App.render(); await tick(40);
    const view = w.document.getElementById('view');
    const txt = view.textContent;
    ok(view.children.length > 0, 'A renders');
    ok(txt.indexOf('Something went wrong') < 0, 'A no error boundary');
    ok(txt.indexOf('Filtered strength') >= 0, 'A kalman section present');
    ok(txt.indexOf('weighted by top-set RPE') >= 0, 'A rpe-weighting note shown');
    ok(w.document.querySelectorAll('svg.kalman-chart').length === 1, 'A kalman svg drawn');
    ok(uncaught.length === 0, 'A no uncaught (' + uncaught.join('; ') + ')');
  }
  // B: rpe stripped from every log -> note absent, still renders
  {
    const data = JSON.parse(JSON.stringify(a.data));
    data.logEntries.forEach(e => { delete e.topSetRPE; });
    const { w, uncaught } = await boot(data);
    w.App.state.tab = 'analytics';
    await w.App.render(); await tick(40);
    const view = w.document.getElementById('view');
    const txt = view.textContent;
    ok(txt.indexOf('Filtered strength') >= 0, 'B kalman section present');
    ok(txt.indexOf('weighted by top-set RPE') < 0, 'B note absent without rpe');
    ok(uncaught.length === 0, 'B no uncaught (' + uncaught.join('; ') + ')');
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('HARNESS ERROR: ' + e.stack); process.exit(2); });

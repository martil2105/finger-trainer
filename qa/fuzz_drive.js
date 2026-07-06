/* qa/fuzz_drive.js — drives the FULL app in jsdom against one batch of
 * fuzz scenarios. Run as a child process:
 *   node fuzz_drive.js <startSeed> <count> <findingsFile>
 * Prints "SEED <n> start" before each scenario so a parent watchdog can
 * attribute hangs. Appends JSONL findings. Node-only test infra. */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');
const { makeScenario } = require('./fuzz_gen.js');

const APP = path.resolve(__dirname, '..');
const SCRIPTS = ['calc.js', 'templates.js', 'db.js', 'sync.js', 'timer.js', 'builder.js',
  'cone_data.js', 'cone.js', 'kalman_data.js', 'kalman.js', 'rpe_cal.js', 'app.js', 'motion.js'];
const SRC = {};
SCRIPTS.forEach(f => { SRC[f] = fs.readFileSync(path.join(APP, f), 'utf8'); });
const SHELL_HTML = fs.readFileSync(path.join(APP, 'index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '')
  .replace(/<script>[\s\S]*?<\/script>/g, '');

const [startSeed, count, outFile] = [parseInt(process.argv[2], 10), parseInt(process.argv[3], 10), process.argv[4]];
const findings = [];
/* FAST mode (default): stub prefers-reduced-motion TRUE so the sheet-close
 * animation path is skipped and ticks shrink ~6x. Every 5th seed runs the
 * full-motion timing path to keep the 190ms-animation race covered. */
const fastFor = (seed) => seed % 5 !== 0;
let TICKSCALE = 1;
const tick = (ms) => new Promise(r => setTimeout(r, Math.max(10, Math.round(ms * TICKSCALE))));

function record(seed, scen, step, kind, detail) {
  const f = { seed, kind, step, scenKind: scen.kind, muts: scen.muts,
    detail: String(detail).slice(0, 400) };
  findings.push(f);
  fs.appendFileSync(outFile, JSON.stringify(f) + '\n');   // flush immediately: survive timeouts
}

async function driveOne(seed) {
  const scen = makeScenario(seed);
  const dom = new JSDOM(SHELL_HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://localhost/' });
  const w = dom.window;
  w.indexedDB = new FDBFactory();
  w.IDBKeyRange = FDBKeyRange;
  w.alert = () => {};
  w.confirm = () => true;
  const fast = fastFor(seed); TICKSCALE = fast ? 0.15 : 1;
  w.matchMedia = ((q) => ({ matches: fast && /reduced-motion/.test(q), media: q, addEventListener() {}, addListener() {} }));
  w.AudioContext = class { constructor(){ this.state='running'; this.currentTime=0; this.destination={}; }
    resume(){} createOscillator(){ return { connect(){}, start(){}, stop(){}, frequency:{value:0}, type:'' }; }
    createGain(){ return { connect(){}, gain:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){} } }; } };
  w.fetch = () => Promise.reject(new Error('no network in fuzz'));
  let step = 'load';
  const uncaught = [];
  w.addEventListener('error', (e) => uncaught.push(step + ': ' + e.message));
  const rejHandler = (e) => uncaught.push(step + ': unhandledRejection: ' + ((e && e.stack) || e));
  process.on('unhandledRejection', rejHandler);

  try {
    for (const f of SCRIPTS) { step = 'eval:' + f; w.eval(SRC[f]); }
    step = 'init'; await tick(80);
    step = 'import';
    try { await w.DB.importBackup(scen.data); }
    catch (e) { record(seed, scen, step, 'import-reject', e.message); }

    for (const tab of ['today', 'program', 'analytics', 'history', 'settings']) {
      step = 'render:' + tab;
      const t0 = Date.now();
      w.App.state.tab = tab;
      await w.App.render(); await tick(30);
      const ms = Date.now() - t0;
      if (ms > 2500) record(seed, scen, step, 'slow', ms + 'ms');
      const view = w.document.getElementById('view');
      if (!view || view.children.length === 0) record(seed, scen, step, 'blank-view', 'no children');
      else if (view.textContent.indexOf('Something went wrong') >= 0) {
        record(seed, scen, step, 'error-boundary', (view.querySelector('.muted') || {}).textContent);
      }
    }

    step = 'picker';
    w.App.state.tab = 'today'; await w.App.render(); await tick(40);
    const pb = [...w.document.getElementById('view').querySelectorAll('button')]
      .find(b => /different workout/i.test(b.textContent));
    if (pb) {
      pb.click(); await tick(60);
      const item = w.document.querySelector('#modal-host .list-item');
      if (item) {
        step = 'picker:start';
        item.click(); await tick(300);
        const runner = w.document.querySelector('#modal-host .runner');
        const sheetLeft = w.document.querySelector('#modal-host .sheet-overlay');
        if (!runner && !sheetLeft) record(seed, scen, step, 'runner-vanished', 'no runner, no sheet after tap');
        step = 'picker:quit';
        const q = w.document.getElementById('r-quit'); if (q) q.click(); await tick(60);
        const ovs = [...w.document.querySelectorAll('#modal-host .sheet-overlay')];
        const conf = ovs[ovs.length - 1];
        const quitBtn = conf && [...conf.querySelectorAll('button.btn')].find(b => !/secondary/.test(b.className));
        if (quitBtn) quitBtn.click();
        await tick(250);
      } else { w.App.closeSheet(); await tick(220); }
    }

    step = 'manual-log';
    w.App.openManualLog(); await tick(60);
    const sheet = w.document.querySelector('#modal-host .sheet');
    if (sheet) {
      const save = [...sheet.querySelectorAll('button')].find(b => /save/i.test(b.textContent));
      if (save) { save.click(); await tick(120); }        // empty save: must not throw
      w.App.closeSheet(); await tick(220);
    }

    step = 'program:expand';
    w.App.state.tab = 'program'; await w.App.render(); await tick(40);
    const wkCard = w.document.querySelector('#view .wk-card');
    if (wkCard) { wkCard.click(); await tick(80); }
  } catch (e) {
    record(seed, scen, step, 'uncaught-throw', (e && e.stack) || e);
  } finally {
    process.removeListener('unhandledRejection', rejHandler);
    uncaught.forEach(u => record(seed, scen, 'async', 'uncaught-async', u));
    try { dom.window.close(); } catch (e) {}
  }
}

(async () => {
  for (let s = startSeed; s < startSeed + count; s++) {
    console.log('SEED', s, 'start');
    await driveOne(s);
  }
  console.log('BATCH DONE', startSeed, count, 'findings:', findings.length);
})();

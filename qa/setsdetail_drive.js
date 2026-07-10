/* Drives a full Heavy topSetPlusBackoffs session through the REAL runner UI
   in jsdom and asserts the per-effort {load, rpe} detail persists to the DB
   as logEntry.setsDetail (top set first, then back-offs), and that a manual
   edit round-trip preserves it. Node-only test infra.
   Run: node setsdetail_drive.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

const APP = path.resolve(__dirname, '..');
const SCRIPTS = ['calc.js', 'templates.js', 'db.js', 'sync.js', 'timer.js', 'builder.js',
  'cone_data.js', 'cone.js', 'kalman_data.js', 'kalman.js', 'rpe_cal.js', 'app.js', 'motion.js'];
const SRC = {};
SCRIPTS.forEach(f => { SRC[f] = fs.readFileSync(path.join(APP, f), 'utf8'); });
const SHELL_HTML = fs.readFileSync(path.join(APP, 'index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '')
  .replace(/<script>[\s\S]*?<\/script>/g, '');

const tick = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL: ' + n); } };

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
  // FAST TIMERS: countdowns (3s hang, 180s rest, 3-2-1) tick on setInterval —
  // compress 1000ms ticks to 3ms so the whole session runs in <2s wall time.
  const _si = w.setInterval.bind(w);
  w.setInterval = (fn, ms) => _si(fn, Math.max(2, Math.round((ms || 0) / 300)));

  const uncaught = [];
  w.addEventListener('error', (e) => uncaught.push(e.message));
  for (const f of SCRIPTS) w.eval(SRC[f]);
  await tick(80);
  await w.DB.resetAll();

  const plan = { role: 'Heavy', protocol: 'topSetPlusBackoffs', duration: 3, sets: 2,
    anchor: 35, backoffAnchor: 30, rpe: 9.5, blockName: 'DriveTest' };
  const efforts = [{ load: 35, rpe: 9.5 }, { load: 30, rpe: 8 }, { load: 29.5, rpe: 7.5 }];
  const expected = [];
  w.Runner.start(plan);
  await tick(60);

  const modal = () => w.document.getElementById('modal-host');
  let saved = false;
  for (let it = 0; it < 300 && !saved; it++) {
    await tick(20);
    const m = modal();
    if (!m) break;
    // Confirm sheet on top? secondary = "keep going" path.
    const ov = [...m.querySelectorAll('.sheet-overlay')].pop();
    if (ov) {
      const btns = [...ov.querySelectorAll('button.btn')];
      const sec = btns.find(b => /secondary/.test(b.className));
      (sec || btns[0]) && (sec || btns[0]).click();
      continue;
    }
    const btns = [...m.querySelectorAll('button')];
    const byText = (re) => btns.find(b => re.test(b.textContent));
    const logged = btns.find(b => b.textContent.trim() === 'Logged');
    if (logged) {
      const sts = [...m.querySelectorAll('.stepper')];
      const e = efforts[Math.min(expected.length, efforts.length - 1)];
      if (sts.length >= 2 && sts[0].setValue) {
        sts[0].setValue(e.load); sts[1].setValue(e.rpe);
        expected.push({ load: sts[0].getValue(), rpe: sts[1].getValue() });
      }
      logged.click();
      continue;
    }
    const b = byText(/Skip check/) || byText(/Ready — start/) || byText(/Skip rest/);
    if (b) { b.click(); continue; }
    const save = byText(/Save & close/);
    if (save) { save.click(); saved = true; await tick(120); }
  }

  ok(saved, 'reached Save & close');
  ok(expected.length === 3, 'logged 3 efforts via UI (got ' + expected.length + ')');
  const logs = await w.DB.logsNewestFirst();
  const entry = logs[0];
  ok(!!entry, 'entry saved');
  if (entry) {
    ok(entry.topSetLoadKg === 35 && entry.topSetRPE === 9.5, 'top set fields (got ' + entry.topSetLoadKg + '@' + entry.topSetRPE + ')');
    ok(entry.sets === 3, 'sets count 3 (got ' + entry.sets + ')');
    ok(JSON.stringify(entry.setsDetail) === JSON.stringify(expected),
      'setsDetail persisted exactly: ' + JSON.stringify(entry.setsDetail) + ' vs ' + JSON.stringify(expected));

    // Manual-edit round trip must NOT destroy setsDetail (rows prefill from
    // the entry and rebuild identically on save).
    w.App.openManualLog(entry);
    await tick(60);
    const sheet = w.document.querySelector('#modal-host .sheet');
    const saveBtn = sheet && [...sheet.querySelectorAll('button')].find(b => /Save changes/.test(b.textContent));
    ok(!!saveBtn, 'manual editor opened on entry');
    if (saveBtn) {
      saveBtn.click();
      await tick(120);
      const logs2 = await w.DB.logsNewestFirst();
      const e2 = logs2.find(l => l.id === entry.id);
      ok(e2 && JSON.stringify(e2.setsDetail) === JSON.stringify(expected), 'setsDetail survives manual edit');

      // Remove one back-off row via the editor UI -> detail shrinks, sets syncs.
      await tick(300);                       // let the previous sheet's 190ms close animation finish
      w.App.openManualLog(e2);
      await tick(60);
      const sh2 = [...w.document.querySelectorAll('#modal-host .sheet')].pop();
      const removes = [...sh2.querySelectorAll('button')]
        .filter(b => b.textContent.trim() === '×' && !/sheet-close/.test(b.className));
      ok(removes.length === 2, 'two back-off rows shown (got ' + removes.length + ')');
      removes[1].click();
      await tick(30);
      const save2 = [...sh2.querySelectorAll('button')].find(b => /Save changes/.test(b.textContent));
      save2.click();
      await tick(120);
      const e3 = (await w.DB.logsNewestFirst()).find(l => l.id === entry.id);
      ok(e3 && JSON.stringify(e3.setsDetail) === JSON.stringify(expected.slice(0, 2)) && e3.sets === 2,
        'row removal persists + sets derived (got ' + JSON.stringify(e3.setsDetail) + ' sets:' + e3.sets + ')');
    }
  }

  // Fresh manual entry: add two back-off rows from scratch via the editor.
  {
    await tick(300);
    w.App.openManualLog();
    await tick(60);
    const sh = [...w.document.querySelectorAll('#modal-host .sheet')].pop();
    const sts = () => [...sh.querySelectorAll('.stepper')];
    sts()[0].setValue(30); sts()[1].setValue(9);                 // top set 30 @9
    const addBtn = () => [...sh.querySelectorAll('button')].find(b => /Add back-off set/.test(b.textContent));
    ok(!!addBtn(), 'add-back-off button present');
    addBtn().click(); await tick(30);
    addBtn().click(); await tick(30);
    // steppers: 0 load, 1 rpe, 2 sets(hidden), 3/4 row1, 5/6 row2
    sts()[3].setValue(25.5); sts()[4].setValue(8);
    sts()[5].setValue(25); sts()[6].setValue(7.5);
    const saveNew = [...sh.querySelectorAll('button')].find(b => /Save session/.test(b.textContent));
    saveNew.click();
    await tick(120);
    // same-date entries tie in logsNewestFirst ordering — find by exclusion
    const fresh = (await w.DB.logsNewestFirst()).find(l => l.id !== entry.id);
    const wantDetail = [{ load: 30, rpe: 9 }, { load: 25.5, rpe: 8 }, { load: 25, rpe: 7.5 }];
    ok(fresh && JSON.stringify(fresh.setsDetail) === JSON.stringify(wantDetail),
      'fresh manual entry persists rows (' + JSON.stringify(fresh && fresh.setsDetail) + ')');
    ok(fresh && fresh.sets === 3, 'fresh entry sets derived = 3 (got ' + (fresh && fresh.sets) + ')');
  }
  ok(uncaught.length === 0, 'no uncaught errors (' + uncaught.join('; ') + ')');

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('HARNESS ERROR: ' + e.stack); process.exit(2); });

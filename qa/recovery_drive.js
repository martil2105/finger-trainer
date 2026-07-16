/* Crash-recovery drive: abandon a session mid-way in one jsdom "launch",
   boot a second launch on the SAME fake-indexeddb, and assert the
   'Unfinished session' prompt + all three actions behave:
     1. same-day Resume — sets preserved, session completes, meta cleared
     2. stale (previous-day) — no Resume offered; "Save what's done" logs
        under the ORIGINAL date
     3. Discard — meta cleared, no log written
     4. Quit inside the runner — clears the snapshot
     5. stale snapshot with zero sets — silently dropped, no prompt
   Run: node recovery_drive.js */
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
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const yesterdayISO = () => { const d = new Date(Date.now() - 864e5); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL: ' + n); } };

function boot(idb) {
  const dom = new JSDOM(SHELL_HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://localhost/' });
  const w = dom.window;
  w.indexedDB = idb;
  w.IDBKeyRange = FDBKeyRange;
  w.alert = (m) => { console.log('ALERT: ' + m); };
  w.matchMedia = (q) => ({ matches: /reduced-motion/.test(q), media: q, addEventListener() {}, addListener() {} });
  w.AudioContext = class { constructor(){ this.state='running'; this.currentTime=0; this.destination={}; }
    resume(){} createOscillator(){ return { connect(){}, start(){}, stop(){}, frequency:{value:0}, type:'' }; }
    createGain(){ return { connect(){}, gain:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){} } }; } };
  w.fetch = () => Promise.reject(new Error('no network'));
  const _si = w.setInterval.bind(w);
  w.setInterval = (fn, ms) => _si(fn, Math.max(2, Math.round((ms || 0) / 300))); // fast timers
  w.addEventListener('error', (e) => console.log('UNCAUGHT: ' + e.message));
  for (const f of SCRIPTS) w.eval(SRC[f]);
  return { dom, w };
}

const PLAN = { role: 'Heavy', protocol: 'topSetPlusBackoffs', duration: 3, sets: 2,
  anchor: 35, backoffAnchor: 30, rpe: 9.5, blockName: 'RecTest' };

// Drive the live runner until `stopRe` matches a button, logging efforts as
// they come up. Returns true if the stop button was seen (and clicked if doClick).
async function drive(w, efforts, stopRe, doClick) {
  let li = 0;
  for (let it = 0; it < 400; it++) {
    await tick(15);
    const m = w.document.getElementById('modal-host');
    if (!m) return false;
    const ov = [...m.querySelectorAll('.sheet-overlay')].pop();
    if (ov) { // in-runner confirm (fatigue-stop etc.) -> take secondary "keep going"
      const btns = [...ov.querySelectorAll('button.btn')];
      const sec = btns.find(b => /secondary/.test(b.className));
      (sec || btns[0]) && (sec || btns[0]).click();
      continue;
    }
    const btns = [...m.querySelectorAll('button')];
    const byText = (re) => btns.find(b => re.test(b.textContent));
    const stopBtn = byText(stopRe);
    if (stopBtn) { if (doClick) { stopBtn.click(); await tick(120); } return true; }
    const logged = btns.find(b => b.textContent.trim() === 'Logged');
    if (logged) {
      const sts = [...m.querySelectorAll('.stepper')];
      const e = efforts[Math.min(li++, efforts.length - 1)];
      if (sts.length >= 2 && sts[0].setValue) { sts[0].setValue(e.load); sts[1].setValue(e.rpe); }
      logged.click();
      continue;
    }
    const b = byText(/Skip check/) || byText(/Ready — start/) || byText(/Skip rest/);
    if (b) { b.click(); continue; }
  }
  return false;
}

// Boot a launch and wait for the recovery sheet (or report absence).
async function bootAndFindPrompt(idb) {
  const { dom, w } = boot(idb);
  let sheet = null;
  for (let i = 0; i < 60 && !sheet; i++) {
    await tick(25);
    const s = w.document.querySelector('#modal-host .sheet');
    if (s && /Unfinished session/.test(s.textContent)) sheet = s;
  }
  return { dom, w, sheet };
}

(async () => {
  // ---------- scenario 1: same-day abandon -> Resume -> complete ----------
  {
    const idb = new FDBFactory();
    const { dom, w } = boot(idb);
    await tick(120);
    await w.DB.resetAll();
    w.Runner.start(PLAN);
    // log top set, then abandon on the REST screen
    ok(await drive(w, [{ load: 35, rpe: 9.5 }], /Skip rest/, false), 's1: reached REST after top set');
    await tick(60); // let fire-and-forget persist flush
    const snap = await w.DB.getMeta('pendingRunnerSession');
    ok(!!snap && Array.isArray(snap.sets) && snap.sets.length === 1
      && snap.sets[0].load === 35 && snap.date === todayISO(),
      's1: snapshot persisted (sets=' + (snap && snap.sets && snap.sets.length) + ' date=' + (snap && snap.date) + ')');
    dom.window.close(); // simulate app kill

    const l2 = await bootAndFindPrompt(idb);
    ok(!!l2.sheet, 's1: recovery prompt shown on relaunch');
    if (l2.sheet) {
      const btns = [...l2.sheet.querySelectorAll('button')];
      ok(btns.some(b => /Resume session/.test(b.textContent)), 's1: Resume offered (same-day)');
      ok(btns.some(b => /Save what/.test(b.textContent)), 's1: Save what’s done offered');
      ok(btns.some(b => /Discard/.test(b.textContent)), 's1: Discard offered');
      btns.find(b => /Resume session/.test(b.textContent)).click();
      await tick(400); // sheet close animation is real-time 190ms
      const runner = l2.w.document.querySelector('#modal-host .runner');
      ok(!!runner && /Get ready/.test(runner.textContent) && /Back-off 1\/2/.test(runner.textContent),
        's1: resumed at PREP of back-off 1 (runner alive after close animation)');
      // finish the remaining two back-offs and save
      ok(await drive(l2.w, [{ load: 30, rpe: 8 }, { load: 29.5, rpe: 7.5 }], /Save & close/, true), 's1: reached Save & close');
      const logs = await l2.w.DB.logsNewestFirst();
      const e = logs[0];
      ok(!!e && e.topSetLoadKg === 35 && e.topSetRPE === 9.5 && e.sets === 3 && e.date === todayISO(),
        's1: full session saved across relaunch (' + (e && (e.sets + ' sets, top ' + e.topSetLoadKg + '@' + e.topSetRPE + ', ' + e.date)) + ')');
      ok(e && JSON.stringify(e.setsDetail) === JSON.stringify([{ load: 35, rpe: 9.5 }, { load: 30, rpe: 8 }, { load: 29.5, rpe: 7.5 }]),
        's1: setsDetail spans both launches');
      ok(!(await l2.w.DB.getMeta('pendingRunnerSession')), 's1: snapshot cleared after save');
    }
    l2.dom.window.close();
  }

  // ---------- scenario 2: stale -> no Resume; save under original date ----
  {
    const idb = new FDBFactory();
    const { dom, w } = boot(idb);
    await tick(120);
    await w.DB.resetAll();
    w.Runner.start(PLAN);
    ok(await drive(w, [{ load: 34, rpe: 9 }], /Skip rest/, false), 's2: reached REST after top set');
    await tick(60);
    const snap = await w.DB.getMeta('pendingRunnerSession');
    snap.date = yesterdayISO(); // pretend a day passed
    await w.DB.setMeta('pendingRunnerSession', snap);
    dom.window.close();

    const l2 = await bootAndFindPrompt(idb);
    ok(!!l2.sheet, 's2: recovery prompt shown for stale session');
    if (l2.sheet) {
      const btns = [...l2.sheet.querySelectorAll('button')];
      ok(!btns.some(b => /Resume session/.test(b.textContent)), 's2: Resume NOT offered for previous-day session');
      btns.find(b => /Save what/.test(b.textContent)).click();
      await tick(400);
      const runner = l2.w.document.querySelector('#modal-host .runner');
      ok(!!runner && /Session complete/.test(runner.textContent), 's2: jumped to end screen');
      const save = [...(runner || l2.w.document).querySelectorAll('button')].find(b => /Save & close/.test(b.textContent));
      save && save.click();
      await tick(200);
      const e = (await l2.w.DB.logsNewestFirst())[0];
      ok(!!e && e.date === yesterdayISO() && e.sets === 1 && e.topSetLoadKg === 34,
        's2: logged under ORIGINAL date (' + (e && (e.date + ', ' + e.sets + ' sets')) + ')');
      ok(!(await l2.w.DB.getMeta('pendingRunnerSession')), 's2: snapshot cleared after save');
    }
    l2.dom.window.close();
  }

  // ---------- scenario 3: Discard ----------
  {
    const idb = new FDBFactory();
    const { dom, w } = boot(idb);
    await tick(120);
    await w.DB.resetAll();
    w.Runner.start(PLAN);
    await drive(w, [{ load: 33, rpe: 9 }], /Skip rest/, false);
    await tick(60);
    dom.window.close();

    const l2 = await bootAndFindPrompt(idb);
    ok(!!l2.sheet, 's3: recovery prompt shown');
    if (l2.sheet) {
      // count in THIS launch: resetAll cleared the 'seeded' flag, so the
      // relaunch re-seeds demo data — counting across launches would drift.
      const before = (await l2.w.DB.logsNewestFirst()).length;
      [...l2.sheet.querySelectorAll('button')].find(b => /Discard/.test(b.textContent)).click();
      await tick(300);
      ok(!(await l2.w.DB.getMeta('pendingRunnerSession')), 's3: snapshot cleared on discard');
      ok(!l2.w.document.querySelector('#modal-host .runner'), 's3: no runner mounted');
      ok((await l2.w.DB.logsNewestFirst()).length === before, 's3: no log entry written');
    }
    l2.dom.window.close();
  }

  // ---------- scenario 4: Quit inside runner clears snapshot ----------
  {
    const idb = new FDBFactory();
    const { dom, w } = boot(idb);
    await tick(120);
    await w.DB.resetAll();
    w.Runner.start(PLAN);
    await drive(w, [{ load: 32, rpe: 9 }], /Skip rest/, false);
    await tick(60);
    ok(!!(await w.DB.getMeta('pendingRunnerSession')), 's4: snapshot exists mid-session');
    w.document.getElementById('r-quit').click();
    await tick(60);
    const ov = [...w.document.querySelectorAll('#modal-host .sheet-overlay')].pop();
    const quit = ov && [...ov.querySelectorAll('button.btn')].find(b => b.textContent.trim() === 'Quit');
    ok(!!quit, 's4: quit confirm shown');
    quit && quit.click();
    await tick(300);
    ok(!(await w.DB.getMeta('pendingRunnerSession')), 's4: snapshot cleared on quit');
    dom.window.close();
  }

  // ---------- scenario 5: stale + zero sets -> silently dropped ----------
  {
    const idb = new FDBFactory();
    const a = boot(idb);
    await tick(150);
    await a.w.DB.setMeta('pendingRunnerSession',
      { plan: { role: 'Heavy', protocol: 'topSetPlusBackoffs' }, sets: [], date: yesterdayISO(), totalEfforts: 3 });
    a.dom.window.close();
    const l2 = await bootAndFindPrompt(idb); // waits ~1.5s, expects nothing
    ok(!l2.sheet, 's5: no prompt for stale empty session');
    ok(!(await l2.w.DB.getMeta('pendingRunnerSession')), 's5: stale empty snapshot auto-cleared');
    l2.dom.window.close();
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

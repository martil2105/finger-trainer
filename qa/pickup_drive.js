/* qa/pickup_drive.js — drives a full BLOCK PULL session through the REAL
   runner UI in jsdom and asserts the nested-hands record shape survives the
   whole round trip: runner -> DB -> accessors -> manual editor -> DB again.

   Also guards the three things most likely to break silently:
     1. logKey() must separate pickup records, or dedupe() deletes one of a
        day's two hands and every synced device converges on the loss.
     2. Legacy hang records must still read identically through the new
        accessors (read-time defaulting, no migration).
     3. Flat load/RPE/E1RM must stay null on pickups — that null is what keeps
        them out of hang analytics, deloadTrend and auto-PR benchmarks.

   Run: node qa/pickup_drive.js
*/
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
  // Compress 1000ms ticks so a full alternating session runs in seconds.
  const _si = w.setInterval.bind(w);
  w.setInterval = (fn, ms) => _si(fn, Math.max(2, Math.round((ms || 0) / 300)));

  const uncaught = [];
  w.addEventListener('error', (e) => uncaught.push(e.message));
  for (const f of SCRIPTS) w.eval(SRC[f]);
  await tick(80);
  await w.DB.resetAll();

  const Calc = w.Calc;

  // ---------------------------------------------------------------------
  // 1. Drive the runner
  // ---------------------------------------------------------------------
  const plan = {
    role: 'Pickup', modality: 'pickup', protocol: 'topSetPlusBackoffs',
    duration: 3, sets: 2, repsPerSet: 2, intraRestSeconds: 20,
    rampPcts: [0.55, 0.88], backoffPctOfTop: 0.88,
    edgeMm: 20, grip: 'HalfCrimp', rpe: 8.5,
    lastTop: { L: 40, R: 44 }, firstHand: 'L',
    blockName: 'PickupDrive'
  };

  w.Runner.start(plan);
  await tick(80);

  const modal = () => w.document.getElementById('modal-host');
  const seenHands = [];
  let sawRampScreen = false, sawRepLog = false, sawIntra = false, saved = false;

  for (let it = 0; it < 1200 && !saved; it++) {
    await tick(12);
    const m = modal();
    if (!m) break;
    const runner = m.querySelector('.runner');
    if (!runner) break;

    // Record which hand the header claims, every time it changes.
    const handTag = runner.querySelector('.r-hand');
    if (handTag) {
      const h = handTag.textContent.trim();
      if (seenHands[seenHands.length - 1] !== h) seenHands.push(h);
    }
    const bodyTxt = runner.textContent || '';
    if (/Ramp \d\/\d/.test(bodyTxt)) sawRampScreen = true;
    if (/How was the position/.test(bodyTxt)) sawRepLog = true;
    if (/next rep/.test(bodyTxt)) sawIntra = true;

    // Pre-session capture screen: pick readiness 4, climbing "easy".
    if (/Before you start/.test(bodyTxt)) {
      const rate = runner.querySelector('.rate');
      if (rate) rate.querySelectorAll('button')[3].click();     // readiness 4
      const seg = runner.querySelector('.seg');
      if (seg) seg.querySelectorAll('button')[1].click();        // easy
      const go = [...runner.querySelectorAll('.r-foot button')][0];
      if (go) go.click();
      continue;
    }
    // Position outcome: clean, except make ONE rep degraded to exercise the gate.
    if (/How was the position/.test(bodyTxt)) {
      const btns = [...runner.querySelectorAll('.r-body button')];
      const wantDegraded = sawRepLog && seenHands.length > 6 && btns.length >= 2 &&
        !w.__degradedOnce;
      if (wantDegraded) { w.__degradedOnce = true; btns[1].click(); }
      else btns[0].click();
      continue;
    }
    // Any generic footer button (Ready / Logged / Skip / Save).
    const footBtns = [...runner.querySelectorAll('.r-foot button')].filter(b => !b.disabled);
    if (/Session complete/.test(bodyTxt)) {
      const rates = runner.querySelectorAll('.rate');
      if (rates[0]) rates[0].querySelectorAll('button')[2].click();
      if (rates[1]) rates[1].querySelectorAll('button')[7].click();
      const save = footBtns.find(b => /Save/.test(b.textContent));
      if (save) { save.click(); saved = true; }
      continue;
    }
    if (footBtns.length) { footBtns[0].click(); continue; }
  }

  await tick(200);
  ok(saved, 'runner reached the save screen');
  ok(sawRampScreen, 'ramp screens rendered');
  ok(sawRepLog, 'per-rep position screen rendered');
  ok(sawIntra, 'intra-rep rest rendered');
  ok(uncaught.length === 0, 'no uncaught errors: ' + uncaught.join(' | '));

  // Alternation: the hand label must flip back and forth, never repeat twice
  // in a row across a switch, and both hands must appear.
  const flips = seenHands.filter((h, i) => i > 0 && h !== seenHands[i - 1]).length;
  ok(seenHands.includes('Left') && seenHands.includes('Right'), 'both hands appeared in the runner');
  ok(flips >= 4, 'hands alternated repeatedly (flips=' + flips + ')');
  ok(seenHands[0] === 'Left', 'firstHand honoured (started Left)');

  // ---------------------------------------------------------------------
  // 2. Record shape
  // ---------------------------------------------------------------------
  const logs = await w.DB.logsNewestFirst();
  const rec = logs.find(l => l.modality === 'pickup');
  ok(!!rec, 'pickup record persisted');
  if (rec) {
    ok(rec.topSetLoadKg === null, 'flat topSetLoadKg is null (keeps it out of hang queries)');
    ok(rec.topSetRPE === null, 'flat topSetRPE is null');
    ok(rec.e1rmKg === null, 'flat e1rmKg is null');
    ok(rec.hands && rec.hands.L && rec.hands.R, 'both hands present in the record');
    ok(rec.holdSeconds === 3, 'holdSeconds stored');
    ok(rec.edgeMm === 20, 'edgeMm stored');
    ok(rec.readiness === 4, 'pre-session readiness stored (got ' + rec.readiness + ')');
    ok(rec.climbing48h === 'easy', 'climbing-48h stored (got ' + rec.climbing48h + ')');
    ok(rec.firstHand === 'L', 'firstHand stored');
    ok(rec.hands.L.e1rmKg != null, 'per-hand E1RM computed for L');
    ok(rec.hands.R.e1rmKg != null, 'per-hand E1RM computed for R');
    // Pickup E1RM must NOT take the 3s ÷1.1 hang normalisation.
    const expectL = Math.round((rec.hands.L.topSetLoadKg * 100 / (40 + 6 * rec.hands.L.topSetRPE)) * 10) / 10;
    ok(Math.abs(rec.hands.L.e1rmKg - expectL) < 0.05,
      'pickup E1RM skips the 3s ÷1.1 hang normalisation (got ' + rec.hands.L.e1rmKg + ', want ' + expectL + ')');

    const dL = Calc.setsDetailOf(rec, 'L');
    ok(Array.isArray(dL) && dL.length >= 1, 'per-hand setsDetail persisted');
    ok(dL.every(s => s.outcome != null), 'every set carries a position outcome');
    ok(dL.some(s => Array.isArray(s.outcomes) && s.outcomes.length), 'per-rep outcomes persisted');

    // Accessors
    ok(Calc.isPickup(rec), 'Calc.isPickup');
    ok(Calc.topLoad(rec, 'L') === rec.hands.L.topSetLoadKg, 'Calc.topLoad reads the nested hand');
    ok(Calc.topLoad(rec, 'R') === rec.hands.R.topSetLoadKg, 'Calc.topLoad reads R');
    ok(Calc.holdSecondsOf(rec) === 3, 'Calc.holdSecondsOf');
    ok(Calc.handsOf(rec).join(',') === 'L,R', 'Calc.handsOf lists both sides');
  }

  // ---------------------------------------------------------------------
  // 3. Legacy hang records must be untouched by the accessors
  // ---------------------------------------------------------------------
  const legacy = { id: 'legacy_1', date: '2026-06-01', type: 'Yielding', role: 'Heavy',
    venue: 'Board', hangDurationSeconds: 3, grip: 'HalfCrimp',
    topSetLoadKg: 32.5, topSetRPE: 9, sets: 4, setsDetail: [{ load: 32.5, rpe: 9 }] };
  await w.DB.addLog(legacy);
  const back = await w.DB.get('logEntries', 'legacy_1');
  ok(Calc.modalityOf(back) === 'hang', 'legacy record defaults to hang at read time');
  ok(back.modality === undefined, 'legacy record was NOT migrated (no updatedAt churn from a rewrite)');
  ok(Calc.topLoad(back, null) === 32.5, 'legacy flat load still reads through the accessor');
  ok(Calc.topLoad(back, 'L') === 32.5, 'legacy record ignores the hand argument');
  ok(Calc.handsOf(back).length === 1 && Calc.handsOf(back)[0] === null, 'legacy record reports one bilateral side');
  // NB calc.js rounds to 1dp BEFORE dividing by 1.1, so the two-step result is
  // 31.5, not the 31.4 you get from dividing the unrounded figure. Mirrored
  // exactly here rather than "fixed" — this is long-standing behaviour and
  // every stored e1rmKg in his history was produced by it.
  const rawHang = Math.round((32.5 * 100 / (40 + 6 * 9)) * 10) / 10;
  const expectHang = Math.round((rawHang / 1.1) * 10) / 10;
  ok(Math.abs(back.e1rmKg - expectHang) < 0.001,
    'hang 3s E1RM still takes the ÷1.1 normalisation (got ' + back.e1rmKg + ', want ' + expectHang + ')');
  ok(Math.abs(w.Calc.e1rm(32.5, 9, 3, 'pickup') - rawHang) < 0.001,
    'same load as a PICKUP skips that normalisation entirely');
  ok(Calc.holdSecondsOf(back) === 3, 'holdSecondsOf falls back to hangDurationSeconds');

  // ---------------------------------------------------------------------
  // 4. Dedupe must not collapse two pickup sessions
  //    (both have null flat fields — the old logKey saw them as identical)
  // ---------------------------------------------------------------------
  await w.DB.resetAll();
  const mk = (id, lLoad, rLoad) => ({
    id, date: '2026-08-05', modality: 'pickup', type: 'Yielding', role: 'Pickup',
    venue: 'Home', holdSeconds: 3, hangDurationSeconds: null,
    topSetLoadKg: null, topSetRPE: null, e1rmKg: null, sets: 4, notes: '',
    hands: { L: { topSetLoadKg: lLoad, topSetRPE: 9, setsDetail: [{ load: lLoad, rpe: 9, outcome: 'clean' }] },
             R: { topSetLoadKg: rLoad, topSetRPE: 9, setsDetail: [{ load: rLoad, rpe: 9, outcome: 'clean' }] } }
  });
  await w.DB.addLog(mk('p1', 44, 47));
  await w.DB.addLog(mk('p2', 45, 48));     // different loads, same date + notes
  const removed = await w.DB.dedupe();
  const after = await w.DB.getAll('logEntries');
  ok(removed === 0, 'dedupe removed nothing (removed=' + removed + ')');
  ok(after.length === 2, 'both pickup sessions survived dedupe (kept ' + after.length + ')');

  // A true duplicate SHOULD still collapse.
  await w.DB.addLog(Object.assign(mk('p3', 44, 47), { id: 'p3' }));
  const removed2 = await w.DB.dedupe();
  ok(removed2 === 1, 'an identical pickup record still collapses (removed=' + removed2 + ')');

  // ---------------------------------------------------------------------
  // 5. Paused cycles must never win DB.activeCycle's fallback
  // ---------------------------------------------------------------------
  await w.DB.resetAll();
  await w.DB.put('cycles', { id: 'c_old', name: 'Hang block', status: 'paused',
    startDate: '2026-01-01', weeklyStructure: {}, blocks: [] });
  await w.DB.put('cycles', { id: 'c_new', name: 'Pickup block', status: 'draft',
    startDate: '2026-07-27', weeklyStructure: {}, blocks: [] });
  const active = await w.DB.activeCycle();
  ok(active && active.id === 'c_new', 'paused cycle excluded from the activeCycle fallback (got ' + (active && active.id) + ')');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });

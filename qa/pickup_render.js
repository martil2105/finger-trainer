/* qa/pickup_render.js — renders every pickup-facing screen against seeded
   data and asserts nothing throws and the key readouts appear.

   The drive harness proves the DATA round trip; this one proves the RENDER
   path, which is where most of the new code lives (per-hand hero, asymmetry
   card, day-of-week, position, context, manual editor, Today card).

   Run: node qa/pickup_render.js
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

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 18 sessions, Mon/Wed/Fri, right hand stronger, one degraded top set,
   one session with a missing hand — i.e. the shapes the UI has to survive.

   Dates are built with pure UTC arithmetic off a known Monday. An earlier
   version stepped a local Date by getDay() and read it back with
   toISOString(), which scattered the sessions across all seven weekdays and
   quietly stopped the day-of-week verdict from ever being exercised — the
   card correctly reported "not enough data" and the test happily passed. */
function seedSessions(mondayISO, weeks) {
  const rnd = mulberry32(99);
  const out = [];
  let base = 42;
  // Step in LOCAL calendar days, the same way app.js reads a date back
  // (`new Date(iso + 'T00:00:00')`). Doing the arithmetic in UTC and reading
  // it back locally slid every session one weekday, which is exactly the
  // class of bug this file exists to catch.
  const addDays = (iso, n) => {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + n);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  };
  const OFFSETS = [0, 2, 4];              // Mon, Wed, Fri
  const dates = [];
  for (let wk = 0; wk < weeks; wk++) {
    OFFSETS.forEach(off => dates.push(addDays(mondayISO, wk * 7 + off)));
  }
  for (let i = 0; i < dates.length; i++) {
    const iso = dates[i];
    base += 0.35 + (rnd() - 0.5) * 0.3;
    const noise = () => (rnd() - 0.5) * 2.2;
    const gap = 3.5;
    const degraded = i === 7;
    const missingR = i === 11;
    // RPE spread matters: fitRpeCurve needs >= 2 points of spread before it
    // will calibrate, so a seed pinned at a single RPE silently only ever
    // exercises the generic-curve branch.
    const topRpe = [8, 8.5, 9, 9.5][Math.floor(rnd() * 4)];
    const mkSets = (top) => {
      const sets = [{ load: Math.round(top * 2) / 2, rpe: topRpe, reps: 3,
                      outcome: degraded ? 'degraded' : 'clean',
                      outcomes: degraded ? ['clean', 'degraded', 'clean'] : ['clean', 'clean', 'clean'] }];
      for (let b = 0; b < 3; b++) {
        sets.push({ load: Math.round(top * 0.88 * 2) / 2, rpe: 8, reps: 3, outcome: 'clean',
                    outcomes: ['clean', 'clean', 'clean'] });
      }
      return sets;
    };
    const lTop = base - gap / 2 + noise();
    const rTop = base + gap / 2 + noise();
    out.push({
      id: 'seed_pick_' + i, date: iso, modality: 'pickup', type: 'Yielding',
      role: 'Pickup', venue: 'Home', holdSeconds: 3, hangDurationSeconds: null,
      grip: 'HalfCrimp', edgeMm: 20, firstHand: 'L',
      readiness: 3 + Math.round(rnd()), climbing48h: ['none', 'easy', 'hard'][Math.floor(rnd() * 3)],
      topSetLoadKg: null, topSetRPE: null, e1rmKg: null, setsDetail: null,
      hands: {
        L: { topSetLoadKg: Math.round(lTop * 2) / 2, topSetRPE: topRpe, setsDetail: mkSets(lTop), e1rmKg: null },
        R: missingR ? null
          : { topSetLoadKg: Math.round(rTop * 2) / 2, topSetRPE: topRpe, setsDetail: mkSets(rTop), e1rmKg: null }
      },
      sets: missingR ? 4 : 8, bodyweightKg: null, taxing: 3, feltStrong: 7,
      nextDayFeel: 3 + Math.round(rnd()), block: 'Data Block · 6 wk', notes: ''
    });
  }
  return out;
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL: ' + n); } };

  const dom = new JSDOM(SHELL_HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://localhost/' });
  const w = dom.window;
  w.indexedDB = new FDBFactory();
  w.IDBKeyRange = FDBKeyRange;
  w.alert = () => {}; w.confirm = () => true;
  w.matchMedia = (q) => ({ matches: true, media: q, addEventListener() {}, addListener() {} });
  w.AudioContext = class { constructor(){ this.state='running'; this.currentTime=0; this.destination={}; }
    resume(){} createOscillator(){ return { connect(){}, start(){}, stop(){}, frequency:{value:0}, type:'' }; }
    createGain(){ return { connect(){}, gain:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){} } }; } };
  w.fetch = () => Promise.reject(new Error('no network'));

  const uncaught = [];
  w.addEventListener('error', (e) => uncaught.push(e.message));
  const errLog = [];
  w.console.error = (...a) => errLog.push(a.map(String).join(' '));

  for (const f of SCRIPTS) w.eval(SRC[f]);
  await tick(80);
  await w.DB.resetAll();

  // --- cycle: active pickup block + a paused hang block -------------------
  const cyc = w.Templates.templateP();
  // Walk back to a real LOCAL Monday. Deriving it with toISOString() slid the
  // whole seed by a day under UTC+2, which then labelled the day-of-week table
  // Sun/Tue/Thu — harmless to the maths, but a test that reads dishonestly.
  const backToMonday = () => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - 35);
    while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  };
  cyc.startDate = backToMonday();
  // Force TODAY to be a training day whatever weekday the test runs on.
  // Previously this depended on the real calendar, so the Today card was only
  // exercised on Mon/Wed/Fri — and on other days the assertions silently
  // matched the "Next session: Block pull" line on the REST card instead,
  // which is a false pass that varies by timezone.
  const DOWK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  cyc.weeklyStructure[DOWK[new Date().getDay()]] = 'Pickup';
  await w.DB.put('cycles', cyc);
  const hangCyc = w.Templates.templateD();
  hangCyc.status = 'paused';
  await w.DB.put('cycles', hangCyc);

  const sessions = seedSessions(cyc.startDate, 6);   // 6 weeks x Mon/Wed/Fri = 18
  for (const s of sessions) await w.DB.addLog(s);
  // a couple of legacy hang sessions so the modality toggle appears
  await w.DB.addLog({ id: 'legacy_a', date: '2026-06-10', type: 'Yielding', role: 'Heavy',
    venue: 'Board', hangDurationSeconds: 3, grip: 'HalfCrimp', topSetLoadKg: 31, topSetRPE: 9, sets: 4 });
  await w.DB.addLog({ id: 'legacy_b', date: '2026-06-17', type: 'Yielding', role: 'Heavy',
    venue: 'Board', hangDurationSeconds: 3, grip: 'HalfCrimp', topSetLoadKg: 32.5, topSetRPE: 9.5, sets: 4 });

  const view = () => w.document.getElementById('view');
  const txt = () => view().textContent || '';

  // ---- TODAY -----------------------------------------------------------
  w.App.state.tab = 'today';
  await w.App.render();
  await tick(60);
  ok(!/Something went wrong/.test(txt()), 'Today rendered without hitting the error boundary');
  const todayTxt = txt();
  // Must be the SESSION card, not the rest card's "Next session: Block pull".
  const isTrainingDay = /Start session/.test(todayTxt) && !/Rest day/.test(todayTxt);
  ok(isTrainingDay, 'Today rendered the block-pull session card');
  ok(/Left · last clean/.test(todayTxt) && /Right · last clean/.test(todayTxt), 'Today shows per-hand anchors');
  ok(/Ramp \(1 rep each/.test(todayTxt), 'Today shows the ramp ladder computed from history');
  ok(/technical failure/.test(todayTxt), 'Today states the RIR reference');
  ok(/does not advance the load|will not advance the load/.test(todayTxt), 'Today states the position gate');

  // ---- ANALYTICS (pickup) ----------------------------------------------
  w.App.state.tab = 'analytics';
  w.App.state.analyticsModality = 'pickup';
  await w.App.render();
  await tick(120);
  const a = txt();
  ok(!/Something went wrong/.test(a), 'Analytics/pickup rendered without hitting the error boundary');
  ok(/Top-set E1RM · per hand/.test(a), 'per-hand hero present');
  ok(/Best · left/.test(a) && /Best · right/.test(a), 'per-hand stat strip present');
  ok(/Asymmetry/.test(a), 'asymmetry section present');
  ok(/Day of week/.test(a), 'day-of-week section present');
  ok(/Filtered strength · per hand/.test(a), 'per-hand filtered strength present');
  ok(/Position/.test(a) && /Reps not clean/.test(a), 'position-integrity card present');
  ok(/Context/.test(a) && /Readiness before session/.test(a), 'context card present');
  ok(!/% BW/.test(a), '%BW card is NOT shown for pickups (meaningless without a bodyweight component)');
  const svgs = view().querySelectorAll('svg');
  ok(svgs.length >= 3, 'charts drew (svg count=' + svgs.length + ')');
  // The asymmetry verdict must state its uncertainty either way.
  ok(/inside the noise|larger than the measurement noise/.test(a),
    'asymmetry verdict states whether the gap is resolved');

  // Day-of-week must actually reach a verdict on a Mon/Wed/Fri block with 6
  // sessions per day — not fall through to "not enough data". This is the
  // question the uniform-session design exists to answer, so a silent
  // fallthrough here would make the whole block pointless.
  // NB [^.]* is wrong here — the sentence contains decimals ("+0.7 kg", "0.5σ").
  ok(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun) runs [+−-][\d.]+ kg against (Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(a),
    'day-of-week reached a verdict rather than "not enough data"');
  ok(/Mon runs|against Mon/.test(a), 'day-of-week grouped onto the real training weekdays');
  ok(!/Three sessions on each training day/.test(a),
    'day-of-week did NOT fall through to the not-enough-data message');
  ok(/Mean of both hands per session/.test(a),
    'day-of-week explains what it is measuring');
  // With 6 sessions on each of 3 weekdays, every bucket must be counted.
  const dowRows = (a.match(/±/g) || []).length;
  ok(dowRows >= 3, 'day-of-week table has a row with SE for each training day (' + dowRows + ')');

  // ---- ANALYTICS (hang) — legacy path must be untouched ------------------
  w.App.state.analyticsModality = 'hang';
  await w.App.render();
  await tick(120);
  const hgt = txt();
  ok(!/Something went wrong/.test(hgt), 'Analytics/hang still renders');
  ok(/5s E1RM/.test(hgt), 'hang hero still present');
  ok(!/Best · left/.test(hgt), 'pickup cards do not leak into the hang view');

  // ---- HISTORY ----------------------------------------------------------
  w.App.state.tab = 'history';
  await w.App.render();
  await tick(60);
  const h = txt();
  ok(!/Something went wrong/.test(h), 'History rendered');
  ok(/Block pull · 3s · 20mm/.test(h), 'pickup rows labelled with hold + edge');
  ok(/gap /.test(h), 'pickup rows show the L/R gap');

  // ---- PROGRAM ----------------------------------------------------------
  w.App.state.tab = 'program';
  await w.App.render();
  await tick(60);
  ok(!/Something went wrong/.test(txt()), 'Program rendered with a pickup cycle active');

  // ---- MANUAL PICKUP EDITOR --------------------------------------------
  const rec = (await w.DB.logsNewestFirst()).find(l => l.modality === 'pickup');
  w.App.openPickupLog(rec);
  await tick(60);
  const sheet = w.document.querySelector('#modal-host .sheet');
  ok(!!sheet, 'pickup editor sheet opened');
  if (sheet) {
    const st = sheet.textContent;
    ok(/Left hand · sets/.test(st) && /Right hand · sets/.test(st), 'editor shows both hands');
    ok(/RIR/.test(st), 'editor uses RIR');
    ok(/Readiness before the session/.test(st), 'editor exposes readiness');
    const save = [...sheet.querySelectorAll('button.btn')].find(b => /Save changes/.test(b.textContent));
    ok(!!save, 'editor has a save button');
    if (save) {
      save.click();
      await tick(120);
      const again = await w.DB.get('logEntries', rec.id);
      ok(again && again.modality === 'pickup', 'edit round-trip kept modality');
      ok(again && again.hands && again.hands.L && again.hands.R, 'edit round-trip kept both hands');
      ok(again && again.topSetLoadKg === null, 'edit round-trip kept the flat fields null');
      ok(again && again.readiness != null, 'edit round-trip preserved readiness');
      ok(again && Array.isArray(again.hands.L.setsDetail) && again.hands.L.setsDetail[0].outcome != null,
        'edit round-trip preserved per-set outcomes');
    }
  }

  ok(uncaught.length === 0, 'no uncaught errors: ' + uncaught.join(' | '));
  const realErrors = errLog.filter(e => !/Not implemented/.test(e));
  ok(realErrors.length === 0, 'no console.error output: ' + realErrors.slice(0, 2).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });

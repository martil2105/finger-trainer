/* edge_split.js — 2026-08-16 edge-size split.
 *
 * Martin started hanging on a 15mm edge alongside his 20mm history. Edge is
 * now a first-class key everywhere hold duration already was. This harness
 * covers the four places where getting it wrong loses or corrupts data:
 *   1. read-time defaults (a record with no edgeMm IS 20mm, not "unknown")
 *   2. dedupe signatures (two sessions differing only by edge must not collapse)
 *   3. Working Max / PR scoping (a 15mm test must not overwrite the 20mm anchor)
 *   4. analytics series (a smaller edge must not render as lost strength)
 *
 * Runs the REAL app in jsdom, not stubs.
 */
'use strict';
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');
const APP = path.resolve(__dirname, '..');
const SCRIPTS = ['calc.js', 'templates.js', 'db.js', 'sync.js', 'timer.js', 'builder.js',
                 'cone_data.js', 'cone.js', 'kalman_data.js', 'kalman.js', 'rpe_cal.js',
                 'app.js', 'motion.js'];
const SRC = {}; SCRIPTS.forEach(f => SRC[f] = fs.readFileSync(path.join(APP, f), 'utf8'));
const SHELL = fs.readFileSync(path.join(APP, 'index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '').replace(/<script>[\s\S]*?<\/script>/g, '');
const tick = ms => new Promise(r => setTimeout(r, ms));

(async () => {
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL: ' + n); } };

const dom = new JSDOM(SHELL, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://localhost/' });
const w = dom.window;
w.indexedDB = new FDBFactory(); w.IDBKeyRange = FDBKeyRange;
w.alert = () => {}; w.confirm = () => true;
w.matchMedia = q => ({ matches: true, media: q, addEventListener() {}, addListener() {} });
w.AudioContext = class { constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  resume() {} createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: { value: 0 }, type: '' }; }
  createGain() { return { connect() {}, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; } };
w.fetch = () => Promise.reject(new Error('no network'));
const uncaught = []; w.addEventListener('error', e => uncaught.push(e.message));
const errs = []; w.console.error = (...a) => errs.push(a.map(String).join(' '));
for (const f of SCRIPTS) w.eval(SRC[f]);
await tick(80);

const { Calc, DB, App, Templates, Runner } = w;
// Capture confirms instead of rendering them — several assertions below turn on
// whether a PR prompt fired at all.
const confirms = [];
App.confirm = (msg, label, onOk) => { confirms.push({ msg, label, onOk }); };

// ---------------------------------------------------------------- fixture
await DB.resetAll();
const mk = async (date, dur, load, rpe, edge, extra) => {
  const e = Object.assign({
    id: Templates.uid(), date, type: 'Yielding', role: 'Heavy', venue: 'Board',
    hangDurationSeconds: dur, grip: 'HalfCrimp', topSetLoadKg: load, topSetRPE: rpe,
    sets: 4, notes: ''
  }, extra || {});
  if (edge != null) e.edgeMm = edge;      // omitted entirely = legacy record
  return DB.addLog(e);
};
// 20mm history (the old series) — one row deliberately has NO edgeMm at all.
await mk('2026-06-02', 3, 30, 9, null);          // legacy shape
await mk('2026-06-09', 3, 31, 9, 20);
await mk('2026-06-16', 3, 32, 9, 20);
await mk('2026-06-23', 3, 31.5, 9, 20);
// 15mm history (the new series)
await mk('2026-07-22', 3, 22, 9, 15);
await mk('2026-07-29', 3, 23, 9, 15);
await mk('2026-08-05', 3, 24, 9, 15);
await mk('2026-08-12', 3, 23.5, 9, 15);
await DB.save('workingMaxes', { id: 'wm20', durationSeconds: 3, edgeMm: 20, valueKg: 32, date: '2026-06-16', source: 'test' });
await DB.save('workingMaxes', { id: 'wm15', durationSeconds: 3, edgeMm: 15, valueKg: 24, date: '2026-08-05', source: 'test' });
await DB.save('workingMaxes', { id: 'wmLegacy5', durationSeconds: 5, valueKg: 25, date: '2026-05-26', source: 'estimated' });

// ------------------------------------------------- A. read-time accessors
ok(Calc.edgeMmOf({}) === 20, 'A1 missing edgeMm reads as 20mm');
ok(Calc.edgeMmOf(null) === 20, 'A2 null record reads as 20mm');
ok(Calc.edgeMmOf({ edgeMm: 15 }) === 15, 'A3 explicit 15mm survives');
ok(Calc.edgeMmOf({ edgeMm: 'junk' }) === 20, 'A4 junk edge falls back to 20mm');
ok(Calc.edgeMmOf({ edgeMm: 0 }) === 20, 'A5 zero edge falls back to 20mm');
ok(Calc.strengthKey(3, 15) !== Calc.strengthKey(3, 20), 'A6 strengthKey separates edges');
ok(Calc.strengthKey(3, null) === Calc.strengthKey(3, 20), 'A7 strengthKey defaults null edge to 20mm');
ok(Calc.cycleEdgeMm({}) === 20 && Calc.cycleEdgeMm({ edgeMm: 15 }) === 15, 'A8 cycleEdgeMm defaults + honours');

// -------------------------------------------------------- B. WM look-ups
const wm3_20 = await DB.currentWM(3, 20), wm3_15 = await DB.currentWM(3, 15);
ok(wm3_20 && wm3_20.valueKg === 32, 'B1 currentWM(3,20) = 32');
ok(wm3_15 && wm3_15.valueKg === 24, 'B2 currentWM(3,15) = 24');
const wm3_legacyCall = await DB.currentWM(3);
ok(wm3_legacyCall && wm3_legacyCall.valueKg === 32, 'B3 currentWM(3) with no edge still means 20mm');
const wm5_legacyRec = await DB.currentWM(5);
ok(wm5_legacyRec && wm5_legacyRec.valueKg === 25, 'B4 a WM record with no edgeMm is found as 20mm');
ok((await DB.currentWM(3, 10)) === null, 'B5 an untrained edge has no WM');
const wmFor = await DB.wmLookup();
ok(wmFor(3, 15) === 24 && wmFor(3, 20) === 32, 'B6 wmLookup separates edges');
ok(wmFor(3) === 32, 'B7 wmLookup defaults to 20mm');
ok(wmFor(3, 10) === null, 'B8 wmLookup returns null for an unknown edge');
const keys = await DB.wmKeysOnFile();
const hasKey = (d, e) => keys.some(k => k.durationSeconds === d && k.edgeMm === e);
ok(hasKey(3, 20) && hasKey(3, 15) && hasKey(5, 20), 'B9 wmKeysOnFile lists every (duration, edge)');

// --------------------------------- C. dedupe must not collapse across edges
// This is the failure mode that would be silent AND unrecoverable: dedupe
// converges every device on the same winner, so a bad key deletes the row
// everywhere at once.
const twinBase = {
  date: '2026-08-14', type: 'Yielding', role: 'Heavy', venue: 'Board',
  hangDurationSeconds: 3, grip: 'HalfCrimp', topSetLoadKg: 26, topSetRPE: 9, sets: 4, notes: 'twin'
};
await DB.save('logEntries', Object.assign({ id: 'twin20', edgeMm: 20 }, twinBase));
await DB.save('logEntries', Object.assign({ id: 'twin15', edgeMm: 15 }, twinBase));
await DB.save('logEntries', Object.assign({ id: 'twin20b', edgeMm: 20 }, twinBase));   // true duplicate
await DB.save('workingMaxes', { id: 'twinWm20', durationSeconds: 7, edgeMm: 20, valueKg: 28, date: '2026-08-14' });
await DB.save('workingMaxes', { id: 'twinWm15', durationSeconds: 7, edgeMm: 15, valueKg: 28, date: '2026-08-14' });
await DB.save('benchmarks', { id: 'twinB20', date: '2026-08-14', durationSeconds: 7, edgeMm: 20, maxLoadKg: 28, rpe: 9.5 });
await DB.save('benchmarks', { id: 'twinB15', date: '2026-08-14', durationSeconds: 7, edgeMm: 15, maxLoadKg: 28, rpe: 9.5 });
await DB.dedupe();
const afterLogs = await DB.getAll('logEntries');
const liveIds = new Set(afterLogs.map(l => l.id));
// Which of the two same-edge duplicates wins is decided by preferred() and is
// not something this test should pin; what matters is that the DIFFERENT-edge
// row is never the one thrown away.
const survivors20 = ['twin20', 'twin20b'].filter(id => liveIds.has(id)).length;
ok(liveIds.has('twin15') && survivors20 >= 1,
   'C1 same-day twin sessions on different edges BOTH survive dedupe');
ok(survivors20 === 1,
   'C2 a genuine duplicate (same edge) still collapses — dedupe not just disabled');
const afterWm = (await DB.getAll('workingMaxes')).map(x => x.id);
ok(afterWm.includes('twinWm20') && afterWm.includes('twinWm15'), 'C3 twin WMs on different edges both survive');
const afterB = (await DB.getAll('benchmarks')).map(x => x.id);
ok(afterB.includes('twinB20') && afterB.includes('twinB15'), 'C4 twin benchmarks on different edges both survive');
// clean the twins back out so they don't skew the analytics assertions
for (const id of ['twin20', 'twin15', 'twin20b']) { try { await DB.del('logEntries', id); } catch (e) {} }
for (const id of ['twinWm20', 'twinWm15']) { try { await DB.del('workingMaxes', id); } catch (e) {} }
for (const id of ['twinB20', 'twinB15']) { try { await DB.del('benchmarks', id); } catch (e) {} }

// --------------------------------------------- D. plan expansion + anchors
const hangBlock = Templates.block('Test Block', 'TopSet', 2, 3, 'topSetPlusBackoffs', 9, 9, 4, 4, 0.865, 3, 0.85, 0.85, 0, '3-5');
const cyc20 = { id: 'c20', name: 'C20', status: 'active', startDate: '2026-08-03', edgeMm: 20,
  weeklyStructure: { mon: 'Rest', tue: 'Rest', wed: 'Rest', thu: 'Heavy', fri: 'Rest', sat: 'Heavy', sun: 'Rest' },
  blocks: [JSON.parse(JSON.stringify(hangBlock))] };
const cyc15 = JSON.parse(JSON.stringify(cyc20)); cyc15.id = 'c15'; cyc15.edgeMm = 15;
const wk20 = App.getWeeks(cyc20, wmFor)[0], wk15 = App.getWeeks(cyc15, wmFor)[0];
ok(wk20.edgeMm === 20 && wk15.edgeMm === 15, 'D1 cycle edge propagates to every week');
ok(wk20.heavyAnchorKg === Calc.heavyAnchor(32, wk20.heavyRPE), 'D2 20mm week anchors off the 20mm WM');
ok(wk15.heavyAnchorKg === Calc.heavyAnchor(24, wk15.heavyRPE), 'D3 15mm week anchors off the 15mm WM');
ok(wk15.heavyAnchorKg < wk20.heavyAnchorKg, 'D4 the two anchors are genuinely different numbers');
ok(wk20.wmMissing === false && wk15.wmMissing === false, 'D5 neither edge reports a missing WM');
// a cycle on an edge with no WM must say so rather than borrowing the other one
const cyc10 = JSON.parse(JSON.stringify(cyc20)); cyc10.id = 'c10'; cyc10.edgeMm = 10;
const wk10 = App.getWeeks(cyc10, wmFor)[0];
ok(wk10.wmMissing === true && wk10.heavyAnchorKg == null,
   'D6 an edge with no WM reports missing rather than borrowing another edge');
// block-level edge beats the cycle edge
const cycMixed = JSON.parse(JSON.stringify(cyc20));
cycMixed.blocks[0].heavy.edgeMm = 15;
ok(App.getWeeks(cycMixed, wmFor)[0].edgeMm === 15, 'D7 block edge overrides cycle edge');
// deload/test weeks carry the edge too (a test writes a WM — on which edge?)
const cycDeload = { id: 'cd', name: 'CD', status: 'active', startDate: '2026-08-03', edgeMm: 15,
  weeklyStructure: cyc20.weeklyStructure, blocks: [Templates.deload('Deload + Test', [3])] };
ok(App.getWeeks(cycDeload, wmFor)[0].edgeMm === 15, 'D8 deload/test weeks carry the cycle edge');
// today-only override re-anchors
const ovWeeks = App.getWeeks(cyc20, wmFor, 15);
ok(ovWeeks[0].edgeMm === 15 && ovWeeks[0].heavyAnchorKg === wk15.heavyAnchorKg,
   'D9 edge override re-derives the anchor from that edge\'s WM');
ok(App.getWeeks(cyc20, wmFor, null)[0].heavyAnchorKg === wk20.heavyAnchorKg,
   'D10 no override leaves the cycle edge alone');
// pickups own their edge and must be untouched by the override
const cycPick = Templates.templateP();
const pickWeekBefore = App.getWeeks(cycPick, wmFor)[0];
const pickWeekOv = App.getWeeks(cycPick, wmFor, 15)[0];
ok(pickWeekBefore.edgeMm === 20 && pickWeekOv.edgeMm === 20, 'D11 hang edge override never touches pickup weeks');
// plan carries the edge through to the runner
const planWeeks = App.getWeeks(cyc15, wmFor);
const plan15 = App.buildPlan(cyc15, planWeeks, '2026-08-06', wmFor);   // a Thursday = Heavy
ok(plan15.role === 'Heavy' && plan15.edgeMm === 15, 'D12 buildPlan puts the edge on the plan');

// ------------------------------------------------------------ E. guardrails
const gr15 = Calc.guardrails(cyc15, keys.filter(k => k.edgeMm === 20));
ok(gr15.some(x => x.id === 'missingWM' && /15mm/.test(x.message)),
   'E1 a 15mm block with only 20mm maxes on file warns, naming the edge');
const gr20 = Calc.guardrails(cyc20, keys);
ok(!gr20.some(x => x.id === 'missingWM'), 'E2 a 20mm block with a 20mm max does not warn');
const grLegacy = Calc.guardrails(cyc20, [3]);
ok(!grLegacy.some(x => x.id === 'missingWM'),
   'E3 legacy numeric input still matches on duration alone (no false alarm)');

// ------------------------------------------------ F. PR / benchmark scoping
// 15mm best is 24, 20mm best is 32.
const prCase = async (load, edge, label) => {
  confirms.length = 0;
  const e = { id: Templates.uid(), date: '2026-08-15', type: 'Yielding', role: 'Heavy', venue: 'Board',
    hangDurationSeconds: 3, grip: 'HalfCrimp', edgeMm: edge, topSetLoadKg: load, topSetRPE: 9, sets: 4, notes: label };
  await DB.addLog(e);
  await App.maybeAutoBenchmarkPR(e);
  const fired = confirms.length > 0;
  await DB.softDelete('logEntries', e.id);
  return fired;
};
ok(await prCase(25, 15, 'pr15') === true,
   'F1 25kg at 15mm IS a PR (beats the 15mm best of 24) even though it is far under the 20mm best');
ok(await prCase(25, 20, 'no-pr20') === false,
   'F2 25kg at 20mm is NOT a PR — it must not be scored against the lighter 15mm series');
ok(await prCase(33, 20, 'pr20') === true, 'F3 33kg at 20mm is still a PR on its own series');
ok(await prCase(5, 8, 'first-8mm') === false, 'F4 the first session on a brand-new edge is not a PR');
// and the records a PR writes must carry the edge
confirms.length = 0;
const prEntry = { id: Templates.uid(), date: '2026-08-15', type: 'Yielding', role: 'Heavy', venue: 'Board',
  hangDurationSeconds: 3, grip: 'HalfCrimp', edgeMm: 15, topSetLoadKg: 26, topSetRPE: 9, sets: 4, notes: 'prwrite' };
await DB.addLog(prEntry);
await App.maybeAutoBenchmarkPR(prEntry);
const newBench = (await DB.getAll('benchmarks')).find(b => b.maxLoadKg === 26);
ok(newBench && newBench.edgeMm === 15, 'F5 the auto benchmark records which edge the PR was set on');
ok(confirms.length === 1 && /15mm/.test(confirms[0].msg), 'F6 the PR prompt names the edge');
await confirms[0].onOk();          // accept the Working Max update
const wmAfter15 = await DB.currentWM(3, 15), wmAfter20 = await DB.currentWM(3, 20);
ok(wmAfter15 && wmAfter15.valueKg === 26, 'F7 accepting the prompt raises the 15mm Working Max');
ok(wmAfter20 && wmAfter20.valueKg === 32, 'F8 ...and leaves the 20mm Working Max untouched');
await DB.softDelete('logEntries', prEntry.id);
await DB.softDelete('benchmarks', newBench.id);
await DB.save('workingMaxes', { id: 'wm15', durationSeconds: 3, edgeMm: 15, valueKg: 24, date: '2026-08-05', source: 'test' });
const wmRestore = (await DB.getAll('workingMaxes')).filter(x => x.valueKg === 26 && x.id !== 'wm15');
for (const x of wmRestore) await DB.del('workingMaxes', x.id);

// --------------------------------------------------------- G. analytics
const view = () => w.document.getElementById('view');
const txt = () => view().textContent || '';
App.state.analyticsEdgeMm = null;
App.state.tab = 'analytics'; await App.render(); await tick(160);
let a = txt();
ok(/15mm/.test(a), 'G1 analytics defaults to the most recently trained edge (15mm)');
ok(/3s E1RM · raw · 15mm/.test(a), 'G2 the raw plot heading names the edge');
ok(/E1RM projection · 3s · 15mm/.test(a), 'G3 the projection heading names the edge');
ok(/Filtered strength · 3s · 15mm/.test(a), 'G4 the filter heading names the edge');
const segTexts = () => [...view().querySelectorAll('.seg button')].map(b => b.textContent);
ok(segTexts().includes('15mm') && segTexts().includes('20mm'), 'G5 an edge toggle appears when two edges have data');
ok(/4 sessions/.test(a), 'G6 the 15mm view counts only the four 15mm sessions (got: ' +
   (a.match(/\d+ sessions/) || ['none'])[0] + ')');
// The load numbers on screen must belong to the selected edge. Read the exact
// stat-strip cell rather than substring-matching the page: a bare "25" turns up
// all over a rendered chart and would make this assertion pass for free.
const raw3Stat = () => {
  const col = [...view().querySelectorAll('.ss-col')]
    .find(c => /3s raw E1RM/.test((c.querySelector('.ss-label') || {}).textContent || ''));
  return col ? (col.querySelector('.ss-value').textContent || '').trim() : null;
};
const e15 = Calc.e1rm(23.5, 9, 5);   // last 15mm session, raw-3s convention
const e20 = Calc.e1rm(31.5, 9, 5);   // last 20mm session
ok(e15 !== e20, 'G7 the two edges give genuinely different readouts (' + e15 + ' vs ' + e20 + ')');
ok(raw3Stat() === e15 + ' kg', 'G8 the 15mm readout is the last 15mm session (got ' + raw3Stat() + ', want ' + e15 + ' kg)');
// switch to 20mm
const btn20 = [...view().querySelectorAll('.seg button')].find(b => b.textContent === '20mm');
btn20.click(); await tick(180);
a = txt();
ok(App.state.analyticsEdgeMm === 20, 'G9 the toggle switches the selected edge');
ok(/3s E1RM · raw · 20mm/.test(a), 'G10 headings follow the toggle');
ok(raw3Stat() === e20 + ' kg', 'G11 the 20mm readout is the last 20mm session (got ' + raw3Stat() + ', want ' + e20 + ' kg)');
ok(raw3Stat() !== e15 + ' kg', 'G12 the 15mm value is not what the 20mm view reports');
ok(/4 sessions/.test(a), 'G13 the 20mm view counts only its own four sessions');
// single-edge state (what a user who never changed edge sees) must be unchanged
const fifteens = (await DB.getAll('logEntries')).filter(l => l.edgeMm === 15);
for (const l of fifteens) await DB.softDelete('logEntries', l.id);
App.state.analyticsEdgeMm = null;
await App.render(); await tick(160);
ok(!segTexts().includes('15mm') && !segTexts().includes('20mm'),
   'G14 no edge toggle when only one edge has data (got: ' + segTexts().join(',') + ')');
ok(/Cycle/.test(txt()) && /All/.test(txt()), 'G15 the range toggle is still there');

// ------------------------------------------------ H. editors + log writing
// New manual entry defaults to the most recently trained edge, not a constant.
await mk('2026-08-13', 3, 23.5, 9, 15);      // 15mm is "current" again
await tick(60);
App.openManualLog(); await tick(120);
let sheet = [...w.document.querySelectorAll('#modal-host .sheet')].pop();
const fieldIn = (sh, re) => [...sh.querySelectorAll('.field')]
  .find(f => { const l = f.querySelector('label'); return l && re.test(l.textContent); });
const edgeStep = sh => fieldIn(sh, /Edge depth/).querySelector('.stepper');
ok(!!fieldIn(sheet, /Edge depth/), 'H1 the hang editor has an edge field');
ok(edgeStep(sheet).getValue() === 15, 'H2 a new entry defaults to the edge trained most recently (got ' +
   edgeStep(sheet).getValue() + ')');
// save one through the form and check it persists
edgeStep(sheet).setValue(15);
fieldIn(sheet, /Top set load/).querySelector('.stepper').setValue(24.5);
fieldIn(sheet, /Top set RPE/).querySelector('.stepper').setValue(9);
[...sheet.querySelectorAll('button')].find(b => /Save session/.test(b.textContent)).click();
await tick(180);
const saved = (await DB.logsNewestFirst()).find(l => l.topSetLoadKg === 24.5);
ok(saved && saved.edgeMm === 15, 'H3 the editor persists the edge');
App.closeSheet(); await tick(300);
// editing an existing 20mm record shows 20mm, and does not restamp it
const rec20 = (await DB.logsNewestFirst()).find(l => l.topSetLoadKg === 31.5);
App.openManualLog(rec20); await tick(120);
sheet = [...w.document.querySelectorAll('#modal-host .sheet')].pop();
ok(edgeStep(sheet).getValue() === 20, 'H4 editing a 20mm record shows 20mm');
App.closeSheet(); await tick(300);
// a legacy record with no edgeMm field at all opens as 20mm
const recLegacy = (await DB.logsNewestFirst()).find(l => l.date === '2026-06-02');
ok(recLegacy && recLegacy.edgeMm === undefined, 'H5 the legacy fixture row really has no edgeMm stored');
App.openManualLog(recLegacy); await tick(120);
sheet = [...w.document.querySelectorAll('#modal-host .sheet')].pop();
ok(edgeStep(sheet).getValue() === 20, 'H6 a record with no edgeMm opens as 20mm (read-time default, no migration)');
App.closeSheet(); await tick(300);
// runner -> log entry
const logged = await new Promise(async (res) => {
  const before = (await DB.getAll('logEntries')).length;
  await App.logSession({ role: 'Heavy', duration: 3, blockName: 'B', edgeMm: 15 },
    { load: 25, rpe: 9, sets: 4, taxing: 3, felt: 7, notes: '', setsDetail: [{ load: 25, rpe: 9 }] });
  const all = await DB.getAll('logEntries');
  res(all.length > before ? all.find(l => l.topSetLoadKg === 25 && l.notes === '') : null);
});
ok(logged && logged.edgeMm === 15, 'H7 a session logged from the runner carries the plan edge');
confirms.length = 0;

// runner prep screen must state the edge
await Runner.start({ role: 'Heavy', duration: 3, blockName: 'B', edgeMm: 15, protocol: 'topSetPlusBackoffs',
                     rpe: 9, sets: 4, anchor: 20 });
await tick(120);
const skip = [...w.document.querySelectorAll('#modal-host button')].find(b => /Skip check/.test(b.textContent));
ok(!!skip, 'H8 runner started (readiness screen present)');
if (skip) { skip.click(); await tick(120); }
ok(/15mm/.test(w.document.getElementById('modal-host').textContent), 'H9 the runner prep screen states the edge');
Runner.abort(); confirms.length = 0;
w.document.getElementById('modal-host').innerHTML = '';

// --------------------------------------------------------------- I. CSV
const rows = [];
w.Blob = class { constructor(parts) { rows.push(String(parts[0])); } };
w.URL.createObjectURL = () => 'blob:x';
await App.exportCSV();
const csv = rows[0] || '';
ok(/,edgeMm/.test(csv.split('\n')[0]), 'I1 CSV export has an edgeMm column');
const dataLines = csv.split('\n').slice(1).filter(Boolean);
ok(dataLines.every(l => /,\d+(\.\d+)?$/.test(l)), 'I2 every exported row carries an edge value');
ok(dataLines.some(l => /,15$/.test(l)) && dataLines.some(l => /,20$/.test(l)),
   'I3 both edges round-trip through export');

// ------------------------------------------ L. the today-only edge override
{
  App.state.sessionEdgeMm = null; App.state.sessionEdgeDate = null;
  ok(App.sessionEdgeToday() === null, 'L1 no override by default');
  // set for today
  App.state.sessionEdgeMm = 15; App.state.sessionEdgeDate = new Date().toISOString().slice(0, 10);
  // todayISO() is local; recompute the same way the app does rather than UTC
  const localToday = (() => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); })();
  App.state.sessionEdgeDate = localToday;
  ok(App.sessionEdgeToday() === 15, 'L2 an override set today applies');
  // an override left over from a previous day must expire, not mislabel today
  App.state.sessionEdgeDate = '2026-01-01';
  ok(App.sessionEdgeToday() === null, 'L3 a stale override from another day expires');
  ok(App.state.sessionEdgeMm === null, 'L4 ...and clears itself rather than lingering');
}

// ------------------------------------- K. RPE calibration must not cross edges
// fitRpeCurve derives the personal RPE spacing from the LOAD RATIO between
// sessions <=14 days apart. Feeding it a 15mm and a 20mm session from the same
// week charges a ~25% load gap to the RPE difference; the fitted k then
// distorts every displayed E1RM. Sessions from ONE edge alone must never
// produce a different fit than the same sessions with the other edge present.
{
  const fit = w.fitRpeCurve;
  const mkPts = (edge, base) => {
    const out = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date(Date.UTC(2026, 0, 5 + i * 3)).toISOString().slice(0, 10);
      const rpe = [8, 9, 9.5, 8.5, 10, 8, 9, 9.5, 8.5, 9][i];
      out.push({ date: d, load: Math.round(base * (1 - 0.05 * (10 - rpe)) * 2) / 2, rpe, dur: 3, edgeMm: edge });
    }
    return out;
  };
  const pure20 = mkPts(20, 32);
  // The same 20mm sessions with 15mm sessions interleaved between them.
  const mixed = pure20.concat(mkPts(15, 24)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const kPure = fit(pure20).k;
  const kMixed = fit(mixed).k;
  const kFiltered = fit(mixed.filter(p => p.edgeMm === 20)).k;
  ok(kFiltered === kPure, 'K1 filtering the mixed pool back to one edge reproduces the single-edge fit');
  ok(kMixed !== kPure, 'K2 a naively mixed pool DOES fit a different k — the hazard is real, not theoretical');
  // and the app must be doing the filtering: the analytics note reports the fit
  App.state.analyticsEdgeMm = null;
  App.state.tab = 'analytics'; await App.render(); await tick(160);
  ok(/RPE curve:/.test(txt()), 'K3 analytics still reports which RPE curve it used');
}

// ------------------------------------------------------------ J. settings
// The Working Max editors must state (and let you choose) which edge they
// write to — editing the 20mm max while training 15mm would corrupt the
// anchor for both.
App.state.settingsEdgeMm = null;
App.state.tab = 'settings'; await App.render(); await tick(160);
const sTxt = txt();
ok(/Working Max edge/.test(sTxt), 'J1 settings offers an edge choice for Working Maxes');
ok(/5s Working Max · 15mm/.test(sTxt) && /3s Working Max · 15mm/.test(sTxt),
   'J2 the editors default to the most recently trained edge');
ok(/3s · 15mm ·/.test(sTxt) && /3s · 20mm ·/.test(sTxt), 'J3 WM history distinguishes the edges');
// save a 15mm 5s max and check where it landed
const before5_20 = await DB.currentWM(5, 20);
const wmCard = [...view().querySelectorAll('.card')]
  .find(c => /5s Working Max · 15mm/.test((c.querySelector('h2') || {}).textContent || ''));
ok(!!wmCard, 'J4 the 15mm 5s editor card is on screen');
wmCard.querySelector('.stepper').setValue(19);
[...wmCard.querySelectorAll('button')].find(b => /Save WM/.test(b.textContent)).click();
await tick(160);
const after5_15 = await DB.currentWM(5, 15), after5_20 = await DB.currentWM(5, 20);
ok(after5_15 && after5_15.valueKg === 19, 'J5 saving writes the 15mm 5s Working Max');
ok((after5_20 && after5_20.valueKg) === (before5_20 && before5_20.valueKg),
   'J6 ...and does not disturb the 20mm one');

ok(uncaught.length === 0, 'Z1 no uncaught errors: ' + uncaught.join(' | '));
ok(errs.filter(e => !/Not implemented/.test(e)).length === 0, 'Z2 no console.error: ' + errs.slice(0, 3).join(' | '));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });

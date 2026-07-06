/* qa/fuzz_gen.js — seeded generator of pathological backup payloads.
 * Node-only test infra; never shipped to the client. */
'use strict';
const { makeAthlete, mulberry32 } = require('./athlete_gen.js');

const JUNK_DATES = ['2026-13-45', '', null, undefined, 'Jul 4', '04-07-2026', '2026-7-4',
  '2099-01-01', '1970-01-01', 1751659200000, 'NaN', '2026-02-30', '2026-06-31T12:00:00Z'];
const JUNK_NUMS = [null, undefined, NaN, Infinity, -Infinity, -30, 0, 1e9, '30', '30kg', '', {}, [], true];
const JUNK_STR = [null, undefined, 42, '', '<script>alert(1)</script>', 'x'.repeat(50000), {}, ['a']];

function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }

/* mutation catalog: each takes (data, rnd) and mangles in place */
const MUTATIONS = {
  numericJunk(d, rnd) {
    const logs = d.logEntries || [];
    for (let k = 0; k < 1 + rnd() * 6; k++) {
      const e = pick(rnd, logs); if (!e) return;
      const f = pick(rnd, ['topSetLoadKg', 'topSetRPE', 'e1rmKg', 'sets', 'bodyweightKg',
                           'hangDurationSeconds', 'taxing', 'feltStrong', 'nextDayFeel']);
      e[f] = pick(rnd, JUNK_NUMS);
    }
  },
  dateJunk(d, rnd) {
    const stores = [d.logEntries, d.cycles, d.benchmarks, d.workingMaxes].filter(Boolean);
    for (let k = 0; k < 1 + rnd() * 5; k++) {
      const s = pick(rnd, stores); const e = pick(rnd, s); if (!e) continue;
      const f = e.startDate !== undefined ? 'startDate' : 'date';
      e[f] = pick(rnd, JUNK_DATES);
    }
  },
  sameDayFlood(d, rnd) {
    const logs = d.logEntries || []; const base = logs[0]; if (!base) return;
    const n = 5 + Math.floor(rnd() * 60);
    for (let i = 0; i < n; i++) logs.push(Object.assign({}, base, { id: 'flood_' + i, topSetLoadKg: 20 + rnd() * 20 }));
  },
  idCollisions(d, rnd) {
    const logs = d.logEntries || [];
    for (let k = 0; k < 3; k++) { const a = pick(rnd, logs), b = pick(rnd, logs); if (a && b) b.id = a.id; }
    if (logs[0]) delete logs[0].id;
  },
  tombstoneConflicts(d, rnd) {
    d.tombstones = d.tombstones || [];
    (d.logEntries || []).slice(0, 4).forEach((e, i) => {
      d.tombstones.push({ id: e.id, store: 'logEntries',
        deletedAt: i % 2 ? '2099-01-01T00:00:00Z' : '2000-01-01T00:00:00Z' });
    });
    d.tombstones.push({ id: 'ghost_1', store: 'logEntries', deletedAt: new Date().toISOString() });
    d.tombstones.push({ id: null, store: pick(rnd, ['logEntries', 'nosuchstore', null]), deletedAt: pick(rnd, JUNK_DATES) });
  },
  cycleMangle(d, rnd) {
    const c = (d.cycles || [])[0]; if (!c) return;
    const hit = pick(rnd, ['noBlocks', 'emptyBlocks', 'noHeavy', 'zeroWeeks', 'negWeeks', 'fracWeeks',
      'hundredWeeks', 'noStruct', 'junkStruct', 'noStart', 'allActive', 'statusJunk', 'testNoDurations']);
    if (hit === 'noBlocks') delete c.blocks;
    if (hit === 'emptyBlocks') c.blocks = [];
    if (hit === 'noHeavy') c.blocks.forEach(b => delete b.heavy);
    if (hit === 'zeroWeeks') c.blocks.forEach(b => { b.durationWeeks = 0; });
    if (hit === 'negWeeks') c.blocks.forEach(b => { b.durationWeeks = -3; });
    if (hit === 'fracWeeks') c.blocks.forEach(b => { b.durationWeeks = 1.5; });
    if (hit === 'hundredWeeks') c.blocks.forEach(b => { b.durationWeeks = 400; });
    if (hit === 'noStruct') delete c.weeklyStructure;
    if (hit === 'junkStruct') c.weeklyStructure = pick(rnd, [{}, { mon: 'Party', xyz: 'Heavy' }, 'HeavyEveryday', 7, null]);
    if (hit === 'noStart') delete c.startDate;
    if (hit === 'allActive') { d.cycles.forEach(x => { x.status = 'active'; }); d.cycles.push(JSON.parse(JSON.stringify(c)), JSON.parse(JSON.stringify(c))); d.cycles.forEach((x, i) => { x.id = 'cyc_dup' + i; }); }
    if (hit === 'statusJunk') c.status = pick(rnd, [null, 42, 'ACTIVE', '', {}]);
    if (hit === 'testNoDurations') c.blocks.push({ name: 'T', type: 'DeloadTest', isDeloadTest: true, durationWeeks: 1, testConfig: pick(rnd, [null, {}, { testDurations: [] }, { testDurations: null }]) });
  },
  wmMangle(d, rnd) {
    d.workingMaxes = d.workingMaxes || [];
    d.workingMaxes.push({ id: 'wm_j1', durationSeconds: pick(rnd, [0, 7, '5', null, -3]), valueKg: pick(rnd, JUNK_NUMS), date: pick(rnd, JUNK_DATES) });
    const w = d.workingMaxes[0]; if (w) w.valueKg = pick(rnd, JUNK_NUMS);
  },
  benchMangle(d, rnd) {
    d.benchmarks = d.benchmarks || [];
    d.benchmarks.push({ id: 'bm_j1', date: pick(rnd, JUNK_DATES), durationSeconds: pick(rnd, [0, 4, 7, null]), maxLoadKg: pick(rnd, JUNK_NUMS), rpe: pick(rnd, [0, 11, null, '9ish']) });
  },
  metaMangle(d, rnd) {
    d.meta = d.meta || [];
    d.meta.push({ key: 'pendingNextDayFeel', value: pick(rnd, [{ logEntryId: 'nope', sessionDate: pick(rnd, JUNK_DATES) }, 'garbage', 42, null]) });
    d.meta.push({ key: pick(rnd, [null, '', 'restBackoff']), value: pick(rnd, [-5, 'ten', {}, 1e9]) });
  },
  stringJunk(d, rnd) {
    (d.logEntries || []).slice(0, 3).forEach(e => {
      e.notes = pick(rnd, JUNK_STR); e.grip = pick(rnd, JUNK_STR); e.type = pick(rnd, ['Yielding', 'OI', 'Party', null, 42, '']);
      e.role = pick(rnd, ['Heavy', 'Volume', 'Boss', null, {}]);
    });
  },
  storeTypeErrors(d, rnd) {
    const f = pick(rnd, ['logEntries', 'benchmarks', 'tombstones', 'meta']);
    d[f] = pick(rnd, [{}, 'nope', 42, null, [null, undefined, 'str', 12, {}]]);
  },
  missingE1rm(d) { (d.logEntries || []).forEach(e => { delete e.e1rmKg; }); },
};

const MUT_KEYS = Object.keys(MUTATIONS);

function makeScenario(seed) {
  const rnd = mulberry32(seed);
  const kind = seed % 10;
  let base;
  if (kind === 0) base = { data: { logEntries: [], cycles: [], workingMaxes: [], benchmarks: [], tombstones: [], meta: [] } };
  else if (kind === 1) { const a = makeAthlete(seed, { weeks: 2 }); a.data.logEntries = a.data.logEntries.slice(0, 2); base = a; }
  else if (kind === 2) base = makeAthlete(seed, { weeks: 60 });        // big history
  else base = makeAthlete(seed, {});
  const data = JSON.parse(JSON.stringify(base.data, (k, v) => v === undefined ? null : v));
  const muts = [];
  if (kind !== 3) {                                    // kind 3 stays CLEAN (control group)
    const n = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const m = MUT_KEYS[Math.floor(rnd() * MUT_KEYS.length)];
      try { MUTATIONS[m](data, rnd); muts.push(m); } catch (e) { /* mutation itself may hit junk; fine */ }
    }
  }
  return { seed, kind: kind === 3 ? 'clean' : (kind === 0 ? 'empty' : kind === 1 ? 'tiny' : kind === 2 ? 'huge' : 'mutated'), muts, data };
}

module.exports = { makeScenario };

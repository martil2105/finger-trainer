/* qa/athlete_gen.js — synthetic athlete generator (Node-only test infra).
 * Produces coherent backup payloads (logEntries, cycles, workingMaxes,
 * benchmarks) from a latent-strength physiology model, PLUS the hidden
 * truth series so backtests can score predictions against reality.
 * Never shipped to the client; not referenced by index.html/sw.js. */
'use strict';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
const DAY = 86400000;

/* Latent 5s-max trajectory: saturating gains + slow detraining on gaps +
 * day-to-day readiness noise applied at OBSERVATION time (not to the latent). */
function makeAthlete(seed, opts) {
  const rnd = mulberry32(seed);
  const o = opts || {};
  const norm = () => { // Box-Muller
    const u = Math.max(rnd(), 1e-9), v = Math.max(rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const L0 = o.L0 != null ? o.L0 : 18 + rnd() * 22;            // start 5s max (kg added)
  const ceiling = L0 + 4 + rnd() * 16;                          // personal plateau
  const tau = 40 + rnd() * 140;                                 // days to ~63% of gap
  const detrain = 0.001 + rnd() * 0.004;                        // per idle day fraction lost
  const noiseSd = 0.8 + rnd() * 1.6;                            // session expression noise (kg)
  const badDayP = 0.06 + rnd() * 0.12;                          // occasional -2..-5kg day
  const rpeSd = 0.35 + rnd() * 0.4;                             // RPE reporting noise
  const rpeBias = (rnd() - 0.5) * 0.8;                          // systematic over/under-rating
  const kTrue = o.kTrue != null ? o.kTrue : 0.035 + rnd() * 0.05;         // personal RPE spacing (generic table assumes 0.06)
  const dur3After = rnd() < 0.5 ? Math.floor(30 + rnd() * 40) : Infinity; // switch to 3s hangs
  const factor3 = 1.06 + rnd() * 0.08;                          // true 3s premium
  const weeks = o.weeks != null ? o.weeks : 8 + Math.floor(rnd() * 10);
  const startMs = Date.parse(o.startDate || '2026-01-05');
  const adherence = 0.7 + rnd() * 0.3;

  // training days: Tue/Thu/Sat-ish
  const days = [];
  for (let w = 0; w < weeks; w++) {
    [2, 4, 6].forEach(dw => { if (rnd() < adherence) days.push(w * 7 + dw); });
  }
  days.sort((a, b) => a - b);

  // walk the latent level day by day
  const truth = [];   // {day, iso, latent5}
  let L = L0, lastTrain = 0;
  const trainSet = new Set(days);
  for (let d = 0; d <= weeks * 7; d++) {
    if (trainSet.has(d)) {
      const gain = (ceiling - L) / tau * (2.2 + norm() * 0.3); // per-session bump
      L += Math.max(0, gain);
      lastTrain = d;
    } else if (d - lastTrain > 5) {
      L -= L * detrain;                                        // slow decay when idle
    }
    truth.push({ day: d, iso: iso(startMs + d * DAY), latent5: L });
  }

  // observed sessions -> logEntries (top set backed out through the generic RPE model,
  // because that's what a real athlete's log records: load they chose + RPE they felt)
  const logEntries = [];
  days.forEach((d, i) => {
    const is3 = d >= dur3After;
    const latent = truth[d].latent5 * (is3 ? factor3 : 1);
    const bad = rnd() < badDayP ? (2 + rnd() * 3) : 0;
    const expressed = latent - bad + norm() * noiseSd;          // what they could do today
    const targetRPE = [8, 9, 9, 9.5, 10][Math.floor(rnd() * 5)];
    // athlete picks a load near expressed max scaled to target effort
    // (TRUE curve uses the athlete's own kTrue, usually NOT the app's 0.06)
    const truePct = (r) => 1 - kTrue * (10 - r);
    const load = Math.round(expressed * truePct(targetRPE) * 2) / 2;
    let rpe = Math.round((targetRPE + rpeBias + norm() * rpeSd) * 2) / 2;
    rpe = Math.max(5, Math.min(10, rpe));
    const dur = is3 ? 3 : 5;
    const raw = load * 100 / (40 + 6 * rpe);
    logEntries.push({
      id: 'id_syn' + seed + '_' + i,
      date: truth[d].iso, type: 'Yielding', role: rnd() < 0.25 ? 'Volume' : 'Heavy',
      venue: 'Board', hangDurationSeconds: dur, grip: 'HalfCrimp',
      topSetLoadKg: load, topSetRPE: rpe, sets: 3 + Math.floor(rnd() * 3),
      bodyweightKg: 62 + Math.round(rnd() * 20),
      taxing: 2 + Math.floor(rnd() * 3), feltStrong: 4 + Math.floor(rnd() * 5),
      nextDayFeel: rnd() < 0.7 ? 2 + Math.floor(rnd() * 3) : null,
      block: 'Synth', notes: '',
      e1rmKg: Math.round((dur === 3 ? raw / 1.1 : raw) * 10) / 10,
      updatedAt: new Date(startMs + d * DAY + 72e6).toISOString()
    });
  });

  const cycle = {
    id: 'cyc_syn' + seed, name: 'Synth Cycle ' + seed, status: 'active',
    startDate: iso(startMs),
    weeklyStructure: { mon: 'Rest', tue: 'Heavy', wed: 'Rest', thu: 'Volume', fri: 'Rest', sat: 'Heavy', sun: 'Rest' },
    blocks: [{ name: 'Synth Block', type: 'Accumulation', durationWeeks: Math.max(1, weeks),
      heavy: { hangDurationSeconds: 5, protocol: 'topSetPlusBackoffs', rpeStart: 8, rpeEnd: 9.5,
               setsStart: 3, setsEnd: 4, backoffPctOfTop: 0.85 },
      volume: { hangDurationSeconds: 5, pctStart: 0.75, pctEnd: 0.85, sets: 4 },
      oi: { sets: 3 } }],
    updatedAt: new Date(startMs).toISOString()
  };
  const workingMaxes = [{ id: 'wm_syn' + seed + '_5', durationSeconds: 5,
    valueKg: Math.round(L0 * 2) / 2, date: iso(startMs), updatedAt: new Date(startMs).toISOString() }];
  const benchmarks = [{ id: 'bm_syn' + seed, date: iso(startMs), durationSeconds: 5,
    maxLoadKg: Math.round(L0 * 2) / 2, rpe: 9.5, source: 'test', updatedAt: new Date(startMs).toISOString() }];

  return {
    seed, truth, params: { L0, ceiling, tau, detrain, noiseSd, badDayP, rpeSd, rpeBias, factor3, dur3After, kTrue },
    data: { logEntries, cycles: [cycle], workingMaxes, benchmarks, tombstones: [], meta: [] }
  };
}

module.exports = { makeAthlete, mulberry32 };

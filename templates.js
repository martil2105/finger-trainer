/* templates.js — seed cycle templates (§12) + seeded log history.
 * Exposes window.Templates with builder functions returning fresh objects. */
(function (root) {
  'use strict';

  function uid() { return 'id_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

  // ---- Template A: current cycle "Trans I–II + Peak (5s→3s)" (§7) -------
  function templateA() {
    return {
      id: uid(),
      name: 'Trans I–II + Peak (5s→3s)',
      status: 'active',
      startDate: '2026-05-11',
      weeklyStructure: { mon: 'Rest', tue: 'OIprimer', wed: 'Rest', thu: 'Volume', fri: 'Rest', sat: 'Heavy', sun: 'Rest' },
      notes: 'Skips accumulation — straight into Transmutation given established base.',
      blocks: [
        block('Transmutation I', 'Transmutation', 4, 5, 'topSetPlusBackoffs', 8.5, 9.0, 3, 3, 0.92, 5, 0.82, 0.85, 5, '3-5', 0.95),
        deload('Deload + Test', [5]),
        block('Transmutation II', 'Transmutation', 4, 5, 'topSetPlusBackoffs', 9.0, 9.5, 3, 2, 0.82, 5, 0.86, 0.88, 5, '3-5'),
        deload('Deload + Test', [5, 3]),
        block('Peak Intensity', 'Peak', 4, 3, 'maxSingles', 9.5, 9.5, 3, 5, null, 5, 0.80, 0.82, 4, '3-5'),
        deload('Deload + Final Test', [5, 3]),
        block('Realization', 'Realization', 1, 3, 'maxSingles', 9.0, 9.0, 2, 3, null, 5, 0.78, 0.80, 2, '3-5')
      ]
    };
  }

  // ---- Template B: descending duration "Acc → Trans → Peak (7s→5s→3s)" (§12B)
  function templateB() {
    return {
      id: uid(),
      name: 'Acc → Trans → Peak (7s→5s→3s)',
      status: 'draft',
      startDate: '2026-05-11',
      weeklyStructure: { mon: 'Rest', tue: 'OIprimer', wed: 'Rest', thu: 'Volume', fri: 'Rest', sat: 'Heavy', sun: 'Rest' },
      notes: 'Properly periodized: duration is the lever, volume and intensity see-saw.',
      blocks: [
        block('Accumulation', 'Accumulation', 8, 7, 'topSetPlusBackoffs', 7.0, 8.0, 4, 4, 0.82, 7, 0.85, 0.80, 6, '3-5'),
        deload('Deload + Test', [7, 5]),
        block('Transmutation', 'Transmutation', 5, 5, 'topSetPlusBackoffs', 8.5, 9.5, 3, 2, 0.82, 5, 0.82, 0.88, 5, '3-5'),
        deload('Deload + Test', [5, 3]),
        block('Peak', 'Peak', 3, 3, 'maxSingles', 9.5, 9.5, 3, 5, null, 5, 0.80, 0.78, 3, '3-5'),
        block('Realization', 'Realization', 1, 3, 'maxSingles', 9.0, 9.0, 2, 3, null, 5, 0.78, 0.78, 2, '3-5')
      ]
    };
  }

  // ---- Template C: blank — one Custom block at defaults (§12C) ----------
  function templateC() {
    return {
      id: uid(),
      name: 'New cycle',
      status: 'draft',
      startDate: new Date().toISOString().slice(0, 10),
      weeklyStructure: { mon: 'Rest', tue: 'OIprimer', wed: 'Rest', thu: 'Volume', fri: 'Rest', sat: 'Heavy', sun: 'Rest' },
      notes: '',
      blocks: [
        block('Custom block', 'Custom', 4, 5, 'topSetPlusBackoffs', 8.0, 8.0, 3, 3, 0.82, 5, 0.82, 0.85, 4, '3-5')
      ]
    };
  }

  // boPctE (optional 16th param): if set, back-off % lerps from boPct→boPctE over the block.
  // Omit or pass undefined to use a flat boPct throughout.
  function block(name, type, weeks, hDur, protocol, rpeS, rpeE, setsS, setsE, boPct, vDur, pctS, pctE, vSets, oiSets, boPctE) {
    return {
      id: uid(), name, type, durationWeeks: weeks, isDeloadTest: false,
      heavy: { hangDurationSeconds: hDur, protocol, rpeStart: rpeS, rpeEnd: rpeE,
               setsStart: setsS, setsEnd: setsE, backoffPctOfTop: boPct,
               backoffPctOfTopEnd: boPctE != null ? boPctE : boPct },
      volume: { hangDurationSeconds: vDur, pctStart: pctS, pctEnd: pctE, sets: vSets, fixedNoExtensions: true },
      oi: { sets: oiSets },
      testConfig: null
    };
  }

  function deload(name, testDurations) {
    return {
      id: uid(), name, type: 'DeloadTest', durationWeeks: 1, isDeloadTest: true,
      heavy: null, volume: null, oi: { sets: 0 },
      testConfig: { deloadPctOfWM: 0.75, testDurations: testDurations.slice() }
    };
  }

  // ---- Seeded log history (imported from finger_training_tracker_v9.xlsx)
  // Roles null in the sheet are mapped to a best-fit role for filtering.
  const SEED_LOG = [
    row('2026-04-14', 'Yielding', 'Board', 'Heavy', 20, null, null, 3, 5, 3, 'Accumulation', 'Felt easy at +25kg, 1-2s left in tank'),
    row('2026-04-21', 'Climbing', 'Outdoor', 'Climb', null, null, null, 2, 5, 2, 'Accumulation', 'Outdoor easy'),
    row('2026-04-22', 'Yielding', 'Board', 'Heavy', 25, null, null, 2, 5, 3, 'Accumulation', 'Felt weaker, bit hurt finger'),
    row('2026-04-24', 'OI', 'Gym', 'OIprimer', null, null, null, 2, 5, 2, 'Accumulation', 'Project attempts, cold'),
    row('2026-04-28', 'OI', 'Gym', 'OIprimer', null, null, null, 1, 5, 2, 'Accumulation', 'Tired after work'),
    row('2026-04-30', 'OI', 'Gym', 'OIprimer', null, null, null, 3, 5, 3, 'Accumulation', 'Struggle to express power'),
    row('2026-05-01', 'Yielding', 'Board', 'Volume', 15, null, null, 4, 5, 2, 'Accumulation', 'Good session, good execution, sent project'),
    row('2026-05-04', 'Yielding', 'Board', 'Heavy', 20, null, null, 3, 8, 2, 'Accumulation', 'Low energy but felt strong'),
    row('2026-05-07', 'OI', 'Gym', 'OIprimer', null, null, null, 4, 8, 2, 'Accumulation', 'Felt good, sent alot, but felt dead fast. Low food'),
    row('2026-05-09', 'Climbing', 'Outdoor', 'Climb', null, null, null, 2, 7, 3, 'Accumulation', 'Fun session, might go hangboard tomorrow'),
    row('2026-05-10', 'OI', 'Other', 'OIprimer', null, null, null, 3, 6, 3, 'Accumulation', 'Did some hb, felt abit tired'),
    row('2026-05-12', 'Yielding', 'Board', 'Heavy', 25, 10, 3, 3, 6, 2, 'Trans I 1/4', 'Felt ok on hb, but tired spray sesh'),
    row('2026-05-14', 'Yielding', 'Gym', 'Volume', 20, 10, 3, 3, 3, 4, 'Trans I 1/4', 'Felt weak, tired, hb weak'),
    row('2026-05-16', 'OI', 'Gym', 'OIprimer', null, null, 0, 1, 2, 3, 'Trans I 1/4', 'Week sesh, hangout tired sore'),
    row('2026-05-19', 'Yielding', 'Other', 'Heavy', 25, 10, 3, 1, 4, 3, 'Trans I 1/4', 'Only hb, felt disconnected'),
    row('2026-05-24', 'OI', 'Gym', 'OIprimer', null, null, null, 4, 6, 3, 'Trans I 1/4', 'Felt ok after a long rest'),
    row('2026-05-26', 'Yielding', 'Board', 'Heavy', 25, 9, 3, 3, 8, 4, 'Trans I 1/4', 'Felt strong on hb, 25 felt controlled, spray was easy'),
    row('2026-05-28', 'OI', 'Gym', 'OIprimer', null, null, null, 4, 5, null, 'Trans I 1/4', 'Tired after work'),
    row('2026-05-31', 'Yielding', 'Other', 'Volume', null, null, null, 2, 7, null, 'Trans I 1/4', 'Good sesh ggs!')
  ];

  function row(date, type, venue, role, load, rpe, sets, taxing, felt, ndf, block, notes) {
    return {
      id: uid(), date, type, venue, role,
      hangDurationSeconds: (type === 'Yielding' ? 5 : null),
      grip: 'HalfCrimp',
      topSetLoadKg: load, topSetRPE: rpe, sets,
      bodyweightKg: null, taxing, feltStrong: felt, nextDayFeel: ndf,
      block, notes, e1rmKg: null // recomputed on seed insert
    };
  }

  root.Templates = { uid, templateA, templateB, templateC, block, deload, SEED_LOG };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Templates;
})(typeof self !== 'undefined' ? self : this);

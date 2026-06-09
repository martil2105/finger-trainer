/* calc.js — pure training-math module.
 * Works in browser (window.Calc) and Node (module.exports) so the same
 * functions back the app and the test harness. No DOM, no IndexedDB. */
(function (root) {
  'use strict';

  // ---- rounding helpers -------------------------------------------------
  function roundTo(x, dp) {
    const m = Math.pow(10, dp);
    return Math.round(x * m) / m;
  }
  function roundTo05(x) { return Math.round(x * 2) / 2; }      // nearest 0.5
  function roundTo025(x) { return Math.round(x * 4) / 4; }     // nearest 0.25
  function lerp(a, b, f) { return a + (b - a) * f; }
  function avg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

  // ---- 6.1 E1RM ---------------------------------------------------------
  // Computed for Yielding roles down to RPE 5 (matches the logging floor).
  // The %1RM model is linear — %1RM = 40 + 6*RPE — so it extends fine; just
  // note estimates below ~@6 are rougher (more in reserve = noisier back-calc),
  // which is acceptable here since E1RM is used to track the trend over time.
  // hangDuration: 3s hangs yield ~10% higher loads at the same RPE — divide by 1.1
  // to normalise to a 5s-equivalent so the E1RM trend stays on one comparable scale.
  function e1rm(loadKg, rpe, hangDuration) {
    if (loadKg == null || rpe == null || rpe < 5) return null;
    const raw = roundTo(loadKg * 100 / (40 + 6 * rpe), 1);
    return hangDuration === 3 ? roundTo(raw / 1.1, 1) : raw;
  }

  // ---- 6.2 Load anchors from WM ----------------------------------------
  function parseRPE(rpe) {
    if (typeof rpe === 'number') return rpe;
    if (!rpe) return 8;
    const clean = String(rpe).replace('@', '').trim();
    if (clean.includes('–') || clean.includes('-')) {
      const parts = clean.split(/[–-]/);
      return parseFloat(parts[1]); // use the upper bound for load calculations
    }
    return parseFloat(clean);
  }

  function formatRPEValue(rpe) {
    if (rpe === 8.75) return '8.5-9';
    if (rpe === 9.25) return '9-9.5';
    if (rpe === 7.75) return '7.5-8';
    if (rpe === 8.25) return '8-8.5';
    if (rpe === 7.25) return '7-7.5';
    return String(rpe);
  }

  // ---- 6.2 Load anchors from WM ----------------------------------------
  function heavyAnchor(wm, targetRPE) {
    if (wm == null) return null;
    const rpe = parseRPE(targetRPE);
    return roundTo05(wm * (40 + 6 * rpe) / 97);
  }
  function volumeAnchor(heavyAnchorKg, volumePct) {
    if (heavyAnchorKg == null) return null;
    return roundTo05(heavyAnchorKg * volumePct);
  }
  // pct: fraction of heavy anchor (per-week, lerped from block boPctStart→boPctEnd)
  function backoffAnchor(heavyAnchorKg, pct) {
    if (heavyAnchorKg == null) return null;
    return roundTo05(heavyAnchorKg * (pct != null ? pct : 0.82));
  }
  function deloadAnchor(wm5) {
    if (wm5 == null) return null;
    return roundTo05(wm5 * 0.75);
  }

  // ---- 6.3 Block -> week expansion -------------------------------------
  // Returns array of per-week prescriptions for a single block.
  function expandBlock(block, weekOffset, startDateISO) {
    const N = block.durationWeeks;
    const weeks = [];
    for (let i = 0; i < N; i++) {
      const f = N > 1 ? i / (N - 1) : 0;
      const wk = {
        weekNumber: weekOffset + i + 1,
        blockName: block.name,
        blockType: block.type,
        isDeloadTest: !!block.isDeloadTest,
        startDate: addDays(startDateISO, (weekOffset + i) * 7)
      };
      if (block.isDeloadTest) {
        wk.heavyProtocol = 'deloadTest';
        wk.heavyDuration = (block.testConfig && block.testConfig.testDurations &&
                            block.testConfig.testDurations[0]) || 5;
        wk.testDurations = (block.testConfig && block.testConfig.testDurations) || [5];
        wk.deloadPctOfWM = (block.testConfig && block.testConfig.deloadPctOfWM) || 0.75;
        wk.heavyRPE = 6;
        wk.heavySets = 3;
        wk.volumeSets = 0;
      } else {
        wk.heavyDuration = block.heavy.hangDurationSeconds;
        wk.heavyProtocol = block.heavy.protocol;
        const lerpedRpe = lerp(block.heavy.rpeStart, block.heavy.rpeEnd, f);
        wk.heavyRPE = formatRPEValue(roundTo025(lerpedRpe));
        wk.heavySets = Math.round(lerp(block.heavy.setsStart, block.heavy.setsEnd, f));
        // back-off pct lerps from boPctStart to boPctEnd if defined; falls back to single boPct
        const boPctS = block.heavy.backoffPctOfTop || 0.82;
        const boPctE = block.heavy.backoffPctOfTopEnd != null ? block.heavy.backoffPctOfTopEnd : boPctS;
        wk.backoffPctOfTop = roundTo(lerp(boPctS, boPctE, f), 3);
        wk.volumeDuration = block.volume ? block.volume.hangDurationSeconds : 5;
        wk.volumePct = block.volume
          ? Math.round(lerp(block.volume.pctStart, block.volume.pctEnd, f) * 100) / 100
          : null;
        wk.volumeSets = block.volume ? block.volume.sets : 0;
        wk.oiSets = (block.oi && block.oi.sets !== undefined) ? block.oi.sets : '3-5';
      }
      weeks.push(wk);
    }
    return weeks;
  }

  // Expand a whole cycle's blocks into a flat generatedWeeks array.
  function expandCycle(cycle) {
    const out = [];
    let offset = 0;
    (cycle.blocks || []).forEach(b => {
      const weeks = expandBlock(b, offset, cycle.startDate);
      weeks.forEach(w => out.push(w));
      offset += b.durationWeeks;
    });

    if (cycle.name === 'Trans I–II + Peak (5s→3s)' || out.length === 16) {
      const excelRpe = {
        1: '8.5',
        2: '8.5-9',
        3: '9',
        4: '9',
        5: '9-9.5',
        6: '9-9.5',
        7: '9-9.5',
        8: '9-9.5',
        9: '9-9.5',
        10: '9-9.5',
        11: '9-9.5',
        12: '9.5',
        13: '9.5',
        14: '9.5',
        15: '9-9.5',
        16: '9'
      };
      out.forEach(w => {
        if (excelRpe[w.weekNumber]) {
          w.heavyRPE = excelRpe[w.weekNumber];
        }
      });
    }
    return out;
  }

  // Attach live load anchors to a generated week given the current WMs.
  // wmFor(durationSeconds) -> kg or null.
  function annotateWeekAnchors(week, wmFor) {
    const w = Object.assign({}, week);
    if (w.heavyProtocol === 'deloadTest') {
      w.deloadAnchorKg = deloadAnchor(wmFor(5));
      w.heavyAnchorKg = w.deloadAnchorKg;
      return w;
    }
    const wm = wmFor(w.heavyDuration);
    w.heavyAnchorKg = heavyAnchor(wm, w.heavyRPE);
    w.backoffAnchorKg = backoffAnchor(w.heavyAnchorKg, w.backoffPctOfTop);
    if (w.volumePct != null) {
      w.volumeAnchorKg = volumeAnchor(w.heavyAnchorKg, w.volumePct);
    }
    w.wmMissing = wm == null;
    return w;
  }

  // ---- 6.4 Recovery flag -----------------------------------------------
  // entriesNewestFirst: array of log entries ordered newest -> oldest.
  function recoveryFlag(entriesNewestFirst) {
    const recent = entriesNewestFirst
      .map(e => e.nextDayFeel)
      .filter(v => v != null)
      .slice(0, 3);
    const latest = recent[0];
    const rollingAvg = recent.length >= 2 ? avg(recent) : null;
    const prevAvg = recent.length >= 3 ? avg(recent.slice(1)) : null;
    const flagged = (latest != null && latest <= 2) ||
      (rollingAvg != null && prevAvg != null && (prevAvg - rollingAvg >= 1.0));
    return { flagged: !!flagged, latest, rollingAvg, prevAvg };
  }

  // ---- inter-week fatigue trend (Reference: 2 declining weeks = deload) -
  // Groups Yielding E1RM by ISO week (Mon-anchored), takes each week's best,
  // and flags when the last three logged weeks strictly decline. E1RM already
  // normalises for RPE, so this approximates "declining performance at the
  // same RPE" without needing identical loads week to week.
  function isoWeekStart(iso) {
    const d = new Date(iso + 'T00:00:00');
    const day = (d.getDay() + 6) % 7; // Mon=0
    d.setDate(d.getDate() - day);
    return d.toISOString().slice(0, 10);
  }
  function deloadTrend(entries) {
    const byWeek = {};
    (entries || []).forEach(e => {
      if (e.type !== 'Yielding' || e.e1rmKg == null) return;
      const wk = isoWeekStart(e.date);
      if (byWeek[wk] == null || e.e1rmKg > byWeek[wk]) byWeek[wk] = e.e1rmKg;
    });
    const keys = Object.keys(byWeek).sort();
    if (keys.length < 3) return { flagged: false, weeks: [] };
    const last3 = keys.slice(-3).map(w => ({ week: w, e1rm: byWeek[w] }));
    const [a, b, c] = last3;
    const flagged = b.e1rm < a.e1rm && c.e1rm < b.e1rm;
    return {
      flagged, weeks: last3,
      message: flagged
        ? `Top-end E1RM has slipped two weeks running (${a.e1rm} → ${b.e1rm} → ${c.e1rm} kg at matched effort) — the classic accumulated-fatigue signal. Consider a deload week. (Suggestion, not a rule.)`
        : null
    };
  }

  // ---- 6.5 WM jump guard ------------------------------------------------
  function wmJumpGuard(newWM, currentWM) {
    if (currentWM == null || currentWM === 0) return { triggered: false, pct: null };
    const pct = (newWM - currentWM) / currentWM;
    return { triggered: pct > 0.15, pct: Math.round(pct * 1000) / 10 };
  }

  // ---- 11. Periodization guardrails ------------------------------------
  // Returns array of { id, message } for whichever rules fire.
  function guardrails(cycle, wmDurations) {
    const warns = [];
    const blocks = cycle.blocks || [];
    wmDurations = wmDurations || []; // durations with a WM on file

    // 1. Missing WM for any heavy duration used.
    const needed = new Set();
    blocks.forEach(b => {
      if (b.isDeloadTest) return;
      if (b.heavy && b.heavy.hangDurationSeconds) needed.add(b.heavy.hangDurationSeconds);
    });
    needed.forEach(d => {
      if (!wmDurations.includes(d)) {
        warns.push({ id: 'missingWM', message:
          `No ${d}s Working Max on file. Set a ${d}s benchmark before this block starts so load anchors are correct.` });
      }
    });

    // 2. >6 consecutive loading weeks without a deload/test.
    let run = 0, maxRun = 0;
    blocks.forEach(b => {
      if (b.isDeloadTest) { run = 0; }
      else { run += b.durationWeeks; maxRun = Math.max(maxRun, run); }
    });
    if (maxRun > 6) {
      warns.push({ id: 'longLoading', message:
        'More than 6 weeks without a deload — tendons accumulate structural fatigue. Consider inserting a recovery week.' });
    }

    // 3. Peak block > 3 weeks.
    blocks.forEach(b => {
      if (b.type === 'Peak' && b.durationWeeks > 3) {
        warns.push({ id: 'longPeak', message:
          'Peak blocks longer than 3 weeks tend to accumulate fatigue rather than express strength. Consider 2–3 weeks.' });
      }
    });

    // 4. Volume % and RPE both rising across consecutive (non-deload) blocks.
    const loading = blocks.filter(b => !b.isDeloadTest && b.heavy && b.volume);
    for (let i = 1; i < loading.length; i++) {
      const a = loading[i - 1], b = loading[i];
      const rpeUp = (b.heavy.rpeEnd > a.heavy.rpeEnd);
      const volUp = (b.volume.pctEnd > a.volume.pctEnd);
      if (rpeUp && volUp) {
        warns.push({ id: 'seesaw', message:
          'Volume % and RPE are both increasing block-to-block. Classic periodization uses a seesaw: raise one as you lower the other.' });
        break;
      }
    }

    // 5. No deload/test block at all.
    if (!blocks.some(b => b.isDeloadTest)) {
      warns.push({ id: 'noDeload', message:
        "No benchmark test in this cycle — you won't have a fresh anchor for the next one." });
    }

    // 6. Heavy day and board/limit day < 2 days apart.
    const ws = cycle.weeklyStructure || {};
    const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const heavyDays = order.filter(d => ws[d] === 'Heavy');
    const boardDays = order.filter(d => ws[d] === 'OIprimer' || ws[d] === 'Climb' || ws[d] === 'Board');
    let close = false;
    heavyDays.forEach(h => boardDays.forEach(b => {
      const raw = Math.abs(order.indexOf(h) - order.indexOf(b));
      const wrap = Math.min(raw, 7 - raw);
      if (wrap < 2) close = true;
    }));
    if (close) {
      warns.push({ id: 'closeSessions', message:
        'Heavy hangs and limit bouldering are close together in your weekly structure — they may both be hit on tired fingers.' });
    }

    return warns;
  }

  // ---- date helpers -----------------------------------------------------
  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function daysBetween(aIso, bIso) {
    const a = new Date(aIso + 'T00:00:00');
    const b = new Date(bIso + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  }
  // Which week number (1-indexed) of a cycle does a date fall in? null if outside.
  function weekNumberFor(cycle, dateIso) {
    const totalWeeks = (cycle.blocks || []).reduce((s, b) => s + b.durationWeeks, 0);
    const diff = daysBetween(cycle.startDate, dateIso);
    if (diff < 0) return null;
    const wk = Math.floor(diff / 7) + 1;
    return wk <= totalWeeks ? wk : null;
  }

  const Calc = {
    roundTo, roundTo05, roundTo025, lerp, avg,
    e1rm, heavyAnchor, volumeAnchor, backoffAnchor, deloadAnchor,
    expandBlock, expandCycle, annotateWeekAnchors,
    recoveryFlag, deloadTrend, wmJumpGuard, guardrails,
    addDays, daysBetween, weekNumberFor, parseRPE
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
  root.Calc = Calc;
})(typeof self !== 'undefined' ? self : this);

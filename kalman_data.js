/* ============================================================
   kalman_data.js — filtered "true strength" track + asymmetric
   forward fan (sibling of cone_data.js)
   ------------------------------------------------------------
   DISPLAY-ONLY math. Reads the point arrays it is given and
   returns new arrays — it never touches calc.js, Working Maxes,
   load anchors, periodization, logEntries, benchmarks, meta,
   IndexedDB, or sync.js. Nothing in the app consumes its output
   except drawKalmanTrack (kalman.js).

   window.buildKalmanTrack(histPts, opts)
     histPts: [{x:'YYYY-MM-DD', y:kg}]   (same 3s-native array the cone gets)
     opts:    { horizonWeeks:6, tests:[{date,label}], q:<override>, R:<override> }
     -> { filtered:[{x,y,sd}], forecast:{median,bands,targets},
          readiness:{last,filtered,deltaKg,sigma,band},
          q, R, slopePerWeek, n }  |  null (needs >= 3 points)

   METHOD — local-linear-trend Kalman filter
   · State [L, S]: L = latent "true" E1RM level (kg), S = its
     rate of change (kg/day). Iterated day-by-day across real
     session gaps, so irregular sampling is handled natively.
   · Per-day predict: L += S; slope picks up process noise q
     (kg²/day per day). Update: standard scalar Kalman step
     against the logged E1RM with observation noise R (kg²).
   · R (how noisy one session is) comes from the residual spread
     around an OLS fit of the raw series, floored at 0.4² — the
     same idea the cone uses for its width.
   · q (how fast the trend may drift) is fit by maximum
     likelihood over a log grid 1e-5..1e-1 (25 steps), from the
     filter's own one-step prediction errors. Fallback 1e-3 when
     n < 5. Noisy/flat data -> smoother track; clear trend ->
     more responsive.
   Validated on the 2026-07-04 backup (13 sessions): walk-forward
   MAE 1.0–1.4 kg at 10–30-day horizons vs 1.8–1.9 kg for the
   OLS cone; the 2026-05-14 drop is filtered as a −2.6σ bad day,
   not a strength loss.

   FORECAST — asymmetric on purpose.
   A symmetric CI around a straight trend says "losing 3 kg next
   month" is as likely as "gaining 3 kg more than expected".
   For an athlete who keeps training that is wrong in both
   directions, so the fan is built from slope-persistence
   scenarios plus state uncertainty:
   · median  — the current slope decays gently (×PHI_MED/day,
     half-life ~6 weeks): gains continue but slow down.
   · upper   — the current rate simply persists (×PHI_UP/day),
     plus z·σ(state): the ceiling if adaptation keeps up.
   · lower   — gains STALL (slope dies in ~a week, ×PHI_LO/day)
     rather than reverse; additionally the drop below the median
     is capped at [z·σ(now) + DRIFT_DN·days]: you may already be
     a little weaker than estimated, and true strength may bleed
     off ~0.9 kg/month at worst WHILE TRAINING CONTINUES. Big
     single-session dips are treated as expression noise (bad
     day), which is exactly what the backup data shows — every
     drop recovered within a week. Injury / stopping training is
     out of model and stated so in the UI copy.
   · 50% band = same construction with z(50%) and the scenario
     offsets scaled by z50/z90, so bands nest and never cross.
   If the fitted slope is negative the scenario set still brackets
   correctly (upper/lower are the max/min over all three paths).
   ============================================================ */
(function () {
  'use strict';

  var DAY = 86400000;
  var Z90 = 1.645, Z50 = 0.674;
  var PHI_MED = 0.985;   /* median: slope half-life ~46 days      */
  var PHI_UP  = 1.0;     /* upper:  current rate persists         */
  var PHI_LO  = 0.90;    /* lower:  gains stall within ~a week    */
  var DRIFT_DN = 0.03;   /* kg/day max plausible slow loss (~0.9 kg/month) while training */

  function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function r1(v) { return Math.round(v * 10) / 10; }

  /* Dedupe by date (max per day) + sort — same rule as coneHistory. */
  function trackHistory(pts) {
    var by = {};
    (pts || []).forEach(function (p) {
      if (!p || p.x == null || p.y == null || !isFinite(+p.y)) return;
      if (by[p.x] == null || +p.y > by[p.x]) by[p.x] = +p.y;
    });
    return Object.keys(by).sort().map(function (x) { return { x: x, y: by[x] }; });
  }

  /* One full filter pass. Returns states per observation, final state,
     and the Gaussian innovation log-likelihood (for the q search). */
  function runFilter(ts, ys, q, R) {
    /* seed L0/S0 from OLS through the first <=5 points */
    var k = Math.min(5, ys.length), i;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (i = 0; i < k; i++) {
      sx += ts[i]; sy += ys[i]; sxx += ts[i] * ts[i]; sxy += ts[i] * ys[i];
    }
    var den = k * sxx - sx * sx;
    var S = den ? (k * sxy - sx * sy) / den : 0;
    var L = ys[0];
    var P00 = 4 * R, P01 = 0, P11 = 0.05 * 0.05;
    var ll = 0, out = [], lastInnov = 0, lastS = Math.sqrt(P00 + R);

    for (i = 0; i < ys.length; i++) {
      if (i > 0) {
        var dt = ts[i] - ts[i - 1], d;
        for (d = 0; d < dt; d++) {           /* day-stepped predict */
          L += S;
          var n00 = P00 + 2 * P01 + P11;
          var n01 = P01 + P11;
          P00 = n00; P01 = n01; P11 = P11 + q;
        }
      }
      var s = P00 + R;                        /* innovation variance */
      var r = ys[i] - L;                      /* innovation          */
      ll += -0.5 * (Math.log(2 * Math.PI * s) + (r * r) / s);
      var K0 = P00 / s, K1 = P01 / s;
      L += K0 * r; S += K1 * r;
      var u00 = (1 - K0) * P00, u01 = (1 - K0) * P01;
      var u11 = P11 - K1 * P01;
      P00 = u00; P01 = u01; P11 = u11;
      lastInnov = r; lastS = Math.sqrt(s);
      out.push({ L: L, S: S, sd: Math.sqrt(Math.max(0, P00)) });
    }
    return { states: out, L: L, S: S, P00: P00, P01: P01, P11: P11,
             ll: ll, innov: lastInnov, innovSd: lastS };
  }

  function buildKalmanTrack(histPts, opts) {
    var hist = trackHistory(histPts);
    if (hist.length < 3) return null;
    var o = opts || {};
    var horizonDays = (o.horizonWeeks || 6) * 7;

    var t0 = Date.parse(hist[0].x);
    var ts = hist.map(function (p) { return Math.round((Date.parse(p.x) - t0) / DAY); });
    var ys = hist.map(function (p) { return p.y; });
    var n = ys.length, i;

    /* ---- R from OLS residual spread (cone's idea, floored 0.4) ---- */
    var R = o.R;
    if (R == null) {
      var sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (i = 0; i < n; i++) { sx += ts[i]; sy += ys[i]; sxx += ts[i] * ts[i]; sxy += ts[i] * ys[i]; }
      var den = n * sxx - sx * sx;
      var sl = den ? (n * sxy - sx * sy) / den : 0;
      var ic = (sy - sl * sx) / n, ss = 0;
      for (i = 0; i < n; i++) { var rr = ys[i] - (ic + sl * ts[i]); ss += rr * rr; }
      var sig = Math.max(0.4, Math.sqrt(ss / Math.max(1, n - 2)));
      R = sig * sig;
    }

    /* ---- q by 1-D MLE over a log grid (fallback 1e-3 for tiny n) ---- */
    var q = o.q;
    if (q == null) {
      if (n < 5) { q = 1e-3; }
      else {
        var bestQ = 1e-3, bestLL = -Infinity, steps = 25;
        for (i = 0; i < steps; i++) {
          var qc = Math.exp(Math.log(1e-5) + (i / (steps - 1)) * Math.log(1e4));
          var f = runFilter(ts, ys, qc, R);
          if (isFinite(f.ll) && f.ll > bestLL) { bestLL = f.ll; bestQ = qc; }
        }
        q = bestQ;
      }
    }

    var fit = runFilter(ts, ys, q, R);

    /* ---- filtered track ---- */
    var filtered = hist.map(function (p, j) {
      return { x: p.x, y: r1(fit.states[j].L), sd: Math.round(fit.states[j].sd * 100) / 100 };
    });

    /* ---- forward fan (see header: scenario spread + state σ) ----
       σ(state) is propagated predict-only with the fitted q.       */
    var lastMs = Date.parse(hist[n - 1].x);
    var L = fit.L, S = fit.S;
    var sigNow = Math.sqrt(Math.max(0, fit.P00));

    /* per-day σ of the latent level, days 0..horizon */
    var sigPath = [Math.sqrt(Math.max(0, fit.P00))];
    var p00 = fit.P00, p01 = fit.P01, p11 = fit.P11, d;
    for (d = 1; d <= horizonDays; d++) {
      var a00 = p00 + 2 * p01 + p11;
      var a01 = p01 + p11;
      p00 = a00; p01 = a01; p11 = p11 + q;
      sigPath.push(Math.sqrt(Math.max(0, p00)));
    }

    /* cumulative scenario gains per day for the three slope paths */
    function gains(phi) {
      var out = [0], g = 0, s = S;
      for (var dd = 1; dd <= horizonDays; dd++) { g += s; s *= phi; out.push(g); }
      return out;
    }
    var gMed = gains(PHI_MED), gUp = gains(PHI_UP), gLo = gains(PHI_LO);

    function bandAt(h, z, zr) {   /* zr = scenario-offset scale (z/Z90) */
      var m = L + gMed[h];
      var hiPath = Math.max(gMed[h], gUp[h], gLo[h]);
      var loPath = Math.min(gMed[h], gUp[h], gLo[h]);
      /* drop cap: current-level uncertainty + slow-loss allowance */
      var dn = Math.min(z * sigPath[h], z * sigNow + zr * DRIFT_DN * h);
      return {
        m: m,
        up: m + zr * (hiPath - gMed[h]) + z * sigPath[h],
        lo: m - zr * (gMed[h] - loPath) - dn
      };
    }

    var median = [], up90 = [], lo90 = [], up50 = [], lo50 = [];
    for (d = 0; d <= horizonDays; d += 7) {
      var x = iso(lastMs + d * DAY);
      var b90 = bandAt(d, Z90, 1);
      var b50 = bandAt(d, Z50, Z50 / Z90);
      median.push({ x: x, y: r1(b90.m) });
      up90.push({ x: x, y: r1(b90.up) });
      lo90.push({ x: x, y: r1(Math.min(b90.lo, b50.lo)) });
      up50.push({ x: x, y: r1(Math.min(b50.up, b90.up)) });
      lo50.push({ x: x, y: r1(Math.max(b50.lo, Math.min(b90.lo, b50.lo))) });
    }

    var targets = [];
    (o.tests || []).forEach(function (tst) {
      var ms = Date.parse(tst && tst.date);
      if (!isFinite(ms)) return;
      var h = Math.round((ms - lastMs) / DAY);
      if (h <= 0 || h > horizonDays + 3) return;
      var hh = Math.min(h, horizonDays);
      var tb = bandAt(hh, Z90, 1);
      targets.push({ x: tst.date, y: r1(tb.m), hi: r1(tb.up), lo: r1(tb.lo),
                     label: tst.label || 'Test' });
    });

    /* ---- readiness: last session vs the filtered trend ---- */
    var rz = fit.innovSd > 0 ? fit.innov / fit.innovSd : 0;
    var band = Math.abs(rz) < 1 ? 'within normal session-to-session noise'
      : Math.abs(rz) < 2 ? (rz > 0 ? 'a notably strong session' : 'a notably low session')
      : (rz > 0 ? 'an unusually strong session' : 'an unusually low session');

    return {
      filtered: filtered,
      forecast: {
        median: median,
        bands: [
          { level: 0.9, upper: up90, lower: lo90 },
          { level: 0.5, upper: up50, lower: lo50 }
        ],
        targets: targets
      },
      readiness: {
        last: ys[n - 1],
        filtered: r1(fit.L),
        deltaKg: Math.round((ys[n - 1] - fit.L) * 10) / 10,
        sigma: Math.round(rz * 10) / 10,
        band: band
      },
      q: q, R: Math.round(R * 100) / 100,
      slopePerWeek: Math.round(fit.S * 7 * 100) / 100,
      n: n
    };
  }

  window.buildKalmanTrack = buildKalmanTrack;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildKalmanTrack: buildKalmanTrack };
  }
})();

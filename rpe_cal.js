/* ============================================================
   rpe_cal.js — personal RPE→%max curve calibration
   ------------------------------------------------------------
   DISPLAY-ONLY math, sibling of cone_data.js / kalman_data.js.
   Reads the point array it is given and returns a fitted curve —
   it never touches calc.js, Working Maxes, load anchors,
   periodization, logEntries, benchmarks, meta, IndexedDB, or
   sync.js. Stored e1rmKg values and all training math stay on
   the generic table; only Analytics recomputes its displayed
   series through this curve.

   WHY. calc.js uses the generic linear model %1RM = 40 + 6·RPE,
   i.e. pct(r) = 1 − 0.06·(10 − r): every RPE point below 10 is
   worth 6% of max. Athletes differ (typically 3.5–7%/point).
   If YOUR true spacing is 4.5%/pt, a generic-table E1RM from an
   @8 session overestimates day strength vs an @9.5 session —
   noise that pollutes every trend chart. This module fits the
   spacing k from the athlete's own logs:

       observed load ≈ M(t) · (1 − k·(10 − rpe))

   with M(t) the (unknown) day-strength level. Alternate:
     · given k: E1RM points e_i = load_i/(1−k(10−r_i)),
       M(t) = LOESS-lite (tri-cube weighted local linear fit,
       28-day bandwidth) through e_i
     · given M: k = 1-D least-squares grid over [0.02..0.12]
   until k converges (few iterations; n is tiny).

   SELF-VALIDATION GATE. The personal k ships only if it beats
   the generic 0.06 out-of-sample: leave-one-out over sessions,
   predict the held-out load from M(t) fitted on the rest, score
   |error|. If personal ≤ generic (or data is too thin/narrow:
   n < 8 or RPE spread < 2), source:'default' and k = 0.06 —
   charts then match the stored values exactly.

   Validated offline (2026-07-06) on 450 synthetic athletes with
   known random true curves (k* ∈ [0.035, 0.085], generator in
   qa/athlete_gen.js; tuning seeds 70000+, FRESH holdout seeds
   90000+): with the shipped defaults (lambda 0.5, margin 0.05)
   the gate calibrates ~19% of athletes — deliberately strict —
   and among those, displayed-E1RM error vs the athlete's true
   latent strength improves median ~10%, 10th percentile ≈ 0
   (i.e. almost never worse than the generic table). A naive
   joint fit was rejected during development: RPE reporting
   noise (errors-in-variables) made it drift AWAY from truth on
   the same benchmark. See qa/rpe_validate.js, qa/rpe_sweep.js,
   qa/rpe_chart_eval.js.

   window.fitRpeCurve(points, opts)
     points: [{date:'YYYY-MM-DD', load:kg, rpe:5..10, dur:3|5}]
             (top sets + benchmark tests; dur 3 divides by the
              same 1.1 premium the app already uses)
     opts:   { kMin:0.03, kMax:0.10, bandwidthDays:28 }
     -> { k, source:'calibrated'|'default', n, spread,
          looPersonal, looGeneric,        // mean abs LOO error (kg)
          e1rm(load, rpe, dur) }          // convenience, 5s-normalised
   ============================================================ */
(function () {
  'use strict';

  var DAY = 86400000;
  var K_GENERIC = 0.06;

  function usable(points) {
    return (points || []).filter(function (p) {
      return p && isFinite(+p.load) && +p.load > 0 &&
        isFinite(+p.rpe) && +p.rpe >= 5 && +p.rpe <= 10 &&
        isFinite(Date.parse(p.date));
    }).map(function (p) {
      return { t: Date.parse(p.date) / DAY, load: +p.load / (p.dur === 3 ? 1.1 : 1), rpe: +p.rpe };
    }).sort(function (a, b) { return a.t - b.t; });
  }

  function pct(k, rpe) { return 1 - k * (10 - rpe); }

  /* LOESS-lite: tri-cube weighted local LINEAR fit of e over time,
     evaluated at t0. skipIdx excludes one point (for LOO). */
  function localLevel(pts, e, t0, bw, skipIdx) {
    var sw = 0, swt = 0, swy = 0, swtt = 0, swty = 0, i, n = 0;
    for (i = 0; i < pts.length; i++) {
      if (i === skipIdx) continue;
      var u = Math.abs(pts[i].t - t0) / bw;
      var w = u >= 1 ? 0 : Math.pow(1 - u * u * u, 3);
      if (w <= 0) continue;
      var t = pts[i].t - t0, y = e[i];
      sw += w; swt += w * t; swy += w * y; swtt += w * t * t; swty += w * t * y;
      n++;
    }
    if (!sw) return null;
    var den = sw * swtt - swt * swt;
    if (n < 3 || Math.abs(den) < 1e-9) return swy / sw;       // fall back to weighted mean
    var b = (sw * swty - swt * swy) / den;
    var a = (swy - b * swt) / sw;
    return a;                                                  // value at t0
  }

  /* Given k, mean |load − M(t)·pct| over all points with M fit LOO-style
     (each point excluded from its own level estimate). */
  function looError(pts, k, bw) {
    var e = pts.map(function (p) { return p.load / pct(k, p.rpe); });
    var s = 0, n = 0, i;
    for (i = 0; i < pts.length; i++) {
      var M = localLevel(pts, e, pts[i].t, bw, i);
      if (M == null) continue;
      s += Math.abs(pts[i].load - M * pct(k, pts[i].rpe));
      n++;
    }
    return n ? s / n : Infinity;
  }

  function fitRpeCurve(points, opts) {
    var o = opts || {};
    var kMin = o.kMin != null ? o.kMin : 0.03;
    var kMax = o.kMax != null ? o.kMax : 0.10;
    var bw = o.bandwidthDays != null ? o.bandwidthDays : 28;

    var pts = usable(points);
    var n = pts.length;
    var out = { k: K_GENERIC, source: 'default', n: n, spread: 0,
                looPersonal: null, looGeneric: null };
    out.e1rm = function (load, rpe, dur) {
      if (load == null || rpe == null || rpe < 5) return null;
      var p = pct(out.k, rpe);
      if (p < 0.2) return null;
      var raw = load / p;
      return Math.round((dur === 3 ? raw / 1.1 : raw) * 10) / 10;
    };
    if (!n) return out;

    var rs = pts.map(function (p) { return p.rpe; });
    out.spread = Math.max.apply(null, rs) - Math.min.apply(null, rs);
    if (n < 8 || out.spread < 2) return out;                   // too thin to personalise

    /* ---- pairwise (Theil–Sen-style) estimator ----------------------
       For two sessions close in time the latent level cancels:
         load_i / load_j = pct(k, r_i) / pct(k, r_j)
       which solves for k in closed form per pair:
         k = (1 − R) / (a_i − R·a_j),  a = 10 − rpe,  R = drift-corrected ratio.
       The median over all usable pairs is robust to bad days and RPE
       mis-reports, and differencing removes the M(t) confound that made
       a two-stage joint fit drift on validation. Drift correction uses
       the global log-trend under the GENERIC curve (small over ≤14d).  */
    var i, j;
    var slope = 0, sw = 0, swt = 0, swy = 0, swtt = 0, swty = 0;
    for (i = 0; i < n; i++) {
      var yy = Math.log(pts[i].load / pct(K_GENERIC, pts[i].rpe));
      sw += 1; swt += pts[i].t; swy += yy; swtt += pts[i].t * pts[i].t; swty += pts[i].t * yy;
    }
    var den = sw * swtt - swt * swt;
    if (Math.abs(den) > 1e-9) slope = (sw * swty - swt * swy) / den;   // log-kg per day

    var kPairs = [];
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) {
        var dt = pts[j].t - pts[i].t;
        if (dt > 14) break;                                    // sorted by t
        if (Math.abs(pts[i].rpe - pts[j].rpe) < 1) continue;   // no effort contrast
        var R = (pts[i].load / pts[j].load) * Math.exp(slope * dt); // bring j back to i's date
        var ai = 10 - pts[i].rpe, aj = 10 - pts[j].rpe;
        var dnm = ai - R * aj;
        if (Math.abs(dnm) < 0.25) continue;                    // ill-conditioned pair
        var kp = (1 - R) / dnm;
        if (isFinite(kp) && kp > 0 && kp < 0.15) kPairs.push(kp);
      }
    }
    out.pairs = kPairs.length;
    if (kPairs.length < 8) return out;                         // not enough contrast yet

    kPairs.sort(function (a, b) { return a - b; });
    var m = kPairs.length >> 1;
    var kRaw = kPairs.length % 2 ? kPairs[m] : (kPairs[m - 1] + kPairs[m]) / 2;
    /* shrink toward generic: pairs are noisy at these sample sizes, and a
       half-step keeps most of the benefit while capping the damage when the
       median is off (lambda tuned on synthetic athletes, qa/rpe_validate.js) */
    var LAMBDA = o.lambda != null ? o.lambda : 0.5;
    var k = K_GENERIC + LAMBDA * (kRaw - K_GENERIC);
    k = Math.max(kMin, Math.min(kMax, k));

    /* out-of-sample gate: ship personal k only if it beats generic by a
       margin (also tuned on synthetics — a bare "<" let overfit wins ship) */
    var MARGIN = o.margin != null ? o.margin : 0.05;
    var looP = looError(pts, k, bw);
    var looG = looError(pts, K_GENERIC, bw);
    out.looPersonal = Math.round(looP * 100) / 100;
    out.looGeneric = Math.round(looG * 100) / 100;
    out.kRaw = Math.round(kRaw * 1000) / 1000;
    if (isFinite(looP) && looP < looG * (1 - MARGIN)) {
      out.k = Math.round(k * 1000) / 1000;
      out.source = 'calibrated';
    }
    return out;
  }

  window.fitRpeCurve = fitRpeCurve;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { fitRpeCurve: fitRpeCurve };
  }
})();

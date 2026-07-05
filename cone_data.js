/* ============================================================
   cone_data.js — projection inputs for the probability cone
   ------------------------------------------------------------
   Builds the {median, bands, targets} arrays that cone.js
   renders. DISPLAY-ONLY math: a simple trend + uncertainty
   sketch for the chart. It reads the history it is given and
   returns new arrays — it never touches calc.js, Working
   Maxes, periodization, logs, or the DB, and nothing in the
   app consumes its output except drawStochasticCone.

   window.coneHistory(pts)
     -> copy of [{x:'YYYY-MM-DD', y}], deduped (max per date), sorted

   window.buildConeProjection(histPts, opts)
     -> { median, bands, targets } or null (needs >= 3 points)
     opts: { horizonWeeks: 6,
             tests: [{ date: 'YYYY-MM-DD', label: 'Test W4' }] }

   Method (kept deliberately simple and inspectable):
   · straight-line fit (OLS) through the last <= 10 sessions
   · slope clamped to ±0.12 kg/day so tiny samples can't
     project absurd trajectories (raised from ±0.05 after a
     walk-forward backtest; ±0.05 systematically under-projected
     genuine growth phases at multi-week horizons)
   · cone pinches shut at the last logged session; width grows
     with sqrt(weeks ahead), scaled by the fit's residual
     spread (floored at 0.4 kg so a lucky fit still shows
     honest uncertainty)
   · 90% and 50% bands (z = 1.645 / 0.674)
   ============================================================ */
(function () {
  'use strict';

  var DAY = 86400000;
  var Z90 = 1.645, Z50 = 0.674;

  function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }

  function coneHistory(pts) {
    var by = {};
    (pts || []).forEach(function (p) {
      if (!p || p.x == null || p.y == null || !isFinite(+p.y)) return;
      if (by[p.x] == null || +p.y > by[p.x]) by[p.x] = +p.y;
    });
    return Object.keys(by).sort().map(function (x) { return { x: x, y: by[x] }; });
  }

  function buildConeProjection(histPts, opts) {
    var hist = coneHistory(histPts);
    if (hist.length < 3) return null;
    var o = opts || {};
    var horizonDays = (o.horizonWeeks || 6) * 7;

    /* Ordinary least squares through the most recent points,
       with days as the time axis. */
    var use = hist.slice(-10);
    var t0 = Date.parse(use[0].x);
    var ts = use.map(function (p) { return (Date.parse(p.x) - t0) / DAY; });
    var n = use.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    use.forEach(function (p, i) {
      sx += ts[i]; sy += p.y; sxx += ts[i] * ts[i]; sxy += ts[i] * p.y;
    });
    var denom = n * sxx - sx * sx;
    if (!denom) return null;                          /* all on one day */
    var slope = (n * sxy - sx * sy) / denom;          /* kg per day */
    slope = Math.max(-0.12, Math.min(0.12, slope));   /* ±0.84 kg/week cap — walk-forward backtested; ±0.05 under-projected fast growth phases by ~3.5kg at 6wk */
    var intercept = (sy - slope * sx) / n;

    /* Residual spread sets the cone width. */
    var ss = 0;
    use.forEach(function (p, i) {
      var r = p.y - (intercept + slope * ts[i]);
      ss += r * r;
    });
    var sigma = Math.max(0.4, Math.sqrt(ss / Math.max(1, n - 2)));

    /* Pin the cone to the last logged session so it grows out of the
       final blue node instead of jumping to the fit line. */
    var last = use[use.length - 1];
    var tLast = ts[ts.length - 1];
    var lastMs = Date.parse(last.x);
    var shift = last.y - (intercept + slope * tLast);
    function mid(h) { return intercept + slope * (tLast + h) + shift; }
    function width(h, z) { return z * sigma * Math.sqrt(h / 7); }
    function r1(v) { return Math.round(v * 10) / 10; }

    var median = [], up90 = [], lo90 = [], up50 = [], lo50 = [];
    for (var h = 0; h <= horizonDays; h += 7) {
      var x = iso(lastMs + h * DAY), m = mid(h);
      median.push({ x: x, y: r1(m) });
      up90.push({ x: x, y: r1(m + width(h, Z90)) });
      lo90.push({ x: x, y: r1(m - width(h, Z90)) });
      up50.push({ x: x, y: r1(m + width(h, Z50)) });
      lo50.push({ x: x, y: r1(m - width(h, Z50)) });
    }

    var targets = [];
    (o.tests || []).forEach(function (tst) {
      var ms = Date.parse(tst && tst.date);
      if (!isFinite(ms)) return;
      var h = (ms - lastMs) / DAY;
      if (h <= 0 || h > horizonDays + 3) return;      /* upcoming + in range */
      targets.push({
        x: tst.date, y: r1(mid(h)),
        hi: r1(mid(h) + width(h, Z90)), lo: r1(mid(h) - width(h, Z90)),
        label: tst.label || 'Test'
      });
    });

    return {
      median: median,
      bands: [
        { level: 0.9, upper: up90, lower: lo90 },
        { level: 0.5, upper: up50, lower: lo50 }
      ],
      targets: targets
    };
  }

  /* estimateDurationFactor(pts5, pts3, opts)
     -----------------------------------------------------------------
     Estimates how much higher a 3s max-hang E1RM runs vs a 5s one, from
     the athlete's OWN data, so historical 5s sessions can be converted
     to 3s-equivalent for a native-3s projection.

     Method (trend continuity — the honest way with no paired hangs):
       · fit the 5s raw-E1RM trend (OLS, last <= 10 sessions)
       · for each 3s session inside a short window after the last 5s
         session, factor_i = raw3s / (5s trend extrapolated to that date)
       · this nets out the strength GAINED across the time gap, which a
         crude level-ratio (mean3s / mean5s) would wrongly bake in
       · take the median, clamp to [min,max] so a noisy fit can't produce
         an absurd factor, and fall back to `default` (a ~10% short-hang
         premium) until >= 2 usable 3s sessions exist

     Returns { factor, source: 'calibrated'|'default', n }.
     Pure display-layer helper — reads arrays, touches no DB/WM/calc math.

     pts5 / pts3: [{x:'YYYY-MM-DD', y: rawE1RM}]  (RAW, un-normalised)
     opts: { default:1.10, min:1.05, max:1.15, windowDays:42 } */
  function estimateDurationFactor(pts5, pts3, opts) {
    var o = opts || {};
    var def = o.default != null ? o.default : 1.10;
    var lo = o.min != null ? o.min : 1.05;
    var hi = o.max != null ? o.max : 1.15;
    var windowDays = o.windowDays != null ? o.windowDays : 42;

    var h5 = coneHistory(pts5), h3 = coneHistory(pts3);
    if (h5.length < 3 || h3.length < 1) return { factor: def, source: 'default', n: 0 };

    var use = h5.slice(-10);
    var t0 = Date.parse(use[0].x);
    var ts = use.map(function (p) { return (Date.parse(p.x) - t0) / DAY; });
    var n = use.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    use.forEach(function (p, i) { sx += ts[i]; sy += p.y; sxx += ts[i] * ts[i]; sxy += ts[i] * p.y; });
    var den = n * sxx - sx * sx;
    if (!den) return { factor: def, source: 'default', n: 0 };
    var slope = (n * sxy - sx * sy) / den, intercept = (sy - slope * sx) / n;
    function pred(ms) { return intercept + slope * ((ms - t0) / DAY); }

    var lastFiveMs = Date.parse(use[use.length - 1].x);
    var facs = [];
    h3.forEach(function (p) {
      var ms = Date.parse(p.x);
      if ((ms - lastFiveMs) / DAY > windowDays) return;   /* extrapolation past the window is unreliable */
      var e5 = pred(ms);
      if (e5 > 0) facs.push(p.y / e5);
    });
    if (facs.length < 2) return { factor: def, source: 'default', n: facs.length };

    facs.sort(function (a, b) { return a - b; });
    var m = facs.length >> 1;
    var med = facs.length % 2 ? facs[m] : (facs[m - 1] + facs[m]) / 2;
    med = Math.max(lo, Math.min(hi, med));
    return { factor: Math.round(med * 1000) / 1000, source: 'calibrated', n: facs.length };
  }

  window.coneHistory = coneHistory;
  window.buildConeProjection = buildConeProjection;
  window.estimateDurationFactor = estimateDurationFactor;
})();

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
   · RPE-WEIGHTED R (added 2026-07-10): when history points carry
     the top-set RPE ({x, y, rpe}), each observation gets its own
     R_i. An E1RM read off an @8 top set extrapolates further
     through the RPE→%max curve than an @9.5, so its error is
     larger by exactly the propagation factor of the curve already
     in use: e1rm = load/pct, pct = 1 − k(10 − rpe), so
     σ_i ∝ 1/pct_i (k = opts.rpeK: the personal calibrated k from
     rpe_cal.js when available, else the generic 0.06). Weights
     w_i = (1/pct_i)² are NORMALIZED to mean 1 over the observed
     sessions, so the overall noise level stays exactly the
     OLS-calibrated R — the weighting only redistributes trust
     between sessions, it never claims more total information.
     Points without a usable rpe (missing, or outside 4..10) get
     w = 1; if no point has one, every path below is numerically
     identical to the unweighted filter. Normalized weights are
     capped to [0.5, 2.5] so a junk rpe can't dominate the fit.
     No new fitted parameters — the factor is forced by the same
     curve that produced the E1RM itself.
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
  var PHI_LO  = 0.85;    /* lower: gains stall in ~1-2 weeks. 0.90 -> 0.85 farm-backtested
                            2026-07-06 (qa/farm.js, 800 athletes, 38k latent targets):
                            true-strength-below-band rate 7.3% -> 5.3% ≈ the nominal 5%,
                            for +2% band width. 90% band covers 89.7% of latent truth. */
  var DRIFT_DN = 0.03;   /* kg/day max plausible slow loss (~0.9 kg/month) while training */

  function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function r1(v) { return Math.round(v * 10) / 10; }

  /* Dedupe by date (max per day) + sort — same rule as coneHistory.
     Entries whose date doesn't parse are dropped (fuzz-hardened 2026-07-06:
     a corrupt last date used to reach iso() and throw "Invalid time value").
     The winning (max-y) entry's rpe rides along when present + sane. */
  function trackHistory(pts) {
    var by = {};
    (pts || []).forEach(function (p) {
      if (!p || p.x == null || p.y == null || !isFinite(+p.y)) return;
      if (!isFinite(Date.parse(p.x))) return;
      if (by[p.x] == null || +p.y > by[p.x].y) {
        var rpe = (p.rpe != null && isFinite(+p.rpe) && +p.rpe >= 4 && +p.rpe <= 10)
          ? +p.rpe : null;
        by[p.x] = { y: +p.y, rpe: rpe, degraded: !!p.degraded };
      }
    });
    return Object.keys(by).sort().map(function (x) {
      return { x: x, y: by[x].y, rpe: by[x].rpe, degraded: by[x].degraded };
    });
  }

  /* Degraded-position observations (the top set held the time but the fingers
     rolled open / the wrist collapsed) are CONTAMINATED, not wrong: the load
     is real but it doesn't mean what a clean rep means. They get 4× the
     variance, i.e. double the σ.

     Note this is applied AFTER the RPE weights are mean-normalized, and is
     deliberately NOT folded into that normalization. RPE weighting only
     redistributes trust between sessions and preserves total information;
     a degraded session genuinely carries LESS information, so the total
     should drop. Rolling it into the mean would quietly re-inflate trust in
     the remaining sessions to compensate, which is not what we mean. */
  var DEGRADED_R_MULT = 4;

  /* One full filter pass. Returns states per observation, final state,
     and the Gaussian innovation log-likelihood (for the q search).
     Rarr = per-observation noise (array, same length as ys); with a
     constant array this is numerically identical to the old scalar-R
     filter. Rbase seeds the initial level uncertainty. */
  function runFilter(ts, ys, q, Rarr, Rbase) {
    /* seed L0/S0 from OLS through the first <=5 points */
    var k = Math.min(5, ys.length), i;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (i = 0; i < k; i++) {
      sx += ts[i]; sy += ys[i]; sxx += ts[i] * ts[i]; sxy += ts[i] * ys[i];
    }
    var den = k * sxx - sx * sx;
    var S = den ? (k * sxy - sx * sy) / den : 0;
    var L = ys[0];
    var P00 = 4 * Rbase, P01 = 0, P11 = 0.05 * 0.05;
    var ll = 0, out = [], lastInnov = 0, lastS = Math.sqrt(P00 + Rarr[0]);

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
      var s = P00 + Rarr[i];                  /* innovation variance */
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

  /* Forward fan construction, lifted verbatim out of buildKalmanTrack so the
     paired filter below can reuse it. Same arithmetic, same order of
     operations — the scalar path's output is unchanged. */
  function buildFan(L, S, P00, P01, P11, q, horizonDays, lastMs, o) {
    var phiMed = o.phiMed, phiUp = o.phiUp, phiLo = o.phiLo, driftDn = o.driftDn;
    var sigNow = Math.sqrt(Math.max(0, P00));

    /* per-day σ of the latent level, days 0..horizon */
    var sigPath = [Math.sqrt(Math.max(0, P00))];
    var p00 = P00, p01 = P01, p11 = P11, d;
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
    var gMed = gains(phiMed), gUp = gains(phiUp), gLo = gains(phiLo);

    function bandAt(h, z, zr) {   /* zr = scenario-offset scale (z/Z90) */
      var m = L + gMed[h];
      var hiPath = Math.max(gMed[h], gUp[h], gLo[h]);
      var loPath = Math.min(gMed[h], gUp[h], gLo[h]);
      /* drop cap: current-level uncertainty + slow-loss allowance */
      var dn = Math.min(z * sigPath[h], z * sigNow + zr * driftDn * h);
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

    return {
      median: median,
      bands: [
        { level: 0.9, upper: up90, lower: lo90 },
        { level: 0.5, upper: up50, lower: lo50 }
      ],
      targets: targets
    };
  }

  function buildKalmanTrack(histPts, opts) {
    var hist = trackHistory(histPts);
    if (hist.length < 3) return null;
    var o = opts || {};
    var horizonDays = (o.horizonWeeks || 6) * 7;
    /* Scenario/floor tunables (defaults = module constants; overridable so
       the offline backtest farm in qa/ can sweep them). */
    var phiMed = o.phiMed != null ? o.phiMed : PHI_MED;
    var phiUp = o.phiUp != null ? o.phiUp : PHI_UP;
    var phiLo = o.phiLo != null ? o.phiLo : PHI_LO;
    var driftDn = o.driftDn != null ? o.driftDn : DRIFT_DN;
    var rFloor = o.rFloor != null ? o.rFloor : 0.4;

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
      var sig = Math.max(rFloor, Math.sqrt(ss / Math.max(1, n - 2)));
      R = sig * sig;
    }

    /* ---- per-observation R from top-set RPE (see header) ----
       w_i = (1/pct_i)², normalized to mean 1, capped [0.5, 2.5];
       missing/invalid rpe -> exactly R (no-rpe input == old filter). */
    var rpeK = (o.rpeK != null && isFinite(+o.rpeK))
      ? Math.min(0.10, Math.max(0.03, +o.rpeK)) : 0.06;
    var wRaw = hist.map(function (p) {
      if (p.rpe == null) return null;
      var pct = 1 - rpeK * (10 - p.rpe);
      if (!(pct > 0.2)) return null;
      return 1 / (pct * pct);
    });
    var wSum = 0, wN = 0;
    wRaw.forEach(function (w) { if (w != null) { wSum += w; wN++; } });
    var wMean = wN ? wSum / wN : 1;
    var Rarr = wRaw.map(function (w, j) {
      var base = (w == null) ? R : R * Math.min(2.5, Math.max(0.5, w / wMean));
      return hist[j].degraded ? base * DEGRADED_R_MULT : base;
    });

    /* ---- q by 1-D MLE over a log grid (fallback 1e-3 for tiny n) ---- */
    var q = o.q;
    if (q == null) {
      if (n < 5) { q = 1e-3; }
      else {
        var bestQ = 1e-3, bestLL = -Infinity, steps = 25;
        for (i = 0; i < steps; i++) {
          var qc = Math.exp(Math.log(1e-5) + (i / (steps - 1)) * Math.log(1e4));
          var f = runFilter(ts, ys, qc, Rarr, R);
          if (isFinite(f.ll) && f.ll > bestLL) { bestLL = f.ll; bestQ = qc; }
        }
        q = bestQ;
      }
    }

    var fit = runFilter(ts, ys, q, Rarr, R);

    /* ---- filtered track ---- */
    var filtered = hist.map(function (p, j) {
      return { x: p.x, y: r1(fit.states[j].L), sd: Math.round(fit.states[j].sd * 100) / 100 };
    });

    /* ---- forward fan (see header: scenario spread + state σ) ---- */
    var lastMs = Date.parse(hist[n - 1].x);
    var fan = buildFan(fit.L, fit.S, fit.P00, fit.P01, fit.P11, q, horizonDays,
                       lastMs, { phiMed: phiMed, phiUp: phiUp, phiLo: phiLo,
                                 driftDn: driftDn, tests: o.tests });
    var median = fan.median, targets = fan.targets;

    /* ---- readiness: last session vs the filtered trend ---- */
    var rz = fit.innovSd > 0 ? fit.innov / fit.innovSd : 0;
    var band = Math.abs(rz) < 1 ? 'within normal session-to-session noise'
      : Math.abs(rz) < 2 ? (rz > 0 ? 'a notably strong session' : 'a notably low session')
      : (rz > 0 ? 'an unusually strong session' : 'an unusually low session');

    return {
      filtered: filtered,
      forecast: {
        median: median,
        bands: fan.bands,
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
      rObs: Rarr.map(function (r) { return Math.round(r * 100) / 100; }),
      rpeWeighted: wN > 0,
      slopePerWeek: Math.round(fit.S * 7 * 100) / 100,
      n: n
    };
  }

  /* ============================================================
     PAIRED FILTER — shared latent strength + slow asymmetry
     ------------------------------------------------------------
     Block pulls are one-handed, so each session yields TWO numbers.
     Three ways to handle that; this is the third.

       (a) two independent filters — simple, but each hand sees only
           half the observations, so both fans are wider than they
           need to be, and "is my gap closing" degrades to eyeballing
           two lines that each carry their own noise.
       (b) filter the mean — one clean track, throws the asymmetry
           away entirely.
       (c) one latent strength state, observed twice per session,
           plus an asymmetry state. Strictly more information than
           (a) and it keeps what (b) discards.

     State [L, S, A]:
       L = latent bilateral strength level (kg)
       S = its rate of change (kg/day)
       A = asymmetry, SIGNED as right − left (kg)
     Observation model, either side optionally missing:
       y_L = L − A/2 + noise(R_L)
       y_R = L + A/2 + noise(R_R)
     Transition per day: L += S; S picks up q; A picks up qA.

     MEASURED, NOT ASSUMED (qa/kalman_paired_farm.js, 120-400 synthetic
     athletes per scenario, latent truth known):

       asymmetry MAE   paired 21-32% BETTER than differencing two
                       independent tracks. Holds in every scenario
                       tested — short blocks, noisy data, missing
                       hands, degraded sets.
       level MAE       paired 0.3-12% WORSE than the mean of two
                       independent scalar filters.

     The level result contradicts the obvious argument that "two
     observations per session must beat one". The reason it fails:
     observing one hand tells you about L − A/2, not about L. With A
     unknown the filter has to split each innovation between the two
     states, and that split leaks noise into L. Two independent
     filters never face the ambiguity — each tracks its own hand's
     latent directly — and averaging their outputs is a hard-to-beat
     ensemble. Widening the qA grid does not close the gap; the effect
     persists even when the true asymmetry is exactly constant, which
     rules out the process-noise prior as the cause.

     SO: this filter is the ASYMMETRY estimator, not the level
     estimator. app.js draws per-hand tracks and the forward fan from
     two independent buildKalmanTrack calls, and takes only `asym` /
     `asymNow` from here. `filtered` is retained because the fan and
     the readiness line need a level to hang off, but it is NOT the
     number the strength chart should show.

     Other properties:
     · A missing hand is handled natively — the filter updates on what
       it saw. No imputation, no dropped session. (Note this makes it
       robust, not more accurate: the missing-hand scenario is where
       its level estimate is worst.)
     · A is a STATE with its own variance, so the app can say whether
       a gap is real or the two hands are indistinguishable — which
       differencing two tracks cannot answer at all.
     · qA is a prior, not a fit, unless there is enough data. Fitting
       two process-noise parameters on ~18 sessions overfits. Default
       qA = ASYM_Q_RATIO·q; above ASYM_FIT_MIN paired sessions a coarse
       secondary grid picks the ratio by the same MLE as q.
     ============================================================ */
  var ASYM_Q_RATIO = 0.25;   /* asymmetry drifts ~4x slower than the level */
  var ASYM_FIT_MIN = 10;     /* paired sessions needed before qA is fitted  */
  var ASYM_RATIOS = [0.05, 0.15, 0.25, 0.5, 1.0];

  function meanObs(a, b) {
    if (a == null && b == null) return null;
    if (a == null) return b;
    if (b == null) return a;
    return (a + b) / 2;
  }

  function runPairedFilter(ts, yL, yR, q, qA, RL, RR, Rbase) {
    var n = ts.length, i;

    /* seed L0/S0 from OLS through the first <=5 sessions' bilateral mean */
    var seedY = [], seedT = [];
    for (i = 0; i < n && seedT.length < 5; i++) {
      var m = meanObs(yL[i], yR[i]);
      if (m != null) { seedY.push(m); seedT.push(ts[i]); }
    }
    var k = seedT.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (i = 0; i < k; i++) {
      sx += seedT[i]; sy += seedY[i]; sxx += seedT[i] * seedT[i]; sxy += seedT[i] * seedY[i];
    }
    var den = k * sxx - sx * sx;
    var S = den ? (k * sxy - sx * sy) / den : 0;
    var L = seedY.length ? seedY[0] : 0;
    /* seed A from the first session that actually has both hands */
    var A = 0;
    for (i = 0; i < n; i++) {
      if (yL[i] != null && yR[i] != null) { A = yR[i] - yL[i]; break; }
    }

    var p00 = 4 * Rbase, p01 = 0, p02 = 0;
    var p11 = 0.05 * 0.05, p12 = 0, p22 = 4 * Rbase;
    var ll = 0, out = [], lastInnov = 0, lastSd = Math.sqrt(p00 + Rbase);

    for (i = 0; i < n; i++) {
      if (i > 0) {
        var dt = ts[i] - ts[i - 1], d;
        for (d = 0; d < dt; d++) {           /* day-stepped predict */
          L += S;
          var a00 = p00 + 2 * p01 + p11;
          var a01 = p01 + p11;
          var a02 = p02 + p12;
          p00 = a00; p01 = a01; p02 = a02;
          p11 = p11 + q;
          p22 = p22 + qA;
        }
      }
      /* Sequential scalar updates. Exact for independent observation noise,
         and it means a session with one hand needs no special case.
         With K_i = (PH')_i / s, the Joseph-free update P -= (PH')(PH')'/s is
         symmetric by construction, so no re-symmetrisation is needed. */
      var obs = [];
      if (yL[i] != null) obs.push([yL[i], -0.5, RL[i]]);
      if (yR[i] != null) obs.push([yR[i], 0.5, RR[i]]);
      for (var j = 0; j < obs.length; j++) {
        var y = obs[j][0], h = obs[j][1], Rv = obs[j][2];
        var h0 = p00 + h * p02;              /* (P H')_0 */
        var h1 = p01 + h * p12;              /* (P H')_1 */
        var h2 = p02 + h * p22;              /* (P H')_2 */
        var s = h0 + h * h2 + Rv;            /* H P H' + R */
        if (!(s > 0)) continue;
        var r = y - (L + h * A);
        ll += -0.5 * (Math.log(2 * Math.PI * s) + (r * r) / s);
        L += (h0 / s) * r; S += (h1 / s) * r; A += (h2 / s) * r;
        p00 -= h0 * h0 / s;
        p01 -= h0 * h1 / s;
        p02 -= h0 * h2 / s;
        p11 -= h1 * h1 / s;
        p12 -= h1 * h2 / s;
        p22 -= h2 * h2 / s;
        lastInnov = r; lastSd = Math.sqrt(s);
      }
      out.push({ L: L, S: S, A: A,
                 sd: Math.sqrt(Math.max(0, p00)),
                 sdA: Math.sqrt(Math.max(0, p22)) });
    }
    return { states: out, L: L, S: S, A: A,
             P00: p00, P01: p01, P11: p11, P22: p22,
             ll: ll, innov: lastInnov, innovSd: lastSd };
  }

  /* histL / histR: [{x, y, rpe, degraded}] per hand, same date grid or not.
     Returns null when there isn't enough to identify the asymmetry, and the
     caller falls back to two independent scalar tracks. */
  function buildPairedKalmanTrack(histLPts, histRPts, opts) {
    var o = opts || {};
    var hL = trackHistory(histLPts), hR = trackHistory(histRPts);
    var byDate = {};
    hL.forEach(function (p) { (byDate[p.x] = byDate[p.x] || {}).L = p; });
    hR.forEach(function (p) { (byDate[p.x] = byDate[p.x] || {}).R = p; });
    var dates = Object.keys(byDate).sort();
    if (dates.length < 3) return null;
    var paired = dates.filter(function (x) { return byDate[x].L && byDate[x].R; }).length;
    /* With fewer than 3 two-handed sessions the asymmetry state is barely
       identifiable — the caller is better off with two independent tracks. */
    if (paired < 3) return null;

    var horizonDays = (o.horizonWeeks || 6) * 7;
    var phiMed = o.phiMed != null ? o.phiMed : PHI_MED;
    var phiUp = o.phiUp != null ? o.phiUp : PHI_UP;
    var phiLo = o.phiLo != null ? o.phiLo : PHI_LO;
    var driftDn = o.driftDn != null ? o.driftDn : DRIFT_DN;
    var rFloor = o.rFloor != null ? o.rFloor : 0.4;

    var t0 = Date.parse(dates[0]);
    var ts = dates.map(function (x) { return Math.round((Date.parse(x) - t0) / DAY); });
    var yL = dates.map(function (x) { return byDate[x].L ? byDate[x].L.y : null; });
    var yR = dates.map(function (x) { return byDate[x].R ? byDate[x].R.y : null; });
    var n = dates.length, i;

    /* ---- R from the OLS residual spread of the bilateral mean ---- */
    var R = o.R;
    if (R == null) {
      var mt = [], my = [];
      for (i = 0; i < n; i++) {
        var m = meanObs(yL[i], yR[i]);
        if (m != null) { mt.push(ts[i]); my.push(m); }
      }
      var mn = my.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (i = 0; i < mn; i++) { sx += mt[i]; sy += my[i]; sxx += mt[i] * mt[i]; sxy += mt[i] * my[i]; }
      var den = mn * sxx - sx * sx;
      var sl = den ? (mn * sxy - sx * sy) / den : 0;
      var ic = mn ? (sy - sl * sx) / mn : 0, ss = 0;
      for (i = 0; i < mn; i++) { var rr = my[i] - (ic + sl * mt[i]); ss += rr * rr; }
      var sig = Math.max(rFloor, Math.sqrt(ss / Math.max(1, mn - 2)));
      R = sig * sig;
    }

    /* ---- per-observation R: same RPE propagation factor as the scalar
       filter, mean-normalized ACROSS BOTH HANDS so the pooled noise level
       stays the OLS-calibrated R, then degraded sets inflated on top. ---- */
    var rpeK = (o.rpeK != null && isFinite(+o.rpeK))
      ? Math.min(0.10, Math.max(0.03, +o.rpeK)) : 0.06;
    function rawW(p) {
      if (!p || p.rpe == null) return null;
      var pct = 1 - rpeK * (10 - p.rpe);
      if (!(pct > 0.2)) return null;
      return 1 / (pct * pct);
    }
    var wL = dates.map(function (x) { return rawW(byDate[x].L); });
    var wR = dates.map(function (x) { return rawW(byDate[x].R); });
    var wSum = 0, wN = 0;
    wL.concat(wR).forEach(function (w) { if (w != null) { wSum += w; wN++; } });
    var wMean = wN ? wSum / wN : 1;
    function toR(w, p) {
      var base = (w == null) ? R : R * Math.min(2.5, Math.max(0.5, w / wMean));
      return (p && p.degraded) ? base * DEGRADED_R_MULT : base;
    }
    var RL = dates.map(function (x, j) { return toR(wL[j], byDate[x].L); });
    var RR = dates.map(function (x, j) { return toR(wR[j], byDate[x].R); });

    /* ---- q (and optionally the qA ratio) by MLE over a log grid ---- */
    var q = o.q, qRatio = o.asymQRatio != null ? o.asymQRatio : null;
    if (q == null) {
      if (n < 5) { q = 1e-3; if (qRatio == null) qRatio = ASYM_Q_RATIO; }
      else {
        var ratios = (qRatio != null) ? [qRatio]
          : (paired >= ASYM_FIT_MIN ? ASYM_RATIOS : [ASYM_Q_RATIO]);
        var bestQ = 1e-3, bestRatio = ASYM_Q_RATIO, bestLL = -Infinity, steps = 25;
        for (i = 0; i < steps; i++) {
          var qc = Math.exp(Math.log(1e-5) + (i / (steps - 1)) * Math.log(1e4));
          for (var ri = 0; ri < ratios.length; ri++) {
            var f = runPairedFilter(ts, yL, yR, qc, qc * ratios[ri], RL, RR, R);
            if (isFinite(f.ll) && f.ll > bestLL) { bestLL = f.ll; bestQ = qc; bestRatio = ratios[ri]; }
          }
        }
        q = bestQ; qRatio = bestRatio;
      }
    }
    if (qRatio == null) qRatio = ASYM_Q_RATIO;
    var qA = o.qA != null ? o.qA : q * qRatio;

    var fit = runPairedFilter(ts, yL, yR, q, qA, RL, RR, R);

    /* ---- filtered tracks: shared level, and each hand as level ∓ A/2 ---- */
    var level = [], asym = [], handL = [], handR = [];
    dates.forEach(function (x, j) {
      var st = fit.states[j];
      level.push({ x: x, y: r1(st.L), sd: Math.round(st.sd * 100) / 100 });
      handL.push({ x: x, y: r1(st.L - st.A / 2) });
      handR.push({ x: x, y: r1(st.L + st.A / 2) });
      /* asymmetry reported as a magnitude plus which side leads, and as a
         percentage of the stronger hand — the number people actually compare */
      var strong = Math.max(st.L - st.A / 2, st.L + st.A / 2);
      asym.push({
        x: x, y: r1(st.A), sd: Math.round(st.sdA * 100) / 100,
        pct: strong > 0 ? Math.round((Math.abs(st.A) / strong) * 1000) / 10 : 0,
        lead: st.A > 0 ? 'R' : (st.A < 0 ? 'L' : null)
      });
    });

    var lastMs = Date.parse(dates[n - 1]);
    var fan = buildFan(fit.L, fit.S, fit.P00, fit.P01, fit.P11, q, horizonDays,
                       lastMs, { phiMed: phiMed, phiUp: phiUp, phiLo: phiLo,
                                 driftDn: driftDn, tests: o.tests });

    var rz = fit.innovSd > 0 ? fit.innov / fit.innovSd : 0;
    var band = Math.abs(rz) < 1 ? 'within normal session-to-session noise'
      : Math.abs(rz) < 2 ? (rz > 0 ? 'a notably strong session' : 'a notably low session')
      : (rz > 0 ? 'an unusually strong session' : 'an unusually low session');

    /* Is the gap real? |A| against its own posterior σ. Below ~1σ the
       honest answer is that the two hands are indistinguishable, and the app
       should say so rather than drawing conclusions from a 2% difference. */
    var lastA = fit.A, sdA = Math.sqrt(Math.max(0, fit.P22));
    var asymZ = sdA > 0 ? Math.abs(lastA) / sdA : 0;
    var lastMean = meanObs(yL[n - 1], yR[n - 1]);

    return {
      filtered: level,
      hands: { L: handL, R: handR },
      asym: asym,
      asymNow: {
        kg: r1(lastA), sd: Math.round(sdA * 100) / 100,
        pct: asym.length ? asym[asym.length - 1].pct : 0,
        lead: lastA > 0 ? 'R' : (lastA < 0 ? 'L' : null),
        sigma: Math.round(asymZ * 10) / 10,
        resolved: asymZ >= 1
      },
      forecast: { median: fan.median, bands: fan.bands, targets: fan.targets },
      readiness: {
        last: lastMean,
        filtered: r1(fit.L),
        deltaKg: lastMean != null ? Math.round((lastMean - fit.L) * 10) / 10 : null,
        sigma: Math.round(rz * 10) / 10,
        band: band
      },
      q: q, qA: qA, asymQRatio: qRatio,
      R: Math.round(R * 100) / 100,
      rObs: { L: RL.map(function (r) { return Math.round(r * 100) / 100; }),
              R: RR.map(function (r) { return Math.round(r * 100) / 100; }) },
      rpeWeighted: wN > 0,
      slopePerWeek: Math.round(fit.S * 7 * 100) / 100,
      n: n, paired: paired
    };
  }

  window.buildKalmanTrack = buildKalmanTrack;
  window.buildPairedKalmanTrack = buildPairedKalmanTrack;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildKalmanTrack: buildKalmanTrack,
                       buildPairedKalmanTrack: buildPairedKalmanTrack };
  }
})();

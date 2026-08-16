/* ============================================================
   cone.js — Stochastic E1RM Probability Cone
   ------------------------------------------------------------
   Read-only SVG visualization layer. Zero dependencies.
   Renders exactly the arrays passed in — it never reads or
   mutates app state, calc.js, periodization logic, or the DB.

   API
     drawStochasticCone(historicalData, predictiveData, container, options)
       -> returns the created <svg> element (null if container missing)

   Data shapes (x = ISO date "2026-07-03", epoch ms, or plain number
   such as a week index; y / hi / lo = kg):

     historicalData : [{ x, y }, ...]              // logged sessions

     predictiveData : {
       median  : [{ x, y }, ...],                  // central trajectory
       bands   : [                                 // any count, any order
         { level: 0.9, upper: [{x,y},...], lower: [{x,y},...] },
         { level: 0.5, upper: [...],      lower: [...] }
       ],
       targets : [{ x, y, hi, lo, label }, ...]    // benchmark test weeks
     }                                             // hi/lo = 90% interval

   options (all optional):
     { width: 360, height: 220,   // viewBox units; SVG scales responsively
       unit: 'kg',
       todayX: <x>,               // cone origin marker; defaults to the
                                  // last historical point
       colors: { grid, gray, ink, white, pillText, ... },
                                  // per-key palette overrides (dark theme)
       interactive: true }        // touch/pointer scrubber: crosshair +
                                  // value tooltip (logged / projected /
                                  // 90% target). Set false to disable.

   Repeated calls into the same container replace the previous chart.
   ============================================================ */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ---- Palette (matches the app's bright chunky system).
     Any key can be overridden per call via options.colors —
     e.g. grid/gray/ink/white/pillText for a dark theme. ---- */
  var DEFAULT_COLORS = {
    blue: '#1B3FA8', blueDeep: '#122C77',      // historical data
    green: '#1B3FA8',                          // optimal-adaptation side
    amber: '#C08A6E', amberStrong: '#B4441F',  // warning side, targets
    amberText: '#8C3416',
    red: '#A9502F',                            // fatigue / overtraining edge
    gray: '#606266', grid: '#E1DED4',          // median, gridlines
    ink: '#1B1D21', white: '#F2F0E9',          // NOW marker, node outlines
    pillText: '#F2F0E9'                        // text inside the NOW pill
  };

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function svgEl(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, String(attrs[k]));
      }
    }
    if (parent) parent.appendChild(n);
    return n;
  }

  function fmtVal(v) {
    var r = Math.round(v * 10) / 10;
    return (r % 1 === 0) ? String(r) : r.toFixed(1);
  }

  /* One tiny stylesheet, injected once: responsive sizing, rounded tabular
     numerals, touch capture for the scrubber, and the tooltip chrome. */
  function ensureStyles() {
    if (document.getElementById('cone-css')) return;
    var s = document.createElement('style');
    s.id = 'cone-css';
    s.textContent =
      'svg.cone-chart{width:100%;height:auto;display:block;touch-action:none;' +
      'font-family:"LI Mono",ui-monospace,SFMono-Regular,Menlo,monospace}' +
      'svg.cone-chart text{font-variant-numeric:tabular-nums;letter-spacing:0.04em}' +
      '.cone-tip{position:fixed;z-index:9999;pointer-events:none;opacity:0;' +
      'transform:translate(-50%,-100%);transition:opacity .08s;' +
      'background:#F2F0E9;border:1px solid #1B1D21;border-radius:2px;' +
      'box-shadow:none;padding:6px 9px;white-space:nowrap;' +
      'font:400 10px/1.5 "LI Mono",ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'color:#1B1D21;font-variant-numeric:tabular-nums}' +
      '.cone-tip b{font-weight:700}';
    document.head.appendChild(s);
  }

  /* Singleton tooltip element, shared by every cone on the page. */
  function tipEl() {
    var t = document.getElementById('cone-tip');
    if (!t) {
      t = document.createElement('div');
      t.id = 'cone-tip';
      t.className = 'cone-tip';
      document.body.appendChild(t);
    }
    return t;
  }

  function drawStochasticCone(historicalData, predictiveData, container, options) {
    var host = (typeof container === 'string') ? document.getElementById(container) : container;
    if (!host) {
      if (typeof console !== 'undefined') console.warn('[cone] container not found:', container);
      return null;
    }
    ensureStyles();

    var opts = options || {};
    var W = opts.width || 360, H = opts.height || 220;
    var unit = opts.unit || 'kg';
    var C = opts.colors ? Object.assign({}, DEFAULT_COLORS, opts.colors) : DEFAULT_COLORS;

    /* ---- input normalization ------------------------------------
       Accepts ISO strings, epoch ms, or plain numbers for x.
       `dateLike` decides how axis labels are formatted. Inputs are
       copied and sorted; the caller's arrays are never mutated.  */
    var dateLike = false;
    function toX(v) {
      if (typeof v === 'string') { dateLike = true; return Date.parse(v); }
      var n = +v;
      if (n > 3e10) dateLike = true;   // heuristics: epoch ms
      return n;
    }
    function norm(pts) {
      if (!Array.isArray(pts)) return [];
      return pts
        .map(function (p) {
          return {
            x: toX(p.x), y: +p.y,
            hi: (p.hi != null && isFinite(+p.hi)) ? +p.hi : null,
            lo: (p.lo != null && isFinite(+p.lo)) ? +p.lo : null,
            label: p.label
          };
        })
        .filter(function (p) { return isFinite(p.x) && isFinite(p.y); })
        .sort(function (a, b) { return a.x - b.x; });
    }

    var pred = predictiveData || {};
    var hist = norm(historicalData);
    var median = norm(pred.median);
    var bands = (Array.isArray(pred.bands) ? pred.bands : [])
      .map(function (b) { return { level: +b.level || 0, upper: norm(b.upper), lower: norm(b.lower) }; })
      .filter(function (b) { return b.upper.length > 1 && b.lower.length > 1; })
      .sort(function (a, b) { return b.level - a.level; });   // widest interval first
    var targets = norm(pred.targets);

    /* ---- data domain ---- */
    var xs = [], ys = [];
    function eat(arr) {
      arr.forEach(function (p) {
        xs.push(p.x); ys.push(p.y);
        if (p.hi != null) ys.push(p.hi);
        if (p.lo != null) ys.push(p.lo);
      });
    }
    eat(hist); eat(median); eat(targets);
    bands.forEach(function (b) { eat(b.upper); eat(b.lower); });
    if (!xs.length) {
      if (typeof console !== 'undefined') console.warn('[cone] no drawable points');
      return null;
    }
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var yLoRaw = Math.min.apply(null, ys), yHiRaw = Math.max.apply(null, ys);

    /* ---- y ticks: pad the domain, snap to a "nice" step ---- */
    var span = (yHiRaw - yLoRaw) || 1;
    var yLo = yLoRaw - span * 0.14, yHi = yHiRaw + span * 0.12;
    var rough = (yHi - yLo) / 4;
    var mag = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
    var mult = [1, 2, 2.5, 5, 10].filter(function (m) { return m * mag >= rough; })[0] || 10;
    var step = mult * mag;
    var y0 = Math.floor(yLo / step) * step, y1 = Math.ceil(yHi / step) * step;
    var ticks = [];
    for (var t = y0; t <= y1 + step * 0.01; t += step) ticks.push(Math.round(t * 100) / 100);

    /* ---- coordinate mapping: data space -> viewBox space ----
       sx: linear map of [x0..x1] onto the padded inner width.
       sy: linear map of [y0..y1] onto inner height, inverted
           because SVG y grows downward.                        */
    var PAD = { top: 22, right: 14, bottom: 26, left: 40 };
    var iw = W - PAD.left - PAD.right, ih = H - PAD.top - PAD.bottom;
    var xSpan = (x1 - x0) || 1, ySpan = (y1 - y0) || 1;
    function sx(x) { return PAD.left + ((x - x0) / xSpan) * iw; }
    function sy(y) { return PAD.top + (1 - (y - y0) / ySpan) * ih; }
    function r1(n) { return Math.round(n * 10) / 10; }

    function lineD(pts) {
      var d = '';
      for (var i = 0; i < pts.length; i++) {
        d += (i ? ' L' : 'M') + r1(sx(pts[i].x)) + ' ' + r1(sy(pts[i].y));
      }
      return d;
    }
    /* Region between two polylines: top left->right, bottom right->left. */
    function areaD(top, bottom) {
      var d = lineD(top);
      for (var i = bottom.length - 1; i >= 0; i--) {
        d += ' L' + r1(sx(bottom[i].x)) + ' ' + r1(sy(bottom[i].y));
      }
      return d + ' Z';
    }

    function fmtX(x) {
      if (!dateLike) return fmtVal(x);
      var d = new Date(x);
      return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
    }

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      'class': 'cone-chart',
      role: 'img',
      'aria-label': 'E1RM history with forward probability cone' +
        (targets.length ? ' and ' + targets.length + ' benchmark target' + (targets.length > 1 ? 's' : '') : '')
    });

    /* ---- gridlines + y labels ---- */
    ticks.forEach(function (tv) {
      var gy = r1(sy(tv));
      svgEl('line', { x1: PAD.left, y1: gy, x2: W - PAD.right, y2: gy, stroke: C.grid, 'stroke-width': 1.5 }, svg);
      var lbl = svgEl('text', {
        x: PAD.left - 8, y: gy + 3, 'text-anchor': 'end',
        'font-size': 9.5, 'font-weight': 700, fill: C.gray
      }, svg);
      lbl.textContent = fmtVal(tv);
    });

    /* ---- probability fan: widest interval first (most transparent),
       narrower bands stack on top with more opacity. Upper half =
       adaptation (green); lower half = fatigue (amber inner, red on
       the outermost, most pessimistic band). ---- */
    bands.forEach(function (b, i) {
      var op = Math.min(0.20, 0.055 + i * 0.06);
      if (median.length > 1) {
        svgEl('path', { d: areaD(b.upper, median), fill: C.green, 'fill-opacity': op }, svg);
        svgEl('path', { d: areaD(median, b.lower), fill: (i === 0 ? C.red : C.amber), 'fill-opacity': op }, svg);
      } else {
        svgEl('path', { d: areaD(b.upper, b.lower), fill: C.blue, 'fill-opacity': op }, svg);
      }
    });
    /* Cone edges: chunky rounded strokes on the outermost band. */
    if (bands.length) {
      svgEl('path', {
        d: lineD(bands[0].upper), fill: 'none', stroke: C.green,
        'stroke-width': 1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      }, svg);
      svgEl('path', {
        d: lineD(bands[0].lower), fill: 'none', stroke: C.red,
        'stroke-width': 1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      }, svg);
    }

    /* ---- median trajectory: thick neutral gray, chunky dashes ---- */
    if (median.length > 1) {
      svgEl('path', {
        d: lineD(median), fill: 'none', stroke: C.gray, 'stroke-width': 4,
        'stroke-dasharray': '10 9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      }, svg);
    }

    /* ---- NOW divider: where history ends and the cone begins ---- */
    var todayX = (opts.todayX != null) ? toX(opts.todayX)
      : (hist.length ? hist[hist.length - 1].x : (median.length ? median[0].x : x0));
    var nx = r1(sx(todayX));
    svgEl('line', {
      x1: nx, y1: PAD.top + 4, x2: nx, y2: H - PAD.bottom,
      stroke: C.ink, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.85
    }, svg);
    svgEl('rect', { x: nx - 19, y: PAD.top - 12, width: 38, height: 15, rx: 7.5, fill: C.ink }, svg);
    var nowT = svgEl('text', {
      x: nx, y: PAD.top - 1, 'text-anchor': 'middle',
      'font-size': 8.5, 'font-weight': 800, fill: C.pillText, 'letter-spacing': 0.7
    }, svg);
    nowT.textContent = 'NOW';

    /* ---- historical path + friendly nodes ---- */
    if (hist.length > 1) {
      svgEl('path', {
        d: lineD(hist), fill: 'none', stroke: C.blue, 'stroke-width': 4,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      }, svg);
    }
    hist.forEach(function (p, i) {
      var last = (i === hist.length - 1);
      var node = svgEl('circle', {
        cx: r1(sx(p.x)), cy: r1(sy(p.y)), r: last ? 7.5 : 6,
        fill: C.blue, stroke: C.white, 'stroke-width': 3
      }, svg);
      var tt = svgEl('title', null, node);
      tt.textContent = fmtVal(p.y) + ' ' + unit + (dateLike ? ' — ' + fmtX(p.x) : '');
    });
    if (hist.length) {
      var lastP = hist[hist.length - 1];
      var endTag = svgEl('text', {
        x: r1(sx(lastP.x)), y: r1(sy(lastP.y)) - 13, 'text-anchor': 'middle',
        'font-size': 10.5, 'font-weight': 800, fill: C.blueDeep
      }, svg);
      endTag.textContent = fmtVal(lastP.y);
    }

    /* ---- benchmark targets: 90% capsule + oversized hollow ring ---- */
    targets.forEach(function (p) {
      var cx = r1(sx(p.x));
      if (p.hi != null && p.lo != null) {
        svgEl('line', {
          x1: cx, y1: r1(sy(p.hi)), x2: cx, y2: r1(sy(p.lo)),
          stroke: C.amberStrong, 'stroke-width': 10, 'stroke-linecap': 'round', opacity: 0.3
        }, svg);
      }
      var ring = svgEl('circle', {
        cx: cx, cy: r1(sy(p.y)), r: 8.5,
        fill: C.white, stroke: C.amberStrong, 'stroke-width': 4
      }, svg);
      var tt = svgEl('title', null, ring);
      tt.textContent = (p.label || 'Benchmark') + ' — ' + fmtVal(p.y) + ' ' + unit +
        ((p.hi != null && p.lo != null) ? ' (90%: ' + fmtVal(p.lo) + '–' + fmtVal(p.hi) + ')' : '');
      var lab = svgEl('text', {
        x: cx, y: r1(sy(p.hi != null ? p.hi : p.y)) - 9, 'text-anchor': 'middle',
        'font-size': 8.5, 'font-weight': 800, fill: C.amberText, 'letter-spacing': 0.5
      }, svg);
      lab.textContent = String(p.label || 'TEST').toUpperCase();
    });

    /* ---- x-axis captions ---- */
    var xl = svgEl('text', {
      x: PAD.left, y: H - 8, 'text-anchor': 'start',
      'font-size': 9.5, 'font-weight': 700, fill: C.gray
    }, svg);
    xl.textContent = fmtX(x0);
    var xr = svgEl('text', {
      x: W - PAD.right, y: H - 8, 'text-anchor': 'end',
      'font-size': 9.5, 'font-weight': 700, fill: C.gray
    }, svg);
    xr.textContent = fmtX(x1);

    /* ---- interactive scrubber ------------------------------------
       Drag/touch anywhere on the chart: a crosshair snaps to the
       nearest data column and a tooltip shows the number — logged
       value for history, median + 90% band for the projection,
       label + interval for benchmark targets. ---- */
    if (opts.interactive !== false && typeof svg.addEventListener === 'function') {
      var upByX = {}, loByX = {}, targetXs = {};
      if (bands.length) {
        bands[0].upper.forEach(function (p) { upByX[p.x] = p.y; });
        bands[0].lower.forEach(function (p) { loByX[p.x] = p.y; });
      }
      targets.forEach(function (p) { targetXs[p.x] = true; });

      var stops = [];
      hist.forEach(function (p) { stops.push({ kind: 'hist', x: p.x, y: p.y }); });
      median.forEach(function (p, i) {
        if (targetXs[p.x]) return;                                   // target stop covers it
        if (i === 0 && hist.length && hist[hist.length - 1].x === p.x) return; // pinch point
        stops.push({ kind: 'proj', x: p.x, y: p.y, hi: upByX[p.x], lo: loByX[p.x] });
      });
      targets.forEach(function (p) {
        stops.push({ kind: 'target', x: p.x, y: p.y, hi: p.hi, lo: p.lo, label: p.label });
      });
      stops.forEach(function (s) { s.px = sx(s.x); s.py = sy(s.y); });

      if (stops.length) {
        var xline = svgEl('line', {
          x1: 0, x2: 0, y1: PAD.top + 2, y2: H - PAD.bottom,
          stroke: C.ink, 'stroke-width': 2.5, 'stroke-linecap': 'round', opacity: 0
        }, svg);
        var xdot = svgEl('circle', { r: 5.5, cx: 0, cy: 0, fill: C.white, 'stroke-width': 3, opacity: 0 }, svg);
        var dotStroke = { hist: C.blue, proj: C.gray, target: C.amberStrong };

        var tipHtml = function (s) {
          var when = fmtX(s.x);
          var range = (s.hi != null && s.lo != null)
            ? '<br>90%: ' + fmtVal(s.lo) + '–' + fmtVal(s.hi) + ' ' + unit : '';
          if (s.kind === 'hist') return '<b>' + fmtVal(s.y) + ' ' + unit + '</b> logged<br>' + when;
          if (s.kind === 'target') {
            return '<b>' + (s.label || 'Test') + '</b> · ~' + fmtVal(s.y) + ' ' + unit + range + '<br>' + when;
          }
          return '<b>~' + fmtVal(s.y) + ' ' + unit + '</b> projected' + range + '<br>' + when;
        };

        var showAt = function (clientX) {
          var rect = svg.getBoundingClientRect();
          if (!rect || !rect.width) return;
          var px = (clientX - rect.left) * (W / rect.width);
          var best = null, bd = Infinity;
          stops.forEach(function (s) {
            var d = Math.abs(s.px - px);
            if (d < bd) { bd = d; best = s; }
          });
          if (!best) return;
          xline.setAttribute('x1', best.px); xline.setAttribute('x2', best.px);
          xline.setAttribute('opacity', 0.3);
          xdot.setAttribute('cx', best.px); xdot.setAttribute('cy', best.py);
          xdot.setAttribute('stroke', dotStroke[best.kind] || C.blue);
          xdot.setAttribute('opacity', 1);
          var t = tipEl();
          t.innerHTML = tipHtml(best);
          var tx = rect.left + (best.px / W) * rect.width;
          var ty = rect.top + (best.py / H) * rect.height;
          var vw = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : rect.width;
          t.style.left = Math.max(70, Math.min(vw - 70, tx)) + 'px';
          t.style.top = (ty - 12) + 'px';
          t.style.opacity = '1';
        };
        var hide = function () {
          xline.setAttribute('opacity', 0);
          xdot.setAttribute('opacity', 0);
          tipEl().style.opacity = '0';
        };
        var onPointer = function (e) { showAt(e.clientX); };
        var onTouch = function (e) {
          if (e.touches && e.touches.length) showAt(e.touches[0].clientX);
        };
        svg.addEventListener('pointerdown', onPointer);
        svg.addEventListener('pointermove', onPointer);
        svg.addEventListener('pointerleave', hide);
        svg.addEventListener('touchstart', onTouch, { passive: true });
        svg.addEventListener('touchmove', onTouch, { passive: true });
        svg.addEventListener('touchend', hide);
        svg.addEventListener('touchcancel', hide);
      }
    }

    /* ---- mount (replace any previous cone in this container) ---- */
    var prev = host.querySelector && host.querySelector('svg.cone-chart');
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    host.appendChild(svg);
    return svg;
  }

  window.drawStochasticCone = drawStochasticCone;
})();

/* ============================================================
   kalman.js — Filtered "true strength" track renderer
   ------------------------------------------------------------
   Read-only SVG visualization layer. Zero dependencies.
   Renders exactly the arrays passed in — it never reads or
   mutates app state, calc.js, periodization logic, or the DB.
   Sibling of cone.js and drawn in the same visual language
   (same palette keys, same injected stylesheet + tooltip
   singletons, same scrubber pattern), but deliberately quieter:
   the fan is neutral blue — a statistical interval, not the
   cone's green/red adaptation-vs-fatigue story.

   API
     drawKalmanTrack(historicalData, model, container, options)
       -> returns the created <svg> element (null if container missing)

     historicalData : [{ x:'YYYY-MM-DD', y:kg }]   raw session dots
     model          : output of buildKalmanTrack(hist) —
                      { filtered:[{x,y,sd}], forecast:{median,bands,targets} }
     options        : { width, height, unit:'kg', todayX, colors, interactive }

   Layers back to front: grid — ±1σ ribbon — forecast fan —
   forecast median (dashed) — NOW pill — raw dots — filtered
   line — target rings — scrubber.
   Repeated calls into the same container replace the previous chart.
   ============================================================ */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';

  var DEFAULT_COLORS = {
    blue: '#1B3FA8', blueDeep: '#122C77',
    green: '#1B3FA8',
    amber: '#D9AE9C', amberStrong: '#B4441F', amberText: '#8C3416',
    red: '#A9502F',
    gray: '#606266', grid: '#E1DED4',
    ink: '#1B1D21', white: '#F2F0E9',
    pillText: '#F2F0E9'
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

  /* Same stylesheet + tooltip singletons as cone.js (idempotent:
     whichever chart renders first creates them). */
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

  function drawKalmanTrack(historicalData, model, container, options) {
    var host = (typeof container === 'string') ? document.getElementById(container) : container;
    if (!host) {
      if (typeof console !== 'undefined') console.warn('[kalman] container not found:', container);
      return null;
    }
    if (!model || !model.filtered || !model.forecast) {
      if (typeof console !== 'undefined') console.warn('[kalman] no model');
      return null;
    }
    ensureStyles();

    var opts = options || {};
    var W = opts.width || 360, H = opts.height || 220;
    var unit = opts.unit || 'kg';
    var C = opts.colors ? Object.assign({}, DEFAULT_COLORS, opts.colors) : DEFAULT_COLORS;

    var dateLike = false;
    function toX(v) {
      if (typeof v === 'string') { dateLike = true; return Date.parse(v); }
      var n = +v;
      if (n > 3e10) dateLike = true;
      return n;
    }
    function norm(pts) {
      if (!Array.isArray(pts)) return [];
      return pts
        .map(function (p) {
          return {
            x: toX(p.x), y: +p.y,
            sd: (p.sd != null && isFinite(+p.sd)) ? +p.sd : null,
            hi: (p.hi != null && isFinite(+p.hi)) ? +p.hi : null,
            lo: (p.lo != null && isFinite(+p.lo)) ? +p.lo : null,
            label: p.label
          };
        })
        .filter(function (p) { return isFinite(p.x) && isFinite(p.y); })
        .sort(function (a, b) { return a.x - b.x; });
    }

    var hist = norm(historicalData);
    var filtered = norm(model.filtered);
    var fc = model.forecast || {};
    var median = norm(fc.median);
    var bands = (Array.isArray(fc.bands) ? fc.bands : [])
      .map(function (b) { return { level: +b.level || 0, upper: norm(b.upper), lower: norm(b.lower) }; })
      .filter(function (b) { return b.upper.length > 1 && b.lower.length > 1; })
      .sort(function (a, b) { return b.level - a.level; });
    var targets = norm(fc.targets);

    /* ---- domain ---- */
    var xs = [], ys = [];
    function eat(arr) {
      arr.forEach(function (p) {
        xs.push(p.x); ys.push(p.y);
        if (p.sd != null) { ys.push(p.y + p.sd); ys.push(p.y - p.sd); }
        if (p.hi != null) ys.push(p.hi);
        if (p.lo != null) ys.push(p.lo);
      });
    }
    eat(hist); eat(filtered); eat(median); eat(targets);
    bands.forEach(function (b) { eat(b.upper); eat(b.lower); });
    if (!xs.length) {
      if (typeof console !== 'undefined') console.warn('[kalman] no drawable points');
      return null;
    }
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var yLoRaw = Math.min.apply(null, ys), yHiRaw = Math.max.apply(null, ys);

    var span = (yHiRaw - yLoRaw) || 1;
    var yLo = yLoRaw - span * 0.14, yHi = yHiRaw + span * 0.12;
    var rough = (yHi - yLo) / 4;
    var mag = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
    var mult = [1, 2, 2.5, 5, 10].filter(function (m) { return m * mag >= rough; })[0] || 10;
    var step = mult * mag;
    var y0 = Math.floor(yLo / step) * step, y1 = Math.ceil(yHi / step) * step;
    var ticks = [];
    for (var t = y0; t <= y1 + step * 0.01; t += step) ticks.push(Math.round(t * 100) / 100);

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
      'class': 'cone-chart kalman-chart',
      role: 'img',
      'aria-label': 'Kalman-filtered strength track with forward confidence fan'
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

    /* ---- ±1σ ribbon around the filtered line (history side) ---- */
    var ribbonPts = filtered.filter(function (p) { return p.sd != null; });
    if (ribbonPts.length > 1) {
      var ribUp = ribbonPts.map(function (p) { return { x: p.x, y: p.y + p.sd }; });
      var ribLo = ribbonPts.map(function (p) { return { x: p.x, y: p.y - p.sd }; });
      svgEl('path', { d: areaD(ribUp, ribLo), fill: C.blueDeep, 'fill-opacity': 0.10 }, svg);
    }

    /* ---- forward fan: neutral blue, widest band most transparent ---- */
    bands.forEach(function (b, i) {
      var op = Math.min(0.30, 0.10 + i * 0.09);
      svgEl('path', { d: areaD(b.upper, b.lower), fill: C.blue, 'fill-opacity': op }, svg);
    });
    if (bands.length) {
      svgEl('path', {
        d: lineD(bands[0].upper), fill: 'none', stroke: C.blue,
        'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.55
      }, svg);
      svgEl('path', {
        d: lineD(bands[0].lower), fill: 'none', stroke: C.blue,
        'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.55
      }, svg);
    }

    /* ---- forecast median: dashed continuation of the filtered line ---- */
    if (median.length > 1) {
      svgEl('path', {
        d: lineD(median), fill: 'none', stroke: C.blueDeep, 'stroke-width': 3.5,
        'stroke-dasharray': '9 8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.85
      }, svg);
    }

    /* ---- NOW divider ---- */
    var todayX = (opts.todayX != null) ? toX(opts.todayX)
      : (filtered.length ? filtered[filtered.length - 1].x : x0);
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

    /* ---- raw session dots: quiet, hollow-outlined, no connecting line
       (the filtered line IS the line in this chart) ---- */
    hist.forEach(function (p) {
      var node = svgEl('circle', {
        cx: r1(sx(p.x)), cy: r1(sy(p.y)), r: 4.5,
        fill: C.white, stroke: C.blue, 'stroke-width': 3
      }, svg);
      var tt = svgEl('title', null, node);
      tt.textContent = fmtVal(p.y) + ' ' + unit + ' logged' + (dateLike ? ' — ' + fmtX(p.x) : '');
    });

    /* ---- filtered "true strength" line, solid, through the dots ---- */
    if (filtered.length > 1) {
      svgEl('path', {
        d: lineD(filtered), fill: 'none', stroke: C.blueDeep, 'stroke-width': 4,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      }, svg);
    }
    if (filtered.length) {
      var lastF = filtered[filtered.length - 1];
      svgEl('circle', {
        cx: r1(sx(lastF.x)), cy: r1(sy(lastF.y)), r: 6.5,
        fill: C.blueDeep, stroke: C.white, 'stroke-width': 3
      }, svg);
      var endTag = svgEl('text', {
        x: r1(sx(lastF.x)), y: r1(sy(lastF.y)) - 12, 'text-anchor': 'middle',
        'font-size': 10.5, 'font-weight': 800, fill: C.blueDeep
      }, svg);
      endTag.textContent = fmtVal(lastF.y);
    }

    /* ---- benchmark targets (amber ring, same as the cone) ---- */
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

    /* ---- scrubber: history -> logged vs filtered ±σ;
            forecast -> median + 90% band; targets like the cone ---- */
    if (opts.interactive !== false && typeof svg.addEventListener === 'function') {
      var filtByX = {}, upByX = {}, loByX = {}, targetXs = {};
      filtered.forEach(function (p) { filtByX[p.x] = p; });
      if (bands.length) {
        bands[0].upper.forEach(function (p) { upByX[p.x] = p.y; });
        bands[0].lower.forEach(function (p) { loByX[p.x] = p.y; });
      }
      targets.forEach(function (p) { targetXs[p.x] = true; });

      var stops = [];
      hist.forEach(function (p) {
        stops.push({ kind: 'hist', x: p.x, y: p.y, f: filtByX[p.x] || null });
      });
      median.forEach(function (p, i) {
        if (targetXs[p.x]) return;
        if (i === 0 && filtered.length && filtered[filtered.length - 1].x === p.x) return;
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
        var dotStroke = { hist: C.blue, proj: C.blueDeep, target: C.amberStrong };

        var tipHtml = function (s) {
          var when = fmtX(s.x);
          if (s.kind === 'hist') {
            var fl = s.f ? '<br>filtered <b>' + fmtVal(s.f.y) + '</b>' +
              (s.f.sd != null ? ' ±' + fmtVal(s.f.sd) : '') + ' ' + unit : '';
            return '<b>' + fmtVal(s.y) + ' ' + unit + '</b> logged' + fl + '<br>' + when;
          }
          var range = (s.hi != null && s.lo != null)
            ? '<br>90%: ' + fmtVal(s.lo) + '–' + fmtVal(s.hi) + ' ' + unit : '';
          if (s.kind === 'target') {
            return '<b>' + (s.label || 'Test') + '</b> · ~' + fmtVal(s.y) + ' ' + unit + range + '<br>' + when;
          }
          return '<b>~' + fmtVal(s.y) + ' ' + unit + '</b> filtered trend' + range + '<br>' + when;
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

    /* ---- mount (replace any previous kalman chart in this container) ---- */
    var prev = host.querySelector && host.querySelector('svg.kalman-chart');
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    host.appendChild(svg);
    return svg;
  }

  window.drawKalmanTrack = drawKalmanTrack;
})();

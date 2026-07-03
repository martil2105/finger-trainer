/* ============================================================
   motion.js — lightweight companions to motion.css
   ------------------------------------------------------------
   Zero dependencies. Observes the DOM the app already renders;
   never changes training logic, timers, or data. Integration:

     <link rel="stylesheet" href="motion.css" />   after style.css
     <script src="motion.js"></script>             after app.js

   What runs automatically:
     · runner phase-pop / per-second tick / final-3s pulse
       (watches .runner class + countdown text — timer.js untouched)
     · sheet exit animation (wraps App.closeSheet non-destructively)
     · count-up on any [data-countup] element rendered into #view

   Utilities on window.Motion:
     Motion.countUp(el, opts)         animate a numeral landing
     Motion.toggleHeight(el, open?)   expand/collapse (.collapse-host)
     Motion.drawIn(svg, opts)         draw-in solid chart strokes

   Everything no-ops under prefers-reduced-motion.
   ============================================================ */
(function () {
  'use strict';

  var REDUCED = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var Motion = { reduced: REDUCED };

  /* Remove + reflow + re-add a class so its animation replays. */
  function replay(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  /* ---- Runner: phase + tick observers -------------------------- */
  function hookRunner(runner) {
    if (REDUCED || runner.__motionHooked || !window.MutationObserver) return;
    runner.__motionHooked = true;

    /* is-hang / is-rest flips -> pop the countdown + phase label */
    new MutationObserver(function () {
      var cd = runner.querySelector('.countdown');
      if (cd) replay(cd, 'phase-in');
      var ph = runner.querySelector('.phase');
      if (ph) replay(ph, 'phase-in');
    }).observe(runner, { attributes: true, attributeFilter: ['class'] });

    /* countdown text changes -> tick; <=3 s -> harder pulse */
    new MutationObserver(function () {
      var cd = runner.querySelector('.countdown');
      if (!cd) return;
      var v = parseInt(cd.textContent, 10);
      cd.classList.toggle('final', v > 0 && v <= 3);
      replay(cd, 'tick');
    }).observe(runner, { childList: true, subtree: true, characterData: true });
  }

  function watchRunner() {
    if (REDUCED || !window.MutationObserver) return;
    var existing = document.querySelector('.runner');
    if (existing) hookRunner(existing);
    var host = document.getElementById('modal-host') || document.body;
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes || [], function (n) {
          if (n.nodeType !== 1) return;
          if (n.classList && n.classList.contains('runner')) hookRunner(n);
          else if (n.querySelector) {
            var r = n.querySelector('.runner');
            if (r) hookRunner(r);
          }
        });
      });
    }).observe(host, { childList: true, subtree: true });
  }

  /* ---- Sheet exit: wrap App.closeSheet, behavior unchanged ----- */
  function wrapSheetClose() {
    if (!window.App || typeof window.App.closeSheet !== 'function') return;
    if (window.App.closeSheet.__motionWrapped) return;
    var orig = window.App.closeSheet;
    window.App.closeSheet = function () {
      var ov = document.querySelector('.sheet-overlay');
      if (REDUCED || !ov) return orig.apply(this, arguments);
      ov.classList.add('closing');
      var sh = ov.querySelector('.sheet');
      if (sh) sh.classList.add('closing');
      var self = this, args = arguments;
      setTimeout(function () { orig.apply(self, args); }, 190);
    };
    window.App.closeSheet.__motionWrapped = true;
  }

  /* ---- Count-up: a numeral "lands" when data changed ------------
     Deliberately subtle (94% -> value, ~0.5s): the number settles
     because you trained — it never spins from zero like a slot
     machine. Non-numeric content is left alone.                   */
  Motion.countUp = function (el, opts) {
    if (!el || REDUCED || !window.requestAnimationFrame) return;
    var text = el.textContent;
    var m = text.match(/-?\d+(\.\d+)?/);
    if (!m) return;
    var target = parseFloat(m[0]);
    if (!isFinite(target)) return;
    var dec = m[1] ? m[1].length - 1 : 0;
    var dur = (opts && opts.duration) || 500;
    var from = (opts && opts.from != null) ? +opts.from : target * 0.94;
    var t0 = null;
    function frame(ts) {
      if (t0 === null) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur);
      k = 1 - Math.pow(1 - k, 3); /* ease-out cubic */
      var v = (from + (target - from) * k).toFixed(dec);
      el.textContent = text.replace(m[0], k < 1 ? v : m[0]);
      if (k < 1) window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  };

  function watchCountups() {
    if (REDUCED || !window.MutationObserver) return;
    var view = document.getElementById('view');
    if (!view) return;
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes || [], function (n) {
          if (n.nodeType !== 1) return;
          if (n.matches && n.matches('[data-countup]')) Motion.countUp(n);
          if (n.querySelectorAll) {
            Array.prototype.forEach.call(
              n.querySelectorAll('[data-countup]'),
              function (c) { Motion.countUp(c); }
            );
          }
        });
      });
    }).observe(view, { childList: true, subtree: true });
  }

  /* ---- Expand/collapse: animate height to content size --------- */
  Motion.toggleHeight = function (el, open) {
    if (!el) return;
    var next = (open != null) ? !!open : !el.classList.contains('open');
    if (REDUCED) {
      el.classList.toggle('open', next);
      el.style.height = next ? 'auto' : '0px';
      return;
    }
    el.style.overflow = 'hidden';
    function cleanup(e) {
      if (e.propertyName !== 'height') return;
      el.removeEventListener('transitionend', cleanup);
      el.style.transition = '';
      if (el.classList.contains('open')) el.style.height = 'auto';
    }
    el.addEventListener('transitionend', cleanup);
    if (next) {
      el.classList.add('open');
      el.style.height = '0px';
      window.requestAnimationFrame(function () {
        el.style.transition = 'height 0.24s cubic-bezier(0.22, 1, 0.36, 1)';
        el.style.height = el.scrollHeight + 'px';
      });
    } else {
      el.style.height = el.scrollHeight + 'px';
      window.requestAnimationFrame(function () {
        el.style.transition = 'height 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
        el.style.height = '0px';
        el.classList.remove('open');
      });
    }
  };

  /* ---- Draw-in for solid chart strokes (skips dashed paths) ---- */
  Motion.drawIn = function (svg, opts) {
    if (!svg || REDUCED || !svg.querySelectorAll) return;
    var dur = (opts && opts.duration) || 600;
    Array.prototype.forEach.call(svg.querySelectorAll('path'), function (p) {
      if (!p.getTotalLength) return;
      if (p.getAttribute('stroke-dasharray')) return;   /* keep dashes intact */
      if (!p.getAttribute('stroke') && !p.style.stroke) return;
      var len;
      try { len = p.getTotalLength(); } catch (e) { return; }
      if (!len) return;
      p.style.strokeDasharray = len + ' ' + len;
      p.style.strokeDashoffset = String(len);
      void p.getBoundingClientRect();
      p.style.transition = 'stroke-dashoffset ' + dur + 'ms cubic-bezier(0.22, 1, 0.36, 1)';
      p.style.strokeDashoffset = '0';
      p.addEventListener('transitionend', function () {
        p.style.strokeDasharray = '';
        p.style.transition = '';
      }, { once: true });
    });
  };

  function init() {
    watchRunner();
    watchCountups();
    wrapSheetClose();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.Motion = Motion;
})();

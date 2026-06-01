/* app.js — tab shell + Today / Program / Analytics / History / Settings,
 * manual-log modal, CSV import/export, recovery banner, next-day-feel prompt. */
(function () {
  'use strict';

  // ---- tiny DOM helpers -------------------------------------------------
  const $ = (sel, root) => (root || document).querySelector(sel);
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }
  const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const todayISO = () => new Date().toISOString().slice(0, 10);
  function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function kg(v) { return v == null ? '—' : v + ' kg'; }

  const App = { state: { tab: 'today', historyFilter: 'All' } };
  window.App = App;

  // ---- modal / sheet system --------------------------------------------
  App.closeSheet = function () { $('#modal-host').innerHTML = ''; };
  App.sheet = function (title, contentNodes, onClose) {
    const host = $('#modal-host');
    const overlay = el('div', { class: 'sheet-overlay', onclick: (e) => { if (e.target === overlay) { App.closeSheet(); onClose && onClose(); } } });
    const sheet = el('div', { class: 'sheet' });
    sheet.appendChild(el('button', { class: 'sheet-close', onclick: () => { App.closeSheet(); onClose && onClose(); } }, ['×']));
    if (title) sheet.appendChild(el('h2', null, [title]));
    contentNodes.forEach(c => sheet.appendChild(c));
    overlay.appendChild(sheet);
    host.appendChild(overlay);
    return sheet;
  };

  // stepper widget; opts {min,max,step,value,fmt,onChange}
  function stepper(opts) {
    let v = opts.value;
    const fmt = opts.fmt || (x => x);
    const val = el('span', { class: 'val' }, [String(fmt(v))]);
    function set(nv) {
      nv = Math.min(opts.max, Math.max(opts.min, Math.round(nv / opts.step) * opts.step));
      nv = Math.round(nv * 1000) / 1000;
      v = nv; val.textContent = String(fmt(v)); opts.onChange && opts.onChange(v);
    }
    const wrap = el('div', { class: 'stepper' }, [
      el('button', { onclick: () => set(v - opts.step) }, ['−']), val,
      el('button', { onclick: () => set(v + opts.step) }, ['+'])
    ]);
    wrap.getValue = () => v; wrap.setValue = set;
    return wrap;
  }
  App.stepper = stepper;

  function rating(n, value, onPick) {
    const wrap = el('div', { class: 'rate' });
    for (let i = 1; i <= n; i++) {
      const b = el('button', { class: i === value ? 'sel' : '' }, [String(i)]);
      b.addEventListener('click', () => {
        wrap.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel'); wrap._val = i; onPick && onPick(i);
      });
      wrap.appendChild(b);
    }
    wrap._val = value || null;
    wrap.getValue = () => wrap._val;
    return wrap;
  }
  App.rating = rating;

  // ---- derive today's plan ---------------------------------------------
  // Returns annotated generatedWeeks for the active cycle.
  App.getWeeks = function (cycle, wmFor) {
    return Calc.expandCycle(cycle).map(w => Calc.annotateWeekAnchors(w, wmFor));
  };

  App.buildPlan = function (cycle, weeks, dateIso, wmFor) {
    const wk = Calc.weekNumberFor(cycle, dateIso);
    const dow = DOW[new Date(dateIso + 'T00:00:00').getDay()];
    const structRole = (cycle.weeklyStructure || {})[dow] || 'Rest';
    if (wk == null) return { rest: true, reason: 'Outside cycle dates', week: wk };
    const week = weeks[wk - 1];
    if (!week) return { rest: true, week: wk };

    // Deload / test week special handling
    if (week.isDeloadTest) {
      if (structRole === 'Heavy') {
        return { rest: false, role: 'Test', week: wk, blockName: week.blockName,
          duration: week.testDurations[0], testDurations: week.testDurations,
          rpe: '9–9.5', protocol: 'test', sets: week.testDurations.length,
          anchor: null, note: 'Find max load held for the full duration @9–9.5. Update your Working Max after.' };
      }
      if (structRole === 'OIprimer' || structRole === 'Volume') {
        return { rest: false, role: 'Deload', week: wk, blockName: week.blockName,
          duration: 5, rpe: 6, protocol: 'deload', sets: 3, anchor: week.deloadAnchorKg,
          note: 'Easy deload — 3 sets @6 at 75% of 5s WM. Keep it light.' };
      }
      return { rest: true, week: wk, blockName: week.blockName, note: 'Deload/test week — rest.' };
    }

    if (structRole === 'Heavy') {
      return { rest: false, role: 'Heavy', week: wk, blockName: week.blockName,
        duration: week.heavyDuration, rpe: week.heavyRPE, protocol: week.heavyProtocol,
        sets: week.heavySets, anchor: week.heavyAnchorKg, backoffAnchor: week.backoffAnchorKg,
        wmMissing: week.wmMissing };
    }
    if (structRole === 'Volume') {
      return { rest: false, role: 'Volume', week: wk, blockName: week.blockName,
        duration: week.volumeDuration, rpe: '7–8', protocol: 'fixedVolume',
        sets: week.volumeSets, anchor: week.volumeAnchorKg, pct: week.volumePct };
    }
    if (structRole === 'OIprimer') {
      return { rest: false, role: 'OIprimer', week: wk, blockName: week.blockName,
        duration: null, rpe: null, protocol: 'oi', sets: week.oiSets, anchor: null,
        note: 'Overcoming isometrics — max-intent press/pull against a fixed surface, ~5s. Neural primer, then limit board.' };
    }
    return { rest: true, week: wk, blockName: week.blockName };
  };

  // ---- main router ------------------------------------------------------
  App.render = async function () {
    document.querySelectorAll('#tabbar .tab').forEach(t =>
      t.classList.toggle('sel', t.dataset.tab === App.state.tab));
    const view = $('#view');
    view.innerHTML = '';
    const fn = { today: renderToday, program: renderProgram, analytics: renderAnalytics,
                 history: renderHistory, settings: renderSettings }[App.state.tab];
    await fn(view);
    view.scrollTo ? view.scrollTo(0, 0) : window.scrollTo(0, 0);
  };
  App.go = function (tab) { App.state.tab = tab; App.render(); };

  async function wmForFn() {
    const [w5, w3, w7] = await Promise.all([DB.currentWM(5), DB.currentWM(3), DB.currentWM(7)]);
    const map = { 5: w5 && w5.valueKg, 3: w3 && w3.valueKg, 7: w7 && w7.valueKg };
    return (d) => (map[d] != null ? map[d] : null);
  }

  // =====================================================================
  // TODAY
  // =====================================================================
  async function renderToday(view) {
    const cycle = await DB.activeCycle();
    const wmFor = await wmForFn();
    if (!cycle) {
      view.appendChild(el('div', { class: 'card' }, ['No active cycle. Go to Program to activate one.']));
      return;
    }
    const weeks = App.getWeeks(cycle, wmFor);
    const plan = App.buildPlan(cycle, weeks, todayISO(), wmFor);

    // header
    const curWeek = weeks[(plan.week || 1) - 1];
    view.appendChild(el('h1', null, [curWeek ? `Week ${curWeek.weekNumber} · ${curWeek.blockName}` : cycle.name]));
    const nextTest = weeks.find(w => w.isDeloadTest && w.weekNumber >= (plan.week || 1));
    view.appendChild(el('p', { class: 'sub' }, [
      nextTest ? `Next benchmark test: Week ${nextTest.weekNumber} (${fmtDate(nextTest.startDate)})` : 'No upcoming test'
    ]));

    // pending next-day-feel prompt
    const pending = await DB.getMeta('pendingNextDayFeel');
    if (pending && todayISO() > pending.sessionDate) {
      const card = el('div', { class: 'card' });
      card.appendChild(el('div', { class: 'row' }, [el('strong', null, ['How do your fingers feel today?'])]));
      card.appendChild(el('p', { class: 'muted' }, [`After your ${fmtDate(pending.sessionDate)} session (1 = wrecked, 5 = fresh)`]));
      const r = rating(5, null, async (v) => {
        const entry = await DB.get('logEntries', pending.logEntryId);
        if (entry) { entry.nextDayFeel = v; await DB.put('logEntries', entry); }
        await DB.setMeta('pendingNextDayFeel', null);
        App.render();
      });
      card.appendChild(r);
      view.appendChild(card);
    }

    // recovery banner
    const logs = await DB.logsNewestFirst();
    const rec = Calc.recoveryFlag(logs);
    if (rec.flagged) {
      view.appendChild(el('div', { class: 'banner warn' }, [
        'Recovery trending down — consider dropping a set or taking an extra rest day. (Suggestion, not a rule.)'
      ]));
    }

    // session card
    if (plan.rest) {
      const next = upcomingSession(cycle, weeks, wmFor);
      view.appendChild(el('div', { class: 'card' }, [
        el('h2', null, ['Rest day']),
        el('p', { class: 'muted' }, [plan.note || 'No fingers today. Sleep + mobility.']),
        next ? el('p', null, [`Next session: ${next.label} — ${fmtDate(next.date)}`]) : el('span', null, [''])
      ]));
    } else {
      view.appendChild(sessionCard(plan));
    }

    // log-without-runner quick action
    view.appendChild(el('button', { class: 'btn secondary', onclick: () => App.openManualLog() }, ['Log a session manually']));
  }

  function sessionCard(plan) {
    const c = el('div', { class: 'card' });
    const roleLabel = { Heavy: 'Heavy yielding', Volume: 'Volume yielding', OIprimer: 'OI primer',
                        Test: 'Benchmark test', Deload: 'Deload' }[plan.role] || plan.role;
    c.appendChild(el('div', { class: 'row' }, [
      el('h2', { class: '' }, [roleLabel]),
      el('span', { class: 'pill accent' }, [plan.blockName || ''])
    ]));
    const meta = el('div', { class: 'chips' });
    if (plan.duration) meta.appendChild(el('span', { class: 'pill' }, [`${plan.duration}s hang`]));
    if (plan.rpe) meta.appendChild(el('span', { class: 'pill' }, [`@${plan.rpe}`]));
    if (plan.sets) meta.appendChild(el('span', { class: 'pill' }, [`${plan.sets} ${plan.role === 'Heavy' && plan.protocol === 'topSetPlusBackoffs' ? 'back-offs' : plan.protocol === 'maxSingles' ? 'singles' : 'sets'}`]));
    if (plan.protocol === 'maxSingles') meta.appendChild(el('span', { class: 'pill' }, ['max singles']));
    c.appendChild(meta);

    if (plan.anchor != null) {
      c.appendChild(el('div', { class: 'big-kg' }, [`Anchor: ~${plan.anchor} kg`]));
    } else if (plan.role === 'OIprimer') {
      c.appendChild(el('div', { class: 'big-kg' }, ['Bodyweight / max intent']));
    }
    if (plan.backoffAnchor != null) {
      c.appendChild(el('p', { class: 'muted' }, [`Back-offs around ~${plan.backoffAnchor} kg (@7–8, ~4–5 kg below top).`]));
    }
    if (plan.wmMissing) {
      c.appendChild(el('div', { class: 'banner danger' }, [`No ${plan.duration}s Working Max on file — set a benchmark for a correct anchor.`]));
    }

    // RPE-leads callout
    if (plan.role === 'Heavy' || plan.role === 'Test') {
      c.appendChild(el('div', { class: 'callout' }, [
        `Find today's @${plan.rpe}. This kg is a reference, not a target — RPE leads.`
      ]));
    }
    if (plan.role === 'Volume') {
      c.appendChild(el('div', { class: 'callout' }, [
        `Fixed ${plan.sets} sets — no extensions, even if it feels easy. Tendon management.`
      ]));
    }
    if (plan.note) c.appendChild(el('p', { class: 'muted' }, [plan.note]));

    c.appendChild(el('button', { class: 'btn', onclick: () => Runner.start(plan) }, ['Start Session']));
    return c;
  }

  function upcomingSession(cycle, weeks, wmFor) {
    for (let i = 1; i <= 14; i++) {
      const d = Calc.addDays(todayISO(), i);
      const p = App.buildPlan(cycle, weeks, d, wmFor);
      if (!p.rest) return { date: d, label: { Heavy: 'Heavy', Volume: 'Volume', OIprimer: 'OI primer', Test: 'Test', Deload: 'Deload' }[p.role] };
    }
    return null;
  }

  // =====================================================================
  // PROGRAM (timeline + builder toggle)
  // =====================================================================
  App.state.programView = 'timeline';
  async function renderProgram(view) {
    view.appendChild(el('h1', null, ['Program']));
    const toggle = el('div', { class: 'chips' }, [
      chip('Timeline', App.state.programView === 'timeline', () => { App.state.programView = 'timeline'; App.render(); }),
      chip('Builder', App.state.programView === 'builder', () => { App.state.programView = 'builder'; App.render(); })
    ]);
    view.appendChild(toggle);

    if (App.state.programView === 'builder') { await Builder.renderList(view); return; }

    const cycle = await DB.activeCycle();
    if (!cycle) { view.appendChild(el('div', { class: 'card' }, ['No active cycle.'])); return; }
    const wmFor = await wmForFn();
    const weeks = App.getWeeks(cycle, wmFor);
    const curWk = Calc.weekNumberFor(cycle, todayISO());
    const bandColor = { Transmutation: '#4f8ef7', Peak: '#ff6b6b', Accumulation: '#4ecb71',
                        Realization: '#b07bff', DeloadTest: '#f7b955', Custom: '#9a9aa8' };
    weeks.forEach(w => {
      const node = el('button', { class: 'tl-week list-item' + (w.weekNumber === curWk ? ' now' : ''),
        onclick: () => showWeekDetail(w) });
      node.classList.remove('list-item');
      node.appendChild(el('div', { class: 'row' }, [
        el('span', { class: 'wk' }, [`W${w.weekNumber} · ${w.blockName}`]),
        el('span', { class: 'tl-bandlabel', style: `background:${(bandColor[w.blockType] || '#888')}22;color:${bandColor[w.blockType] || '#888'}` },
          [w.isDeloadTest ? 'TEST' : w.blockType])
      ]));
      const line = w.isDeloadTest
        ? `Deload @6 + test ${w.testDurations.join('/')}s · anchor ~${kg(w.deloadAnchorKg)}`
        : `Heavy ${w.heavyDuration}s @${w.heavyRPE} ~${kg(w.heavyAnchorKg)} · Vol ${Math.round((w.volumePct || 0) * 100)}% ~${kg(w.volumeAnchorKg)}`;
      node.appendChild(el('p', { class: 'muted', style: 'margin:6px 0 0' }, [line]));
      view.appendChild(node);
    });
  }

  function showWeekDetail(w) {
    const body = [];
    body.push(el('p', { class: 'sub' }, [`${w.blockName} · ${fmtDate(w.startDate)}`]));
    if (w.isDeloadTest) {
      body.push(el('div', { class: 'card tight' }, [
        el('strong', null, ['Deload + Test']),
        el('p', { class: 'muted' }, [`Tue: 3 sets @6 deload (~${kg(w.deloadAnchorKg)}). Sat: test max @9–9.5 at ${w.testDurations.join(' & ')}s, then update Working Max.`])
      ]));
    } else {
      body.push(el('div', { class: 'card tight' }, [
        el('strong', null, ['Heavy (Sat)']),
        el('p', { class: 'muted' }, [`${w.heavyDuration}s · @${w.heavyRPE} · anchor ~${kg(w.heavyAnchorKg)} · ${w.heavyProtocol === 'maxSingles' ? w.heavySets + ' max singles, no back-offs' : w.heavySets + ' back-offs ~' + kg(w.backoffAnchorKg)}`])
      ]));
      body.push(el('div', { class: 'card tight' }, [
        el('strong', null, ['Volume (Thu)']),
        el('p', { class: 'muted' }, [`${w.volumeDuration}s · ${Math.round((w.volumePct || 0) * 100)}% of heavy · anchor ~${kg(w.volumeAnchorKg)} · ${w.volumeSets} sets (fixed)`])
      ]));
      body.push(el('div', { class: 'card tight' }, [
        el('strong', null, ['OI primer (Tue)']),
        el('p', { class: 'muted' }, [`${w.oiSets} sets max-intent isometrics + limit board.`])
      ]));
    }
    App.sheet(`Week ${w.weekNumber}`, body);
  }

  function chip(label, sel, onclick) { return el('button', { class: 'chip' + (sel ? ' sel' : ''), onclick }, [label]); }

  // =====================================================================
  // ANALYTICS (SVG charts)
  // =====================================================================
  async function renderAnalytics(view) {
    view.appendChild(el('h1', null, ['Analytics']));
    const logs = (await DB.logsNewestFirst()).slice().reverse(); // oldest -> newest
    const yielding = logs.filter(l => l.type === 'Yielding' && l.e1rmKg != null);

    // E1RM chart, two series by duration
    view.appendChild(el('h2', null, ['E1RM trend']));
    const s5 = yielding.filter(l => l.hangDurationSeconds === 5).map(l => ({ x: l.date, y: l.e1rmKg }));
    const s3 = yielding.filter(l => l.hangDurationSeconds === 3).map(l => ({ x: l.date, y: l.e1rmKg }));
    if (!s5.length && !s3.length) {
      view.appendChild(el('div', { class: 'card' }, ['Log Yielding sessions with load + RPE to see E1RM trends.']));
    } else {
      const card = el('div', { class: 'card' });
      card.appendChild(el('div', { class: 'legend' }, [
        el('span', null, [el('span', { class: 'sw', style: 'background:#4f8ef7' }), '5s E1RM']),
        el('span', null, [el('span', { class: 'sw', style: 'background:#ff6b6b' }), '3s E1RM'])
      ]));
      card.appendChild(lineChart([{ pts: s5, color: '#4f8ef7' }, { pts: s3, color: '#ff6b6b' }], 'kg'));
      view.appendChild(card);
    }

    // weekly volume load bars
    view.appendChild(el('h2', null, ['Weekly volume load']));
    const byWeek = {};
    logs.forEach(l => {
      if (l.type !== 'Yielding' || l.topSetLoadKg == null || !l.sets) return;
      const wk = isoWeekKey(l.date);
      byWeek[wk] = (byWeek[wk] || 0) + l.topSetLoadKg * l.sets;
    });
    const bars = Object.keys(byWeek).sort().map(k => ({ label: k.slice(5), value: Math.round(byWeek[k]) }));
    view.appendChild(bars.length ? el('div', { class: 'card' }, [barChart(bars, 'kg·sets')])
      : el('div', { class: 'card' }, ['No volume data yet.']));

    // recovery trend
    view.appendChild(el('h2', null, ['Recovery (next-day feel)']));
    const ndf = logs.filter(l => l.nextDayFeel != null).slice(-20).map(l => ({ x: l.date, y: l.nextDayFeel }));
    view.appendChild(ndf.length ? el('div', { class: 'card' }, [recoveryChart(ndf)])
      : el('div', { class: 'card' }, ['No next-day-feel data yet.']));

    // benchmark history table
    view.appendChild(el('h2', null, ['Benchmark history']));
    const benches = (await DB.getAll('benchmarks')).sort((a, b) => a.date < b.date ? 1 : -1);
    if (!benches.length) {
      view.appendChild(el('div', { class: 'card' }, ['No benchmark tests logged yet. Test weeks update your Working Max here.']));
    } else {
      const t = el('table', { class: 'prev' });
      t.appendChild(el('tr', { html: '<th>Date</th><th>Dur</th><th>Max kg</th><th>RPE</th><th>Δ</th>' }));
      let prevByDur = {};
      benches.slice().reverse().forEach(b => {
        const d = prevByDur[b.durationSeconds] != null ? (b.maxLoadKg - prevByDur[b.durationSeconds]) : null;
        prevByDur[b.durationSeconds] = b.maxLoadKg;
      });
      // recompute deltas newest-first display
      const asc = benches.slice().reverse(); let last = {};
      const deltas = {};
      asc.forEach(b => { deltas[b.id] = last[b.durationSeconds] != null ? b.maxLoadKg - last[b.durationSeconds] : null; last[b.durationSeconds] = b.maxLoadKg; });
      benches.forEach(b => {
        t.appendChild(el('tr', { html:
          `<td>${fmtDate(b.date)}</td><td>${b.durationSeconds}s</td><td>${b.maxLoadKg}</td><td>@${b.rpe}</td><td>${deltas[b.id] == null ? '—' : (deltas[b.id] >= 0 ? '+' : '') + deltas[b.id]}</td>` }));
      });
      view.appendChild(el('div', { class: 'card' }, [t]));
    }
  }

  function isoWeekKey(iso) {
    const d = new Date(iso + 'T00:00:00');
    const day = (d.getDay() + 6) % 7; // Mon=0
    d.setDate(d.getDate() - day);
    return d.toISOString().slice(0, 10);
  }

  // ---- SVG chart builders ----------------------------------------------
  function svgNS(tag, attrs) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function lineChart(series, unit) {
    const W = 600, H = 260, pad = 36;
    const all = series.flatMap(s => s.pts);
    const dates = Array.from(new Set(all.map(p => p.x))).sort();
    const ys = all.map(p => p.y);
    const ymin = Math.min.apply(null, ys) - 1, ymax = Math.max.apply(null, ys) + 1;
    const xFor = (x) => pad + (dates.length <= 1 ? 0.5 : dates.indexOf(x) / (dates.length - 1)) * (W - 2 * pad);
    const yFor = (y) => H - pad - ((y - ymin) / (ymax - ymin || 1)) * (H - 2 * pad);
    const svg = svgNS('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
    // axes
    svg.appendChild(svgNS('line', { x1: pad, y1: H - pad, x2: W - pad, y2: H - pad, stroke: '#333', 'stroke-width': 1 }));
    [ymin, (ymin + ymax) / 2, ymax].forEach(yv => {
      svg.appendChild(svgNS('text', { x: 4, y: yFor(yv) + 4, fill: '#777', 'font-size': 11 })).textContent = yv.toFixed(0);
    });
    series.forEach(s => {
      if (s.pts.length === 0) return;
      let d = '';
      s.pts.forEach((p, i) => { d += (i ? ' L' : 'M') + xFor(p.x) + ' ' + yFor(p.y); });
      svg.appendChild(svgNS('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
      s.pts.forEach(p => svg.appendChild(svgNS('circle', { cx: xFor(p.x), cy: yFor(p.y), r: 3.5, fill: s.color })));
    });
    return svg;
  }
  function barChart(bars, unit) {
    const W = 600, H = 220, pad = 32;
    const max = Math.max.apply(null, bars.map(b => b.value)) || 1;
    const bw = (W - 2 * pad) / bars.length;
    const svg = svgNS('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
    bars.forEach((b, i) => {
      const h = (b.value / max) * (H - 2 * pad);
      svg.appendChild(svgNS('rect', { x: pad + i * bw + 4, y: H - pad - h, width: bw - 8, height: h, rx: 3, fill: '#4f8ef7' }));
      const tx = svgNS('text', { x: pad + i * bw + bw / 2, y: H - pad + 14, fill: '#777', 'font-size': 10, 'text-anchor': 'middle' }); tx.textContent = b.label; svg.appendChild(tx);
    });
    return svg;
  }
  function recoveryChart(pts) {
    const W = 600, H = 200, pad = 28;
    const xFor = (i) => pad + (pts.length <= 1 ? 0.5 : i / (pts.length - 1)) * (W - 2 * pad);
    const yFor = (y) => H - pad - ((y - 1) / 4) * (H - 2 * pad);
    const svg = svgNS('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
    // zones: green>=4, amber 3, red<=2
    [['#4ecb71', 4, 5], ['#f7b955', 3, 4], ['#ff6b6b', 1, 3]].forEach(z => {
      svg.appendChild(svgNS('rect', { x: pad, y: yFor(z[2]), width: W - 2 * pad, height: yFor(z[1]) - yFor(z[2]), fill: z[0], opacity: 0.08 }));
    });
    let d = '';
    pts.forEach((p, i) => { d += (i ? ' L' : 'M') + xFor(i) + ' ' + yFor(p.y); });
    svg.appendChild(svgNS('path', { d, fill: 'none', stroke: '#f0f0f5', 'stroke-width': 2 }));
    pts.forEach((p, i) => svg.appendChild(svgNS('circle', { cx: xFor(i), cy: yFor(p.y), r: 3,
      fill: p.y >= 4 ? '#4ecb71' : p.y === 3 ? '#f7b955' : '#ff6b6b' })));
    return svg;
  }

  // =====================================================================
  // HISTORY
  // =====================================================================
  async function renderHistory(view) {
    view.appendChild(el('div', { class: 'row' }, [
      el('h1', null, ['History']),
      el('button', { class: 'btn small secondary', onclick: () => App.openManualLog() }, ['+ Log'])
    ]));
    const filters = ['All', 'Yielding', 'OI', 'Climbing', 'Heavy', 'Volume'];
    const chips = el('div', { class: 'chips' });
    filters.forEach(f => chips.appendChild(chip(f, App.state.historyFilter === f, () => { App.state.historyFilter = f; App.render(); })));
    view.appendChild(chips);
    view.appendChild(el('button', { class: 'btn small ghost', onclick: () => App.importCSV() }, ['Import CSV']));

    let logs = await DB.logsNewestFirst();
    const f = App.state.historyFilter;
    if (f !== 'All') logs = logs.filter(l => l.type === f || l.role === f);
    if (!logs.length) { view.appendChild(el('div', { class: 'card' }, ['No entries.'])); return; }
    logs.forEach(l => {
      const item = el('button', { class: 'list-item', onclick: () => App.openManualLog(l) });
      item.appendChild(el('div', { class: 'li-top' }, [
        el('span', { class: 'li-date' }, [fmtDate(l.date)]),
        el('span', { class: 'muted' }, [`${l.role || l.type} · ${l.venue || ''}`])
      ]));
      const bits = [];
      if (l.topSetLoadKg != null) bits.push(`${l.topSetLoadKg}kg @${l.topSetRPE || '?'}`);
      if (l.e1rmKg != null) bits.push(`E1RM ${l.e1rmKg}`);
      if (l.sets != null) bits.push(`${l.sets} sets`);
      item.appendChild(el('p', { class: 'muted', style: 'margin:4px 0 0' }, [bits.join(' · ') || (l.notes || '')]));
      if (bits.length && l.notes) item.appendChild(el('p', { class: 'muted', style: 'margin:2px 0 0;opacity:.8' }, [l.notes]));
      view.appendChild(item);
    });
  }

  // =====================================================================
  // SETTINGS
  // =====================================================================
  async function renderSettings(view) {
    view.appendChild(el('h1', null, ['Settings']));
    const [w5, w3] = await Promise.all([DB.currentWM(5), DB.currentWM(3)]);

    view.appendChild(wmEditor('5s Working Max', 5, w5));
    view.appendChild(wmEditor('3s Working Max', 3, w3));

    // WM history
    const allWM = (await DB.getAll('workingMaxes')).sort((a, b) => a.date < b.date ? 1 : -1);
    if (allWM.length) {
      const c = el('div', { class: 'card' }, [el('h2', { style: 'margin-top:0' }, ['WM history'])]);
      allWM.forEach(w => c.appendChild(el('p', { class: 'muted' }, [`${w.durationSeconds}s · ${w.valueKg} kg · ${fmtDate(w.date)} · ${w.source}`])));
      view.appendChild(c);
    }

    // rest durations
    const cycle = await DB.activeCycle();
    const backoffRest = await DB.getMeta('restBackoff') || 180;
    const peakRest = await DB.getMeta('restPeak') || 270;
    const c2 = el('div', { class: 'card' });
    c2.appendChild(el('h2', { style: 'margin-top:0' }, ['Rest durations']));
    const boStep = stepper({ min: 30, max: 600, step: 15, value: backoffRest, fmt: s => s + 's', onChange: v => DB.setMeta('restBackoff', v) });
    const pkStep = stepper({ min: 30, max: 600, step: 15, value: peakRest, fmt: s => s + 's', onChange: v => DB.setMeta('restPeak', v) });
    c2.appendChild(el('div', { class: 'field' }, [el('label', null, ['Back-off / volume rest']), boStep]));
    c2.appendChild(el('div', { class: 'field' }, [el('label', null, ['Peak singles rest']), pkStep]));
    view.appendChild(c2);

    // cycle start date
    if (cycle) {
      const c3 = el('div', { class: 'card' });
      c3.appendChild(el('h2', { style: 'margin-top:0' }, ['Cycle']));
      const di = el('input', { type: 'date', value: cycle.startDate });
      di.addEventListener('change', async () => { cycle.startDate = di.value; await DB.put('cycles', cycle); });
      c3.appendChild(el('div', { class: 'field' }, [el('label', null, [`Start date · ${cycle.name}`]), di]));
      c3.appendChild(el('p', { class: 'muted' }, ['Units: kg']));
      view.appendChild(c3);
    }

    view.appendChild(el('button', { class: 'btn secondary', onclick: () => App.exportCSV() }, ['Export CSV']));
    view.appendChild(el('div', { class: 'spacer' }));
    view.appendChild(el('button', { class: 'btn danger', onclick: () => App.resetData() }, ['Reset all data']));
    view.appendChild(el('p', { class: 'muted center', style: 'margin-top:18px' }, ['Finger Trainer · offline PWA · single user']));
  }

  function wmEditor(label, duration, current) {
    const c = el('div', { class: 'card' });
    c.appendChild(el('div', { class: 'row' }, [el('h2', { style: 'margin:0' }, [label]),
      el('span', { class: 'muted' }, [current ? fmtDate(current.date) : 'not set'])]));
    const st = stepper({ min: 0, max: 80, step: 0.5, value: current ? current.valueKg : (duration === 5 ? 25 : 0), fmt: v => v + ' kg' });
    c.appendChild(el('div', { class: 'field' }, [st]));
    c.appendChild(el('button', { class: 'btn small', onclick: async () => {
      const newVal = st.getValue();
      const cur = current ? current.valueKg : null;
      const guard = Calc.wmJumpGuard(newVal, cur);
      const save = async () => {
        await DB.put('workingMaxes', { id: Templates.uid(), durationSeconds: duration, valueKg: newVal,
          date: todayISO(), source: 'manual', notes: '' });
        App.render();
      };
      if (guard.triggered) {
        App.confirm(`That's a big jump (+${guard.pct}%). Was this a clean @9–9.5 with a touch in reserve? If it felt like an absolute ceiling, consider entering 1–2 kg lower to protect your tendons.`,
          'Save anyway', save);
      } else { await save(); }
    } }, ['Save WM']));
    return c;
  }

  App.confirm = function (msg, okLabel, onOk, onCancel) {
    App.sheet('', [
      el('p', null, [msg]),
      el('button', { class: 'btn', onclick: () => { App.closeSheet(); onOk && onOk(); } }, [okLabel || 'OK']),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn secondary', onclick: () => { App.closeSheet(); onCancel && onCancel(); } }, ['Cancel'])
    ], onCancel);
  };

  // =====================================================================
  // MANUAL LOG MODAL (also used for editing)
  // =====================================================================
  App.openManualLog = function (existing) {
    const e = existing || {};
    const body = [];
    const state = {
      date: e.date || todayISO(), type: e.type || 'Yielding', role: e.role || 'Heavy',
      venue: e.venue || 'Board', hangDurationSeconds: e.hangDurationSeconds || 5,
      grip: e.grip || 'HalfCrimp', load: e.topSetLoadKg, rpe: e.topSetRPE,
      sets: e.sets, taxing: e.taxing, felt: e.feltStrong, ndf: e.nextDayFeel, notes: e.notes || ''
    };
    // date
    const dInput = el('input', { type: 'date', value: state.date });
    dInput.addEventListener('change', () => state.date = dInput.value);
    body.push(el('div', { class: 'field' }, [el('label', null, ['Date']), dInput]));

    // type / role / venue selects
    body.push(selectField('Type', ['Yielding', 'OI', 'Climbing'], state.type, v => { state.type = v; updE1RM(); }));
    body.push(selectField('Role', ['Heavy', 'Volume', 'OIprimer', 'Climb', 'Test', 'Deload'], state.role, v => state.role = v));
    body.push(selectField('Venue', ['Board', 'Gym', 'Outdoor', 'Home', 'Beastmaker', 'Other'], state.venue, v => state.venue = v));
    body.push(selectField('Hang duration', ['5', '3', '7'], String(state.hangDurationSeconds), v => { state.hangDurationSeconds = +v; }));
    body.push(selectField('Grip', ['HalfCrimp', 'OpenHand', 'ThreeFingerDrag'], state.grip, v => state.grip = v));

    // load + rpe steppers
    const loadSt = stepper({ min: 0, max: 80, step: 0.5, value: state.load || 0, fmt: v => v + ' kg', onChange: v => { state.load = v; updE1RM(); } });
    const rpeSt = stepper({ min: 6, max: 10, step: 0.25, value: state.rpe || 8, fmt: v => '@' + v, onChange: v => { state.rpe = v; updE1RM(); } });
    const setsSt = stepper({ min: 0, max: 10, step: 1, value: state.sets || 3, onChange: v => state.sets = v });
    body.push(el('div', { class: 'grid2' }, [
      el('div', { class: 'field' }, [el('label', null, ['Top set load']), loadSt]),
      el('div', { class: 'field' }, [el('label', null, ['Top set RPE']), rpeSt])
    ]));
    body.push(el('div', { class: 'field' }, [el('label', null, ['Sets']), setsSt]));
    const e1rmLine = el('p', { class: 'muted' }, ['']);
    body.push(e1rmLine);
    function updE1RM() {
      const v = state.type === 'Yielding' ? Calc.e1rm(loadSt.getValue(), rpeSt.getValue()) : null;
      e1rmLine.textContent = v != null ? `E1RM: ${v} kg` : '';
    }
    updE1RM();

    // ratings
    const taxR = rating(5, state.taxing, v => state.taxing = v);
    const feltR = rating(10, state.felt, v => state.felt = v);
    body.push(el('div', { class: 'field' }, [el('label', null, ['Session taxing (1–5)']), taxR]));
    body.push(el('div', { class: 'field' }, [el('label', null, ['Felt strong (1–10)']), feltR]));

    const notes = el('textarea', { placeholder: 'Notes' }); notes.value = state.notes;
    notes.addEventListener('input', () => state.notes = notes.value);
    body.push(el('div', { class: 'field' }, [el('label', null, ['Notes']), notes]));

    body.push(el('button', { class: 'btn', onclick: async () => {
      const entry = {
        id: e.id || Templates.uid(), date: state.date, type: state.type, role: state.role, venue: state.venue,
        hangDurationSeconds: state.type === 'Yielding' ? state.hangDurationSeconds : null, grip: state.grip,
        topSetLoadKg: state.type === 'Yielding' ? loadSt.getValue() : null,
        topSetRPE: state.type === 'Yielding' ? rpeSt.getValue() : null,
        sets: setsSt.getValue(), bodyweightKg: e.bodyweightKg || null,
        taxing: taxR.getValue(), feltStrong: feltR.getValue(), nextDayFeel: state.ndf != null ? state.ndf : (e.nextDayFeel || null),
        block: e.block || blockNameFor(state.date), notes: state.notes
      };
      await DB.addLog(entry);
      // benchmark capture for Test role
      if (entry.role === 'Test' && entry.topSetLoadKg) await maybeBenchmark(entry);
      App.closeSheet(); App.render();
    } }, [existing ? 'Save changes' : 'Save session']));

    if (existing) body.push(el('button', { class: 'btn danger', style: 'margin-top:8px', onclick: async () => {
      App.confirm('Delete this entry?', 'Delete', async () => { await DB.del('logEntries', e.id); App.closeSheet(); App.render(); });
    } }, ['Delete']));

    App.sheet(existing ? 'Edit session' : 'Log session', body);
  };

  function selectField(label, opts, value, onChange) {
    const sel = el('select');
    opts.forEach(o => { const op = el('option', { value: o }, [o]); if (o === value) op.selected = true; sel.appendChild(op); });
    sel.addEventListener('change', () => onChange(sel.value));
    return el('div', { class: 'field' }, [el('label', null, [label]), sel]);
  }

  async function blockNameFor(dateIso) {
    const cycle = await DB.activeCycle();
    if (!cycle) return '';
    const wk = Calc.weekNumberFor(cycle, dateIso);
    if (!wk) return '';
    const weeks = Calc.expandCycle(cycle);
    return weeks[wk - 1] ? weeks[wk - 1].blockName : '';
  }

  async function maybeBenchmark(entry) {
    const dur = entry.hangDurationSeconds || 5;
    const cur = await DB.currentWM(dur);
    await DB.put('benchmarks', { id: Templates.uid(), date: entry.date, durationSeconds: dur,
      maxLoadKg: entry.topSetLoadKg, rpe: entry.topSetRPE, resultingWMId: null });
    // offer to update WM
    const guard = Calc.wmJumpGuard(entry.topSetLoadKg, cur && cur.valueKg);
    const apply = async () => {
      await DB.put('workingMaxes', { id: Templates.uid(), durationSeconds: dur, valueKg: entry.topSetLoadKg,
        date: entry.date, source: 'test', notes: 'From benchmark test' });
      App.render();
    };
    if (guard.triggered) {
      App.confirm(`Test logged. That's a big jump (+${guard.pct}%) for your ${dur}s WM. Update it to ${entry.topSetLoadKg} kg? If it felt like an absolute ceiling, consider 1–2 kg lower.`, `Set ${dur}s WM`, apply);
    } else {
      App.confirm(`Test logged. Update your ${dur}s Working Max to ${entry.topSetLoadKg} kg?`, `Set ${dur}s WM`, apply);
    }
  }
  App.maybeBenchmark = maybeBenchmark;

  // =====================================================================
  // CSV IMPORT / EXPORT (§14)
  // =====================================================================
  const CSV_HEADER = 'date,type,role,venue,hangDurationSeconds,loadKg,rpe,sets,taxing,feltStrong,nextDayFeel,block,notes,e1rmKg';
  App.exportCSV = async function () {
    const logs = (await DB.logsNewestFirst()).slice().reverse();
    const rows = [CSV_HEADER];
    logs.forEach(l => {
      rows.push([l.date, l.type, l.role || '', l.venue || '', l.hangDurationSeconds ?? '',
        l.topSetLoadKg ?? '', l.topSetRPE ?? '', l.sets ?? '', l.taxing ?? '', l.feltStrong ?? '',
        l.nextDayFeel ?? '', csvq(l.block || ''), csvq(l.notes || ''), l.e1rmKg ?? ''].join(','));
    });
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `finger-trainer-${todayISO()}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
  };
  function csvq(s) { return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  App.importCSV = function () {
    const input = el('input', { type: 'file', accept: '.csv,text/csv' });
    input.addEventListener('change', () => {
      const file = input.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => { await doImport(reader.result); };
      reader.readAsText(file);
    });
    input.click();
  };
  async function doImport(text) {
    const lines = parseCSV(text);
    if (!lines.length) return;
    const header = lines[0].map(h => h.trim());
    const idx = {}; header.forEach((h, i) => idx[h] = i);
    const existing = await DB.getAll('logEntries');
    const seen = new Set(existing.map(e => e.date + '|' + (e.role || '')));
    let added = 0, skipped = 0;
    for (let r = 1; r < lines.length; r++) {
      const c = lines[r]; if (!c.length || !c[idx.date]) continue;
      const type = c[idx.type] || 'Yielding';
      const role = c[idx.role] || '';
      const key = c[idx.date] + '|' + role;
      if (seen.has(key)) { skipped++; continue; }
      let dur = c[idx.hangDurationSeconds] ? +c[idx.hangDurationSeconds] : (type === 'Yielding' ? 5 : null);
      const load = c[idx.loadKg] !== '' ? +c[idx.loadKg] : null;
      const rpe = c[idx.rpe] !== '' ? +c[idx.rpe] : null;
      let e1 = c[idx.e1rmKg] !== '' && c[idx.e1rmKg] != null ? +c[idx.e1rmKg] : null;
      if (e1 == null && type === 'Yielding') e1 = Calc.e1rm(load, rpe);
      await DB.put('logEntries', {
        id: Templates.uid(), date: c[idx.date], type, role, venue: c[idx.venue] || '',
        hangDurationSeconds: dur, grip: 'HalfCrimp', topSetLoadKg: load, topSetRPE: rpe,
        sets: c[idx.sets] !== '' ? +c[idx.sets] : null, bodyweightKg: null,
        taxing: c[idx.taxing] !== '' ? +c[idx.taxing] : null,
        feltStrong: c[idx.feltStrong] !== '' ? +c[idx.feltStrong] : null,
        nextDayFeel: c[idx.nextDayFeel] !== '' ? +c[idx.nextDayFeel] : null,
        block: c[idx.block] || '', notes: c[idx.notes] || '', e1rmKg: e1
      });
      seen.add(key); added++;
    }
    App.confirm(`Import complete: ${added} added, ${skipped} skipped (duplicate date+role).`, 'OK', () => App.render());
  }
  // minimal CSV parser (handles quoted fields + commas + escaped quotes)
  function parseCSV(text) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else {
        if (ch === '"') q = true;
        else if (ch === ',') { row.push(cur); cur = ''; }
        else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else if (ch === '\r') { /* skip */ }
        else cur += ch;
      }
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
  }

  App.resetData = function () {
    App.confirm('Reset ALL data? This deletes every log, working max, and cycle.', 'Continue', () => {
      App.confirm('Are you absolutely sure? This cannot be undone.', 'Delete everything', async () => {
        await DB.resetAll(); await DB.seedIfEmpty(); App.go('today');
      });
    });
  };

  // ---- session-end logging (called by Runner) --------------------------
  App.logSession = async function (plan, result) {
    const entry = {
      id: Templates.uid(), date: todayISO(), type: plan.role === 'OIprimer' ? 'OI' : 'Yielding',
      role: plan.role, venue: 'Board', hangDurationSeconds: plan.duration || null, grip: 'HalfCrimp',
      topSetLoadKg: result.load != null ? result.load : null,
      topSetRPE: result.rpe != null ? result.rpe : null, sets: result.sets,
      bodyweightKg: null, taxing: result.taxing, feltStrong: result.felt, nextDayFeel: null,
      block: plan.blockName || '', notes: result.notes || ''
    };
    await DB.addLog(entry);
    await DB.setMeta('pendingNextDayFeel', { logEntryId: entry.id, sessionDate: entry.date });
    if (plan.role === 'Test' && entry.topSetLoadKg) await maybeBenchmark(entry);
    App.go('today');
  };

  // ---- boot -------------------------------------------------------------
  document.querySelectorAll('#tabbar .tab').forEach(t =>
    t.addEventListener('click', () => App.go(t.dataset.tab)));

  (async function init() {
    await DB.seedIfEmpty();
    App.go('today');
  })();
})();

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
  // Local calendar date (NOT UTC). Using toISOString() directly stamps an
  // evening session in a behind-UTC timezone onto the next day, which then
  // mismatches the day-of-week the rest of the app derives from the date.
  const todayISO = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  };
  function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function kg(v) { return v == null ? '—' : v + ' kg'; }

  const App = { state: { tab: 'today', historyFilter: 'All' } };
  window.App = App;

  // ---- modal / sheet system --------------------------------------------
  App.closeSheet = function () {
    const overlay = $('#modal-host .sheet-overlay');
    if (overlay) {
      overlay.remove();
    } else {
      $('#modal-host').innerHTML = '';
    }
  };
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
        const multiTest = week.testDurations && week.testDurations.length > 1;
        const primaryNote = multiTest
          ? `Find max load for ${week.testDurations[0]}s @9–9.5. This is the primary test (cycle report card). Come back tomorrow for the ${week.testDurations[1]}s test — full night's rest between.`
          : 'Find max load held for the full duration @9–9.5. Update your Working Max after.';
        return { rest: false, role: 'Test', week: wk, blockName: week.blockName,
          duration: week.testDurations[0], testDurations: week.testDurations,
          rpe: '9–9.5', protocol: 'test', sets: 1, anchor: null, note: primaryNote };
      }
      // Only the OI primer slot gets the deload session — Volume (Thu) stays rest
      // so fingers are fresh for Saturday's benchmark test.
      if (structRole === 'OIprimer') {
        return { rest: false, role: 'Deload', week: wk, blockName: week.blockName,
          duration: 5, rpe: 6, protocol: 'deload', sets: 3, anchor: week.deloadAnchorKg,
          note: 'Easy deload — 3 sets @6 at 75% of 5s WM. Keep it light.' };
      }
      // Day immediately after Heavy = secondary test (if multiple durations, e.g. W15 5s Sat + 3s Sun)
      if (structRole === 'Rest' && week.testDurations && week.testDurations.length > 1) {
        const ws = cycle.weeklyStructure || {};
        const heavyDow = Object.keys(ws).find(d => ws[d] === 'Heavy');
        const heavyIdx = heavyDow ? DOW.indexOf(heavyDow) : -1;
        const dowIdx = DOW.indexOf(dow);
        if (heavyIdx >= 0 && (dowIdx - heavyIdx + 7) % 7 === 1) {
          const secDur = week.testDurations[1];
          return { rest: false, role: 'Test', week: wk, blockName: week.blockName,
            duration: secDur, testDurations: [secDur],
            rpe: '9–9.5', protocol: 'test', sets: 1, anchor: null,
            note: `Secondary benchmark (${secDur}s) — full rest since yesterday's ${week.testDurations[0]}s test. Find max load @9–9.5. This result anchors next cycle's Peak WM.` };
        }
      }
      return { rest: true, week: wk, blockName: week.blockName, note: 'Deload/test week — rest today.' };
    }

    // isLastBlockWeek: true if the next week belongs to a different block (used for Peak W14 guidance)
    const isLastBlockWeek = !weeks[wk] || weeks[wk].blockName !== week.blockName;

    if (structRole === 'Heavy') {
      return { rest: false, role: 'Heavy', week: wk, blockName: week.blockName,
        duration: week.heavyDuration, rpe: week.heavyRPE, protocol: week.heavyProtocol,
        sets: week.heavySets, anchor: week.heavyAnchorKg, backoffAnchor: week.backoffAnchorKg,
        warmup: week.warmup, isLastBlockWeek, wmMissing: week.wmMissing };
    }
    if (structRole === 'Volume') {
      return { rest: false, role: 'Volume', week: wk, blockName: week.blockName,
        duration: week.volumeDuration, rpe: '7–8', protocol: 'fixedVolume',
        sets: week.volumeSets, anchor: week.volumeAnchorKg, pct: week.volumePct };
    }
    if (structRole === 'OIprimer') {
      return { rest: false, role: 'OIprimer', week: wk, blockName: week.blockName,
        duration: null, rpe: null, protocol: 'oi', sets: week.oiSets === 3 ? '3-5' : week.oiSets, anchor: null,
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
    try {
      await fn(view);
    } catch (err) {
      // Error boundary: a single corrupt record must not leave a blank screen.
      console.error('Render error:', err);
      view.innerHTML = '';
      view.appendChild(el('div', { class: 'card' }, [
        el('h2', { style: 'margin-top:0' }, ['Something went wrong']),
        el('p', { class: 'muted' }, [String((err && err.message) || err)]),
        el('button', { class: 'btn secondary', onclick: () => App.render() }, ['Retry']),
        el('button', { class: 'btn ghost small', onclick: () => App.go('settings') }, ['Open Settings'])
      ]));
    }
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
    // If we're showing a cycle that isn't actually flagged active (read-time
    // self-heal kicked in), offer a one-tap fix to make it official.
    if (cycle.status !== 'active') {
      const banner = el('div', { class: 'banner warn' }, [
        `Showing "${cycle.name}", but no cycle is marked active on this device. `,
        el('button', { class: 'btn small', style: 'margin:8px 0 0', onclick: () => Builder.activate(cycle) }, ['Set as active cycle'])
      ]);
      view.appendChild(banner);
    }

    const weeks = App.getWeeks(cycle, wmFor);
    const plan = App.buildPlan(cycle, weeks, todayISO(), wmFor);

    // header
    const curWeek = weeks[(plan.week || 1) - 1];
    const nextTest = weeks.find(w => w.isDeloadTest && w.weekNumber >= (plan.week || 1));
    const headerRow = el('div', { class: 'brand-header' }, [
      el('img', { class: 'brand-logo', src: 'icons/icon-192.png', alt: 'Finger Trainer Logo' }),
      el('div', { class: 'brand-info' }, [
        el('h1', null, [curWeek ? `Week ${curWeek.weekNumber} · ${curWeek.blockName}` : cycle.name]),
        el('p', { class: 'sub' }, [
          nextTest ? `Next benchmark test: Week ${nextTest.weekNumber} (${fmtDate(nextTest.startDate)})` : 'No upcoming test'
        ])
      ])
    ]);
    view.appendChild(headerRow);

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
    const deload = Calc.deloadTrend(logs);
    if (deload.flagged) {
      view.appendChild(el('div', { class: 'banner warn' }, [deload.message]));
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

    // pick a different workout
    view.appendChild(el('button', { class: 'btn secondary', onclick: () => showWorkoutPicker(cycle, weeks, wmFor, plan) }, ['Do a different workout →']));

    // log-without-runner quick action
    view.appendChild(el('button', { class: 'btn secondary', onclick: () => App.openManualLog() }, ['Log a session manually']));
  }

  function showWorkoutPicker(cycle, weeks, wmFor, todayPlan) {
    const weekNum = (todayPlan && todayPlan.week) || 1;
    // Walk the 7 days of this cycle-week and collect any non-rest plans
    const weekStartIso = Calc.addDays(cycle.startDate, (weekNum - 1) * 7);
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const roleLabelMap = { Heavy: 'Heavy yielding', Volume: 'Volume yielding', OIprimer: 'OI primer',
                           Test: 'Benchmark test', Deload: 'Deload' };

    const options = [];
    for (let i = 0; i < 7; i++) {
      const dateIso = Calc.addDays(weekStartIso, i);
      const p = App.buildPlan(cycle, weeks, dateIso, wmFor);
      if (!p.rest) {
        const dayName = DAY_NAMES[new Date(dateIso + 'T00:00:00').getDay()];
        options.push({ dayName, plan: p });
      }
    }

    if (!options.length) {
      App.sheet("This week's workouts", [el('p', { class: 'muted' }, ['No sessions scheduled this week.'])]);
      return;
    }

    const body = options.map(({ dayName, plan }) => {
      const label = roleLabelMap[plan.role] || plan.role;
      const btn = el('button', { class: 'list-item', onclick: () => { App.closeSheet(); Runner.start(plan); } });
      btn.appendChild(el('div', { class: 'row' }, [
        el('strong', null, [dayName]),
        el('span', { class: 'pill accent' }, [label])
      ]));
      const bits = [];
      if (plan.duration) bits.push(plan.duration + 's');
      if (plan.rpe) bits.push('@' + plan.rpe);
      if (plan.sets) bits.push(plan.sets + ' sets');
      if (plan.anchor != null) bits.push('~' + plan.anchor + ' kg');
      if (bits.length) btn.appendChild(el('p', { class: 'muted', style: 'margin:4px 0 0' }, [bits.join(' · ')]));
      return btn;
    });

    App.sheet("This week's workouts", body);
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

    // Fixed warm-up ladder (shown when the program defines one)
    if (plan.warmup && plan.warmup.length) {
      const ladder = plan.warmup.map((s, i) => `Set ${i + 1}: +${s.load}kg @${s.rpe}`).join('  ·  ');
      c.appendChild(el('div', { class: 'callout' }, [`Warm-up ladder (fixed · ${plan.duration}s · 2–3 min rest): ${ladder}. Prime the flexors, don't fatigue.`]));
      const last = plan.warmup[plan.warmup.length - 1];
      c.appendChild(el('p', { class: 'muted' }, [`Readiness check at +${last.load}kg: feels @8+ → reduce top-set expectation · @9+ or any joint discomfort → warm-up only, then go climb.`]));
    }

    // RPE-leads callout / autoregulation guidance
    if (plan.protocol === 'maxSingles' && plan.role === 'Heavy') {
      // Peak block: 3s max singles — specific autoregulation rules from program
      c.appendChild(el('div', { class: 'callout' }, [
        'Load off warmup feel: @7 → +2.5–5 kg from last session · @8 → match or +1–2.5 kg · @8.5+ → hold or back off.'
      ]));
      const rpeNote = plan.isLastBlockWeek
        ? '@9.5 ceiling. Final Peak week — one @10 single permitted on your last effort if all prior singles felt clean.'
        : 'RPE ceiling @9.5 — do not exceed.';
      c.appendChild(el('p', { class: 'muted' }, [
        `3–5 quality singles only. 4–5 min full rest between efforts. ${rpeNote} Fatigue stop: load must drop >5% to maintain @9, grip breaks before second 2s, or any joint discomfort.`
      ]));
    } else if (plan.role === 'Heavy') {
      c.appendChild(el('div', { class: 'callout' }, [
        `Find today's top set — RPE leads (target @${plan.rpe}). WM anchor: ~${plan.anchor} kg. Load up/down freely. Back-offs: ${plan.sets} sets at genuinely @7–8 (~${plan.anchor - plan.backoffAnchor} kg lighter than top).`
      ]));
      c.appendChild(el('p', { class: 'muted' }, [
        `Fatigue stop: halt back-offs if (1) can't hold full ${plan.duration}s at back-off load, (2) load must drop >5% to stay @8, (3) grip breaks before second ${Math.max(2, (plan.duration || 5) - 1)}, (4) any joint discomfort.`
      ]));
    } else if (plan.role === 'Test') {
      c.appendChild(el('div', { class: 'callout' }, [
        `Find today's @${plan.rpe}. This kg is a reference, not a target — RPE leads.`
      ]));
    }
    if (plan.role === 'Volume') {
      c.appendChild(el('div', { class: 'callout' }, [
        `Fixed ${plan.sets} sets — no extensions, even if it feels easy. Tendon management.`
      ]));
      c.appendChild(el('p', { class: 'muted' }, [
        `RPE creep rule: if RPE creeps to @8.5+ by set 3, drop load 5% and finish remaining sets. End early only if joint discomfort.`
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
                        Realization: '#b07bff', DeloadTest: '#f7b955', TopSet: '#4f8ef7', Custom: '#9a9aa8' };
    const hasVolumeDay = Object.values(cycle.weeklyStructure || {}).includes('Volume');
    weeks.forEach(w => {
      const node = el('button', { class: 'tl-week list-item' + (w.weekNumber === curWk ? ' now' : ''),
        onclick: () => showWeekDetail(w, cycle) });
      node.classList.remove('list-item');
      node.appendChild(el('div', { class: 'row' }, [
        el('span', { class: 'wk' }, [`W${w.weekNumber} · ${w.blockName}`]),
        el('span', { class: 'tl-bandlabel', style: `background:${(bandColor[w.blockType] || '#888')}22;color:${bandColor[w.blockType] || '#888'}` },
          [w.isDeloadTest ? 'TEST' : w.blockType])
      ]));
      const line = w.isDeloadTest
        ? `Deload @6 + test ${w.testDurations.join('/')}s · anchor ~${kg(w.deloadAnchorKg)}`
        : hasVolumeDay
          ? `Heavy ${w.heavyDuration}s @${w.heavyRPE} ~${kg(w.heavyAnchorKg)} · Vol ${Math.round((w.volumePct || 0) * 100)}% ~${kg(w.volumeAnchorKg)}`
          : `Top set ${w.heavyDuration}s @${w.heavyRPE} ~${kg(w.heavyAnchorKg)} · ${w.heavySets} back-offs ~${kg(w.backoffAnchorKg)} (Thu & Sat)`;
      node.appendChild(el('p', { class: 'muted', style: 'margin:6px 0 0' }, [line]));
      view.appendChild(node);
    });
  }

  function showWeekDetail(w, cycle) {
    const body = [];
    body.push(el('p', { class: 'sub' }, [`${w.blockName} · ${fmtDate(w.startDate)}`]));
    if (w.isDeloadTest) {
      // Deload hangs (Tue)
      const deloadPlan = {
        rest: false, role: 'Deload', week: w.weekNumber, blockName: w.blockName,
        duration: 5, rpe: 6, protocol: 'deload', sets: 3, anchor: w.deloadAnchorKg,
        note: 'Easy deload — 3 sets @6 at 75% of 5s WM. Keep it light.'
      };
      body.push(el('button', { class: 'list-item', onclick: () => { App.closeSheet(); Runner.start(deloadPlan); } }, [
        el('div', { class: 'row' }, [
          el('strong', null, ['Deload Hangs (Tue)']),
          el('span', { class: 'pill accent' }, ['Start →'])
        ]),
        el('p', { class: 'muted', style: 'margin:4px 0 0' }, [`5s · 3 sets @6 · anchor ~${kg(w.deloadAnchorKg)} · Easy deload hangs`])
      ]));

      // Benchmark test (Sat)
      const testPlan = {
        rest: false, role: 'Test', week: w.weekNumber, blockName: w.blockName,
        duration: w.testDurations[0], testDurations: w.testDurations,
        rpe: '9–9.5', protocol: 'test', sets: 1, anchor: null,
        note: w.testDurations.length > 1
          ? `Find max load for ${w.testDurations[0]}s @9–9.5. This is the primary test. Come back tomorrow for the ${w.testDurations[1]}s test.`
          : 'Find max load held for the full duration @9–9.5. Update your Working Max after.'
      };
      body.push(el('button', { class: 'list-item', onclick: () => { App.closeSheet(); Runner.start(testPlan); } }, [
        el('div', { class: 'row' }, [
          el('strong', null, ['Benchmark Test (Sat)']),
          el('span', { class: 'pill accent' }, ['Start →'])
        ]),
        el('p', { class: 'muted', style: 'margin:4px 0 0' }, [`${w.testDurations.join('/')}s max hangs @9–9.5 · Find today's absolute max load`])
      ]));
    } else {
      // Render one button per scheduled session day, driven by weeklyStructure
      // so programs with two heavy days (and no volume day) render correctly.
      const dayLabel = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
      const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
      const ws = (cycle && cycle.weeklyStructure) || { thu: 'Volume', sat: 'Heavy', tue: 'OIprimer' };

      order.forEach(d => {
        const role = ws[d];
        const dl = dayLabel[d];
        if (role === 'Heavy') {
          const heavyPlan = {
            rest: false, role: 'Heavy', week: w.weekNumber, blockName: w.blockName,
            duration: w.heavyDuration, rpe: w.heavyRPE, protocol: w.heavyProtocol,
            sets: w.heavySets, anchor: w.heavyAnchorKg, backoffAnchor: w.backoffAnchorKg,
            warmup: w.warmup, isLastBlockWeek: false, wmMissing: w.wmMissing
          };
          body.push(el('button', { class: 'list-item', onclick: () => { App.closeSheet(); Runner.start(heavyPlan); } }, [
            el('div', { class: 'row' }, [
              el('strong', null, [`${w.warmup ? 'Top-Set Hangs' : 'Heavy Hangs'} (${dl})`]),
              el('span', { class: 'pill accent' }, ['Start →'])
            ]),
            el('p', { class: 'muted', style: 'margin:4px 0 0' }, [`${w.heavyDuration}s · @${w.heavyRPE} · anchor ~${kg(w.heavyAnchorKg)} · ${w.heavyProtocol === 'maxSingles' ? w.heavySets + ' max singles' : w.heavySets + ' back-offs ~' + kg(w.backoffAnchorKg)}`])
          ]));
        } else if (role === 'Volume') {
          const volumePlan = {
            rest: false, role: 'Volume', week: w.weekNumber, blockName: w.blockName,
            duration: w.volumeDuration, rpe: '7–8', protocol: 'fixedVolume',
            sets: w.volumeSets, anchor: w.volumeAnchorKg, pct: w.volumePct
          };
          body.push(el('button', { class: 'list-item', onclick: () => { App.closeSheet(); Runner.start(volumePlan); } }, [
            el('div', { class: 'row' }, [
              el('strong', null, [`Volume Hangs (${dl})`]),
              el('span', { class: 'pill accent' }, ['Start →'])
            ]),
            el('p', { class: 'muted', style: 'margin:4px 0 0' }, [`${w.volumeDuration}s · ${Math.round((w.volumePct || 0) * 100)}% of heavy · anchor ~${kg(w.volumeAnchorKg)} · ${w.volumeSets} sets`])
          ]));
        } else if (role === 'OIprimer') {
          const oiPlan = {
            rest: false, role: 'OIprimer', week: w.weekNumber, blockName: w.blockName,
            duration: null, rpe: null, protocol: 'oi', sets: w.oiSets === 3 ? '3-5' : w.oiSets, anchor: null,
            note: 'Overcoming isometrics — max-intent press/pull against a fixed surface, ~5s. Neural primer, then limit board.'
          };
          body.push(el('button', { class: 'list-item', onclick: () => { App.closeSheet(); Runner.start(oiPlan); } }, [
            el('div', { class: 'row' }, [
              el('strong', null, [`OI primer + Board (${dl})`]),
              el('span', { class: 'pill accent' }, ['Start →'])
            ]),
            el('p', { class: 'muted', style: 'margin:4px 0 0' }, [`${w.oiSets === 3 ? '3-5' : w.oiSets} sets overcoming isometrics + limit board bouldering`])
          ]));
        }
      });
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

    // ---- summary stat cards ----
    const s5all = yielding.filter(l => l.hangDurationSeconds === 5).map(l => ({ x: l.date, y: l.e1rmKg }));
    const s3raw = yielding.filter(l => l.hangDurationSeconds === 3).map(l => ({ 
      x: l.date, 
      y: l.topSetLoadKg != null ? Calc.e1rm(l.topSetLoadKg, l.topSetRPE, 5) : Calc.roundTo(l.e1rmKg * 1.1, 1)
    }));

    const combined5sEq = yielding.filter(l => l.hangDurationSeconds === 5 || l.hangDurationSeconds === 3)
      .map(l => ({ x: l.date, y: l.e1rmKg, is3s: l.hangDurationSeconds === 3 }));
    combined5sEq.forEach((p, i) => { if (i > 0 && p.is3s) p.dashedPrev = true; });

    const bw = await DB.getMeta('bodyweightKg');
    const best5 = s5all.length ? Math.max.apply(null, s5all.map(p => p.y)) : null;
    const totalCard = (bw && best5 != null)
      ? { label: 'Peak total load', value: Calc.roundTo(bw + best5, 1) + ' kg',
          sub: Math.round(((bw + best5) / bw) * 100) + '% BW', color: '#4ecb71' }
      : { label: 'Peak total load', value: '—', sub: bw ? 'no 5s E1RM yet' : 'set bodyweight' };
    
    view.appendChild(statGrid([
      summarizeSeries('5s E1RM', s5all, '#4f8ef7'),
      summarizeSeries('3s Raw E1RM', s3raw, '#ff6b6b'),
      totalCard,
      { label: 'Total Sessions', value: String(logs.length), sub: 'logged' },
      { label: 'E1RM Sessions', value: String(yielding.length), sub: 'with E1RM' }
    ]));

    // E1RM chart, two series by duration
    view.appendChild(el('h2', null, ['E1RM trend']));
    if (!combined5sEq.length) {
      view.appendChild(el('div', { class: 'card' }, ['Log Yielding sessions with load + RPE to see E1RM trends.']));
    } else {
      const card = el('div', { class: 'card' });
      card.appendChild(el('div', { class: 'legend' }, [
        el('span', null, [el('span', { class: 'sw', style: 'background:#4f8ef7' }), '5s-eq (Combined)']),
        el('span', null, [el('span', { class: 'sw', style: 'background:transparent;border-top:1.5px dashed #4f8ef7;height:0;width:14px;display:inline-block;vertical-align:middle;margin-right:5px' }), '3s segment']),
        el('span', null, [el('span', { class: 'sw', style: 'background:#ff6b6b' }), '3s Raw']),
        el('span', null, [
          el('span', { class: 'sw', style: 'background:transparent;border-top:1.5px solid rgba(79, 142, 247, 0.4);height:0;width:14px;display:inline-block;vertical-align:middle;margin-right:5px' }),
          el('span', { class: 'sw', style: 'background:transparent;border-top:1.5px solid rgba(255, 107, 107, 0.4);height:0;width:14px;display:inline-block;vertical-align:middle;margin-right:5px' }),
          'Trends'
        ])
      ]));
      card.appendChild(lineChart([
        // Trend only for 5s
        { pts: s5all, hideLine: true, hidePoints: true, trendColor: '#4f8ef7' },
        // The combined line (no mixed trend)
        { pts: combined5sEq, color: '#4f8ef7', name: '5s-eq', noTrend: true },
        // 3s Raw line and its red trend
        { pts: s3raw, color: '#ff6b6b', name: '3s Raw', trendColor: '#ff6b6b' }
      ], 'kg', { movingAvg: true, prMarkers: true }));
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
    const bars = Object.keys(byWeek).sort().map(k => ({ label: k.slice(5), value: Math.round(byWeek[k]), full: k }));
    view.appendChild(bars.length ? el('div', { class: 'card' }, [barChart(bars, 'kg·sets')])
      : el('div', { class: 'card' }, ['No volume data yet.']));

    // recovery trend
    view.appendChild(el('h2', null, ['Recovery (next-day feel)']));
    const ndf = logs.filter(l => l.nextDayFeel != null).slice(-20).map(l => ({ x: l.date, y: l.nextDayFeel }));
    view.appendChild(ndf.length ? el('div', { class: 'card' }, [recoveryChart(ndf)])
      : el('div', { class: 'card' }, ['No next-day-feel data yet.']));

    // RPE distribution
    view.appendChild(el('h2', null, ['RPE distribution']));
    const rpeBuckets = {};
    yielding.forEach(l => { if (l.topSetRPE != null) { const k = (Math.round(l.topSetRPE * 2) / 2).toFixed(1); rpeBuckets[k] = (rpeBuckets[k] || 0) + 1; } });
    const rpeBars = Object.keys(rpeBuckets).sort((a, b) => +a - +b).map(k => ({ label: '@' + k, value: rpeBuckets[k], full: k }));
    view.appendChild(rpeBars.length ? el('div', { class: 'card' }, [barChart(rpeBars, 'sessions', { color: '#9b7bf0', intY: true })])
      : el('div', { class: 'card' }, ['No RPE data yet.']));

    // grip breakdown
    view.appendChild(el('h2', null, ['Grip breakdown']));
    const gripCount = {};
    logs.forEach(l => { if (l.grip) gripCount[l.grip] = (gripCount[l.grip] || 0) + 1; });
    const gripBars = Object.keys(gripCount).sort((a, b) => gripCount[b] - gripCount[a]).map(k => ({ label: k.replace(/([A-Z])/g, ' $1').trim(), value: gripCount[k], full: k }));
    view.appendChild(gripBars.length ? el('div', { class: 'card' }, [barChart(gripBars, 'sessions', { color: '#4ecb71', intY: true })])
      : el('div', { class: 'card' }, ['No grip data yet.']));

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

  // shared tooltip (one per document)
  function tooltipEl() {
    let t = document.getElementById('chart-tip');
    if (!t) { t = el('div', { id: 'chart-tip', class: 'chart-tip' }); document.body.appendChild(t); }
    return t;
  }
  function bindTip(node, html) {
    const show = (e) => {
      const t = tooltipEl(); t.innerHTML = html; t.style.opacity = '1';
      const pt = e.touches && e.touches.length ? e.touches[0] : e;
      t.style.left = pt.clientX + 'px';
      t.style.top = (pt.clientY - 24) + 'px'; // Offset higher to avoid finger block on touch
    };
    const hide = () => { tooltipEl().style.opacity = '0'; };
    node.addEventListener('pointerenter', show);
    node.addEventListener('pointermove', show);
    node.addEventListener('pointerleave', hide);
    node.addEventListener('touchstart', show, { passive: true });
    node.addEventListener('touchmove', show, { passive: true });
    node.addEventListener('touchend', hide);
    node.addEventListener('touchcancel', hide);
    node.style.cursor = 'pointer';
  }

  // nice rounded tick values between min and max
  function niceTicks(min, max, count) {
    if (min === max) { max = min + 1; }
    const range = max - min;
    const raw = range / (count - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
    return out;
  }
  function fmtShort(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function lineChart(series, unit, opts) {
    opts = opts || {};
    // Group and aggregate points by date to avoid duplicate entries on the same date
    const cleanSeries = series.map(s => {
      const grouped = {};
      s.pts.forEach(p => {
        if (grouped[p.x] === undefined || p.y > grouped[p.x]) {
          grouped[p.x] = p.y;
        }
      });
      const cleanPts = Object.keys(grouped).sort().map(x => ({ x, y: grouped[x] }));
      return Object.assign({}, s, { pts: cleanPts });
    });
    series = cleanSeries;

    const W = 600, H = 280, padL = 42, padR = 14, padT = 14, padB = 40;
    const all = series.flatMap(s => s.pts);
    const dates = Array.from(new Set(all.map(p => p.x))).sort();
    const ys = all.map(p => p.y);
    const dataMin = Math.min.apply(null, ys), dataMax = Math.max.apply(null, ys);
    const ticks = niceTicks(dataMin, dataMax, 5);
    const ymin = ticks[0], ymax = ticks[ticks.length - 1];
    const xFor = (x) => padL + (dates.length <= 1 ? 0.5 : dates.indexOf(x) / (dates.length - 1)) * (W - padL - padR);
    const yFor = (y) => H - padB - ((y - ymin) / (ymax - ymin || 1)) * (H - padT - padB);
    const svg = svgNS('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });

    // horizontal gridlines + y labels
    ticks.forEach(yv => {
      svg.appendChild(svgNS('line', { x1: padL, y1: yFor(yv), x2: W - padR, y2: yFor(yv), stroke: 'rgba(255,255,255,0.07)', 'stroke-width': 1 }));
      const tx = svgNS('text', { x: padL - 6, y: yFor(yv) + 4, fill: '#9a9aa8', 'font-size': 11, 'text-anchor': 'end' }); tx.textContent = yv; svg.appendChild(tx);
    });
    // axis title
    const axt = svgNS('text', { x: 12, y: padT + 4, fill: '#9a9aa8', 'font-size': 10 }); axt.textContent = unit; svg.appendChild(axt);
    // x labels (thinned to ~6)
    const step = Math.max(1, Math.ceil(dates.length / 6));
    dates.forEach((dt, i) => {
      if (i % step !== 0 && i !== dates.length - 1) return;
      const tx = svgNS('text', { x: xFor(dt), y: H - padB + 16, fill: '#9a9aa8', 'font-size': 10, 'text-anchor': 'middle' });
      tx.textContent = fmtShort(dt); svg.appendChild(tx);
    });

    series.forEach(s => {
      if (s.pts.length === 0) return;
      // moving average (3-pt) underlay
      if (opts.movingAvg && s.pts.length >= 3 && !s.noTrend) {
        const avgPts = s.pts.map((p, i) => {
          const w = s.pts.slice(Math.max(0, i - 1), i + 2);
          return { x: xFor(p.x), y: yFor(w.reduce((a, b) => a + b.y, 0) / w.length) };
        });
        let d = '';
        avgPts.forEach((p, i) => {
          if (i === 0) d += `M${p.x} ${p.y}`;
          else {
            const prev = avgPts[i - 1];
            const cpX = (prev.x + p.x) / 2;
            d += ` C ${cpX} ${prev.y}, ${cpX} ${p.y}, ${p.x} ${p.y}`;
          }
        });
        const tColor = s.trendColor || '#9a9aa8';
        svg.appendChild(svgNS('path', { d, fill: 'none', stroke: tColor, 'stroke-width': 1.2, opacity: 0.4 }));
      }
      
      if (s.hideLine) {
        // do not draw line
      } else if (s.dashed) {
        let d = '';
        s.pts.forEach((p, i) => { d += (i ? ' L' : 'M') + xFor(p.x) + ' ' + yFor(p.y); });
        svg.appendChild(svgNS('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-dasharray': '4,4', 'stroke-linejoin': 'round' }));
      } else {
        // Support per-segment dashes by breaking into multiple paths
        let currentPath = [];
        let isDashed = false;
        
        const flushPath = () => {
          if (currentPath.length < 2) return;
          let d = '';
          currentPath.forEach((pt, i) => { d += (i ? ' L' : 'M') + xFor(pt.x) + ' ' + yFor(pt.y); });
          const attrs = { d, fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' };
          if (isDashed) attrs['stroke-dasharray'] = '4,4';
          svg.appendChild(svgNS('path', attrs));
        };

        s.pts.forEach((p, i) => {
          if (i === 0) {
            currentPath.push(p);
          } else {
            if (p.dashedPrev !== isDashed) {
              const prevPoint = s.pts[i - 1];
              flushPath();
              currentPath = [prevPoint];
              isDashed = p.dashedPrev;
            }
            currentPath.push(p);
          }
        });
        flushPath();
      }

      if (!s.hidePoints) {
        // PR markers + points
        let best = -Infinity;
        s.pts.forEach(p => {
          const isPR = opts.prMarkers && p.y > best;
          if (p.y > best) best = p.y;
          if (isPR) {
            const starText = svgNS('text', {
              x: xFor(p.x),
              y: yFor(p.y) - 9,
              'text-anchor': 'middle',
              'font-size': '12px',
              style: 'pointer-events:none;user-select:none;'
            });
            starText.textContent = '⭐';
            svg.appendChild(starText);
          }
          
          const cAttrs = { 
            cx: xFor(p.x), cy: yFor(p.y), r: 4, 
            fill: p.is3s ? '#15151e' : s.color, // '#15151e' is a dark background color to make it hollow
            stroke: s.color, 
            'stroke-width': p.is3s ? 1.5 : 1 
          };
          const c = svgNS('circle', cAttrs);
          svg.appendChild(c);
          
          // Large transparent hit target for easy pointing/touch on mobile
          const hit = svgNS('circle', { cx: xFor(p.x), cy: yFor(p.y), r: 20, fill: 'transparent', opacity: 0 });
          bindTip(hit, `<b>${(s.name || '') + ' '}${p.y} ${unit}</b><br>${fmtShort(p.x)}${isPR ? '<br>🏆 PR' : ''}`);
          svg.appendChild(hit);
        });
      }
    });
    return svg;
  }

  function barChart(bars, unit, opts) {
    opts = opts || {};
    const color = opts.color || '#4f8ef7';
    const W = 600, H = 240, padL = 42, padR = 14, padT = 14, padB = 38;
    const max = Math.max.apply(null, bars.map(b => b.value)) || 1;
    const ticks = niceTicks(0, max, opts.intY ? Math.min(5, max + 1) : 5).filter(t => t >= 0);
    const ymax = ticks[ticks.length - 1] || 1;
    const yFor = (v) => H - padB - (v / ymax) * (H - padT - padB);
    const bw = (W - padL - padR) / bars.length;
    const svg = svgNS('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
    // gridlines + y labels
    ticks.forEach(tv => {
      svg.appendChild(svgNS('line', { x1: padL, y1: yFor(tv), x2: W - padR, y2: yFor(tv), stroke: 'rgba(255,255,255,0.07)', 'stroke-width': 1 }));
      const tx = svgNS('text', { x: padL - 6, y: yFor(tv) + 4, fill: '#9a9aa8', 'font-size': 11, 'text-anchor': 'end' }); tx.textContent = opts.intY ? Math.round(tv) : tv; svg.appendChild(tx);
    });
    const axt = svgNS('text', { x: 12, y: padT + 4, fill: '#9a9aa8', 'font-size': 10 }); axt.textContent = unit; svg.appendChild(axt);
    bars.forEach((b, i) => {
      const h = (b.value / ymax) * (H - padT - padB);
      const x = padL + i * bw + Math.min(6, bw * 0.12);
      const rw = bw - 2 * Math.min(6, bw * 0.12);
      const rect = svgNS('rect', { x, y: H - padB - h, width: rw, height: h, rx: 3, fill: color });
      svg.appendChild(rect);

      // Full-height transparent hit target for easy pointing/touch on mobile
      const hit = svgNS('rect', { x, y: padT, width: rw, height: H - padB - padT, fill: 'transparent', opacity: 0 });
      bindTip(hit, `<b>${b.value} ${unit}</b><br>${b.full || b.label}`);
      svg.appendChild(hit);
      // value label on top
      if (bars.length <= 14) {
        const vt = svgNS('text', { x: x + rw / 2, y: H - padB - h - 4, fill: '#f0f0f5', 'font-size': 10, 'text-anchor': 'middle' }); vt.textContent = b.value; svg.appendChild(vt);
      }
      // x label (thinned)
      const lblStep = Math.max(1, Math.ceil(bars.length / 8));
      if (i % lblStep === 0 || i === bars.length - 1) {
        const tx = svgNS('text', { x: x + rw / 2, y: H - padB + 16, fill: '#9a9aa8', 'font-size': 10, 'text-anchor': 'middle' }); tx.textContent = b.label; svg.appendChild(tx);
      }
    });
    return svg;
  }

  function recoveryChart(pts) {
    const W = 600, H = 220, padL = 28, padR = 14, padT = 14, padB = 38;
    const xFor = (i) => padL + (pts.length <= 1 ? 0.5 : i / (pts.length - 1)) * (W - padL - padR);
    const yFor = (y) => H - padB - ((y - 1) / 4) * (H - padT - padB);
    const svg = svgNS('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
    // zones: green>=4, amber 3, red<=2
    [['#4ecb71', 4, 5, 'Good'], ['#f7b955', 3, 4, 'OK'], ['#ff6b6b', 1, 3, 'Sore']].forEach(z => {
      svg.appendChild(svgNS('rect', { x: padL, y: yFor(z[2]), width: W - padL - padR, height: yFor(z[1]) - yFor(z[2]), fill: z[0], opacity: 0.08 }));
      const lt = svgNS('text', { x: W - padR - 2, y: yFor((z[1] + z[2]) / 2) + 4, fill: z[0], 'font-size': 10, 'text-anchor': 'end', opacity: 0.7 }); lt.textContent = z[3]; svg.appendChild(lt);
    });
    // y ticks 1..5
    [1, 2, 3, 4, 5].forEach(yv => {
      const tx = svgNS('text', { x: padL - 6, y: yFor(yv) + 4, fill: '#9a9aa8', 'font-size': 10, 'text-anchor': 'end' }); tx.textContent = yv; svg.appendChild(tx);
    });
    // x labels
    const step = Math.max(1, Math.ceil(pts.length / 6));
    pts.forEach((p, i) => {
      if (i % step !== 0 && i !== pts.length - 1) return;
      const tx = svgNS('text', { x: xFor(i), y: H - padB + 16, fill: '#9a9aa8', 'font-size': 10, 'text-anchor': 'middle' }); tx.textContent = fmtShort(p.x); svg.appendChild(tx);
    });
    let d = '';
    pts.forEach((p, i) => { d += (i ? ' L' : 'M') + xFor(i) + ' ' + yFor(p.y); });
    svg.appendChild(svgNS('path', { d, fill: 'none', stroke: '#f0f0f5', 'stroke-width': 2 }));
    pts.forEach((p, i) => {
      const c = svgNS('circle', { cx: xFor(i), cy: yFor(p.y), r: 4,
        fill: p.y >= 4 ? '#4ecb71' : p.y === 3 ? '#f7b955' : '#ff6b6b', stroke: '#0a0a0f', 'stroke-width': 1 });
      svg.appendChild(c);

      // Large transparent hit target for easy pointing/touch on mobile
      const hit = svgNS('circle', { cx: xFor(i), cy: yFor(p.y), r: 20, fill: 'transparent', opacity: 0 });
      bindTip(hit, `<b>Feel ${p.y}/5</b><br>${fmtShort(p.x)}`);
      svg.appendChild(hit);
    });
    return svg;
  }

  // ---- stat summary helpers --------------------------------------------
  function statGrid(stats) {
    const grid = el('div', { class: 'stat-grid' });
    stats.forEach(s => {
      grid.appendChild(el('div', { class: 'stat' }, [
        el('span', { class: 'stat-label' }, [s.label]),
        el('span', { class: 'stat-value', style: s.color ? `color:${s.color}` : null }, [s.value]),
        el('span', { class: 'stat-sub' }, [s.sub || ''])
      ]));
    });
    return grid;
  }
  function summarizeSeries(label, pts, color) {
    if (!pts.length) return { label, value: '—', sub: 'no data', color };
    const latest = pts[pts.length - 1].y;
    const first = pts[0].y;
    const best = Math.max.apply(null, pts.map(p => p.y));
    const delta = latest - first;
    const pct = first ? Math.round((delta / first) * 100) : 0;
    const sign = delta >= 0 ? '+' : '';
    return { label, value: latest + ' kg', sub: `best ${best} · ${sign}${pct}%`, color };
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
    const [w5, w3, bw] = await Promise.all([DB.currentWM(5), DB.currentWM(3), DB.getMeta('bodyweightKg')]);

    view.appendChild(wmEditor('5s Working Max', 5, w5));
    view.appendChild(wmEditor('3s Working Max', 3, w3));

    // Bodyweight — used for total-load (bodyweight + added) and %BW analytics.
    const bwCard = el('div', { class: 'card' });
    bwCard.appendChild(el('div', { class: 'row' }, [
      el('h2', { style: 'margin:0' }, ['Bodyweight']),
      el('span', { class: 'muted' }, [bw != null ? bw + ' kg' : 'not set'])
    ]));
    const bwStep = stepper({ min: 30, max: 150, step: 0.5, value: bw != null ? bw : 67.5, fmt: v => v + ' kg' });
    bwCard.appendChild(el('div', { class: 'field' }, [bwStep]));
    bwCard.appendChild(el('button', { class: 'btn small', onclick: async () => {
      await DB.setMeta('bodyweightKg', bwStep.getValue());
      App.render();
    } }, ['Save bodyweight']));
    bwCard.appendChild(el('p', { class: 'muted', style: 'margin:8px 0 0' }, ['Used to show total load (bodyweight + added) and %BW in Analytics. Stamped onto new sessions you log.']));
    view.appendChild(bwCard);

    // WM history
    const allWM = (await DB.getAll('workingMaxes')).sort((a, b) => a.date < b.date ? 1 : -1);
    if (allWM.length) {
      const c = el('div', { class: 'card' }, [el('h2', { style: 'margin-top:0' }, ['WM history'])]);
      allWM.forEach(w => {
        const item = el('div', { class: 'row', style: 'margin:8px 0' }, [
          el('span', { class: 'muted' }, [`${w.durationSeconds}s · ${w.valueKg} kg · ${fmtDate(w.date)} · ${w.source}`]),
          el('button', {
            class: 'btn small ghost',
            style: 'margin:0;padding:2px 8px;min-height:28px;font-size:12px;border-radius:6px;width:auto;',
            onclick: () => {
              App.confirm(`Delete this ${w.durationSeconds}s WM history entry (${w.valueKg} kg on ${fmtDate(w.date)})?`, 'Delete', async () => {
                await DB.softDelete('workingMaxes', w.id);
                App.render();
              });
            }
          }, ['✕'])
        ]);
        c.appendChild(item);
      });
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
    
    // GitHub Gist Sync Card
    const token = await DB.getMeta('githubToken');
    const gistId = await DB.getMeta('githubGistId');
    const cSync = el('div', { class: 'card' });
    cSync.appendChild(el('h2', { style: 'margin-top:0' }, ['GitHub Gist Sync']));

    if (token) {
      cSync.appendChild(el('p', { class: 'muted', style: 'margin-bottom:8px' }, [
        `Status: Connected `,
        el('span', { style: 'color:var(--success);font-weight:700' }, ['●'])
      ]));
      if (gistId) {
        cSync.appendChild(el('p', { class: 'muted', style: 'margin-bottom:12px' }, [`Gist ID: ${gistId}`]));
      } else {
        cSync.appendChild(el('p', { class: 'muted', style: 'margin-bottom:12px' }, ['No Gist linked yet. It will be created on the first sync.']));
      }

      const statusText = el('p', { class: 'muted', style: 'margin:8px 0;font-style:italic' }, ['']);
      const syncBtn = el('button', { class: 'btn small', onclick: async () => {
        syncBtn.disabled = true;
        statusText.style.color = 'var(--text-dim)';
        const res = await Sync.run(msg => statusText.textContent = msg);
        syncBtn.disabled = false;
        if (res.success) {
          statusText.style.color = 'var(--success)';
          setTimeout(() => App.render(), 1500);
        } else {
          statusText.style.color = 'var(--danger)';
        }
      } }, ['Sync Now']);

      const discBtn = el('button', { class: 'btn small secondary', style: 'margin-left:8px', onclick: async () => {
        App.confirm('Disconnect from GitHub Sync? Your token and Gist ID will be cleared locally.', 'Disconnect', async () => {
          await Sync.disconnect();
          App.render();
        });
      } }, ['Disconnect']);

      cSync.appendChild(el('div', { class: 'row', style: 'justify-content:flex-start' }, [syncBtn, discBtn]));
      cSync.appendChild(statusText);
    } else {
      cSync.appendChild(el('p', { class: 'muted', style: 'margin-bottom:12px;line-height:1.4' }, [
        'Backup and sync your logs across devices. Create a private ',
        el('a', { href: 'https://github.com/settings/tokens/new?scopes=gist&description=Finger%20Trainer%20Sync', target: '_blank', style: 'color:var(--accent);text-decoration:none' }, ['GitHub Personal Access Token']),
        ' with the gist scope, then paste it below:'
      ]));

      const tokInput = el('input', { type: 'password', placeholder: 'ghp_xxxxxxxxxxxx', style: 'width:100%;margin-bottom:12px;background:rgba(255,255,255,0.06);border:1px solid var(--card-border);color:var(--text);border-radius:10px;padding:11px 12px;font-size:16px' });
      const statusText = el('p', { class: 'muted', style: 'margin:8px 0;font-style:italic' }, ['']);
      const connectBtn = el('button', { class: 'btn small', onclick: async () => {
        const val = tokInput.value.trim();
        if (!val) {
          statusText.style.color = 'var(--danger)';
          statusText.textContent = 'Please enter a token first.';
          return;
        }
        connectBtn.disabled = true;
        statusText.style.color = 'var(--text-dim)';
        statusText.textContent = 'Saving token and performing initial sync...';
        await Sync.saveToken(val);
        const res = await Sync.run(msg => statusText.textContent = msg);
        connectBtn.disabled = false;
        if (res.success) {
          statusText.style.color = 'var(--success)';
          setTimeout(() => App.render(), 1500);
        } else {
          statusText.style.color = 'var(--danger)';
          await Sync.disconnect();
        }
      } }, ['Connect & Sync']);

      cSync.appendChild(el('div', { class: 'field', style: 'margin:0' }, [tokInput]));
      cSync.appendChild(el('div', { style: 'margin-top:12px' }, [connectBtn]));
      cSync.appendChild(statusText);
    }

    view.appendChild(cSync);

    view.appendChild(el('button', { class: 'btn secondary', onclick: () => App.importBundledHistory() }, ['Load my spreadsheet history (19 sessions)']));
    view.appendChild(el('div', { class: 'spacer' }));
    view.appendChild(el('button', { class: 'btn secondary', onclick: () => App.exportCSV() }, ['Export CSV (logs only)']));
    view.appendChild(el('div', { class: 'spacer' }));
    view.appendChild(el('button', { class: 'btn secondary', onclick: () => App.exportBackupJSON() }, ['Export full backup (JSON)']));
    view.appendChild(el('div', { class: 'spacer' }));
    view.appendChild(el('button', { class: 'btn secondary', onclick: () => App.importBackupJSON() }, ['Restore backup (JSON)']));
    view.appendChild(el('div', { class: 'spacer' }));
    view.appendChild(el('button', { class: 'btn danger', onclick: () => App.resetData() }, ['Reset all data']));

    // Update Log
    const cLog = el('details', { class: 'card tight', style: 'cursor:pointer;margin-top:20px' }, [
      el('summary', { style: 'color:var(--accent);font-weight:600;font-size:14px;list-style:none;display:flex;align-items:center;justify-content:space-between' }, [
        el('span', null, ['Recent Updates (Last: Jun 4, 2026)']),
        el('span', { class: 'pill accent', style: 'margin:0' }, ['v1.9.3'])
      ]),
      el('div', { style: 'margin-top:12px;font-size:12.5px;line-height:1.55;display:flex;flex-direction:column;gap:8px' }, [
        el('div', { style: 'color:var(--text-dim)' }, [
          el('strong', { style: 'color:var(--text);display:block' }, ['v1.9.3 · Jun 4, 2026']),
          'Restored moving average trend lines as thin, solid, semi-transparent curves (getting rid of the dotted/dashed look).'
        ]),
        el('div', { style: 'color:var(--text-dim)' }, [
          el('strong', { style: 'color:var(--text);display:block' }, ['v1.9.2 · Jun 4, 2026']),
          'Removed the dotted moving average trend lines from the E1RM trend chart.'
        ]),
        el('div', { style: 'color:var(--text-dim)' }, [
          el('strong', { style: 'color:var(--text);display:block' }, ['v1.9.1 · Jun 4, 2026']),
          'Smoothed E1RM trend chart moving average lines using cubic Bezier curves.'
        ]),
        el('div', { style: 'color:var(--text-dim)' }, [
          el('strong', { style: 'color:var(--text);display:block' }, ['v1.9.0 · Jun 4, 2026']),
          'Fixed iOS Safari date input layout overflow / collapsing bugs, and added delete buttons to settings Working Max (WM) history entries.'
        ]),
        el('div', { style: 'color:var(--text-dim)' }, [
          el('strong', { style: 'color:var(--text);display:block' }, ['v1.8.0 · Jun 3, 2026']),
          'Upgraded analytics summary cards, switched E1RM trend line to standard 3-point simple moving average, and added ⭐ PR emoji markers on new personal records.'
        ]),
        el('div', { style: 'color:var(--text-dim)' }, [
          el('strong', { style: 'color:var(--text);display:block' }, ['v1.7.0 · Jun 3, 2026']),
          'Smoothed E1RM trend lines with weighted binomial filters & color-coded series matching.'
        ]),
        el('div', { style: 'color:var(--text-dim)' }, [
          el('strong', { style: 'color:var(--text);display:block' }, ['v1.6.0 · Jun 3, 2026']),
          'Upgraded chart pointer hitboxes (r:20 circles & full-height bar rects) and touch-move swipe tooltips.'
        ]),
        el('div', { style: 'color:var(--text-dim)' }, [
          el('strong', { style: 'color:var(--text);display:block' }, ['v1.5.0 · Jun 2, 2026']),
          'iPhone 15 Pro PWA optimization: pure OLED black mode, iOS home indicator safe padding, and touch latency reduction.'
        ]),
        el('div', { style: 'color:var(--text-dim)' }, [
          el('strong', { style: 'color:var(--text);display:block' }, ['v1.4.0 · Jun 2, 2026']),
          'Implemented serverless GitHub Gist Sync with automatic Gist detection for instant cross-device backup.'
        ]),
        el('div', { style: 'color:var(--text-dim)' }, [
          el('strong', { style: 'color:var(--text);display:block' }, ['v1.3.0 · Jun 2, 2026']),
          'Changed OI primer sets to a flexible 3-5 sets scheme with interactive runner prompts.'
        ]),
        el('div', { style: 'color:var(--text-dim)' }, [
          el('strong', { style: 'color:var(--text);display:block' }, ['v1.2.0 · Jun 1, 2026']),
          'Integrated clickable program detail slots for direct workout launching & exact spreadsheet RPE ranges.'
        ]),
        el('div', { style: 'color:var(--text-dim)' }, [
          el('strong', { style: 'color:var(--text);display:block' }, ['v1.1.0 · Jun 1, 2026']),
          'Premium SVG tab icons, branding logo edge headers, and heavy/volume fatigue stop prompts.'
        ])
      ])
    ]);
    view.appendChild(cLog);

    const footer = el('div', { class: 'settings-footer' }, [
      el('img', { class: 'settings-logo', src: 'icons/icon-192.png', alt: 'Finger Trainer Logo' }),
      el('p', { class: 'muted center', style: 'margin:0' }, ['Finger Trainer · offline PWA · single user'])
    ]);
    view.appendChild(footer);
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

  App.confirm = function (msg, okLabel, onOk, onCancel, cancelLabel) {
    App.sheet('', [
      el('p', null, [msg]),
      el('button', { class: 'btn', onclick: () => { App.closeSheet(); onOk && onOk(); } }, [okLabel || 'OK']),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn secondary', onclick: () => { App.closeSheet(); onCancel && onCancel(); } }, [cancelLabel || 'Cancel'])
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
    const rpeSt = stepper({ min: 5, max: 10, step: 0.5, value: state.rpe || 8, fmt: v => '@' + v, onChange: v => { state.rpe = v; updE1RM(); } });
    const setsSt = stepper({ min: 0, max: 10, step: 1, value: state.sets || 3, onChange: v => state.sets = v });
    body.push(el('div', { class: 'grid2' }, [
      el('div', { class: 'field' }, [el('label', null, ['Top set load']), loadSt]),
      el('div', { class: 'field' }, [el('label', null, ['Top set RPE']), rpeSt])
    ]));
    body.push(el('div', { class: 'field' }, [el('label', null, ['Sets']), setsSt]));
    const e1rmLine = el('p', { class: 'muted' }, ['']);
    body.push(e1rmLine);
    function updE1RM() {
      const v = state.type === 'Yielding' ? Calc.e1rm(loadSt.getValue(), rpeSt.getValue(), state.hangDurationSeconds) : null;
      e1rmLine.textContent = v != null ? `E1RM: ${v} kg (5s-eq)` : '';
    }
    updE1RM();

    // ratings
    const taxR = rating(5, state.taxing, v => state.taxing = v);
    const feltR = rating(10, state.felt, v => state.felt = v);
    const ndfR = rating(5, state.ndf, v => state.ndf = v);
    body.push(el('div', { class: 'field' }, [el('label', null, ['Session taxing (1–5)']), taxR]));
    body.push(el('div', { class: 'field' }, [el('label', null, ['Felt strong (1–10)']), feltR]));
    body.push(el('div', { class: 'field' }, [
      el('label', null, ['Next-day feel (1–5, fill tomorrow)']),
      ndfR
    ]));

    const notes = el('textarea', { placeholder: 'Notes' }); notes.value = state.notes;
    notes.addEventListener('input', () => state.notes = notes.value);
    body.push(el('div', { class: 'field' }, [el('label', null, ['Notes']), notes]));

    body.push(el('button', { class: 'btn', onclick: async () => {
      const blk = e.block || await blockNameFor(state.date);
      const bw = e.bodyweightKg != null ? e.bodyweightKg : (await DB.getMeta('bodyweightKg')) || null;
      const entry = {
        id: e.id || Templates.uid(), date: state.date, type: state.type, role: state.role, venue: state.venue,
        hangDurationSeconds: state.type === 'Yielding' ? state.hangDurationSeconds : null, grip: state.grip,
        topSetLoadKg: state.type === 'Yielding' ? loadSt.getValue() : null,
        topSetRPE: state.type === 'Yielding' ? rpeSt.getValue() : null,
        sets: setsSt.getValue(), bodyweightKg: bw,
        taxing: taxR.getValue(), feltStrong: feltR.getValue(), nextDayFeel: state.ndf != null ? state.ndf : (e.nextDayFeel || null),
        block: blk || '', notes: state.notes
      };
      await DB.addLog(entry);
      // benchmark capture for Test role
      if (entry.role === 'Test' && entry.topSetLoadKg) await maybeBenchmark(entry);
      App.closeSheet(); App.render();
    } }, [existing ? 'Save changes' : 'Save session']));

    if (existing) body.push(el('button', { class: 'btn danger', style: 'margin-top:8px', onclick: async () => {
      App.confirm('Delete this entry?', 'Delete', async () => { await DB.softDelete('logEntries', e.id); App.closeSheet(); App.render(); });
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

  // One-tap import of the bundled spreadsheet history (history_import.csv).
  App.importBundledHistory = async function () {
    try {
      const res = await fetch('history_import.csv', { cache: 'no-store' });
      if (!res.ok) throw new Error('not found');
      await doImport(await res.text());
    } catch (e) {
      App.confirm('Could not find the bundled history file. Use "Import CSV" on the History tab to pick it manually.', 'OK');
    }
  };

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
  // Normalize role names so imported data lines up with the app's conventions.
  function normalizeRole(role, type) {
    const r = (role || '').trim();
    if (r === 'OI') return 'OIprimer';
    if (r) return r;
    // blank role: infer a sensible default from type
    if (type === 'Climbing') return 'Climb';
    if (type === 'OI') return 'OIprimer';
    return ''; // leave Yielding blanks unassigned rather than guessing Heavy vs Volume
  }
  function num(v) {
    if (v == null || v === '') return null;
    const n = +v;
    return Number.isFinite(n) ? n : null; // never store NaN — it breaks charts
  }

  async function doImport(text) {
    const lines = parseCSV(text);
    if (!lines.length) return;
    const header = lines[0].map(h => h.trim());
    const idx = {}; header.forEach((h, i) => idx[h] = i);
    // Index existing entries by date so re-importing updates in place (idempotent)
    // rather than creating duplicates of the seeded history.
    const existing = await DB.getAll('logEntries');
    const byDate = {};
    existing.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });
    let added = 0, updated = 0;
    for (let r = 1; r < lines.length; r++) {
      const c = lines[r]; if (!c.length || !c[idx.date]) continue;
      const date = c[idx.date].trim();
      const type = c[idx.type] || 'Yielding';
      const role = normalizeRole(c[idx.role], type);
      const dur = c[idx.hangDurationSeconds] ? +c[idx.hangDurationSeconds] : (type === 'Yielding' ? 5 : null);
      const load = num(c[idx.loadKg]);
      const rpe = num(c[idx.rpe]);
      let e1 = num(c[idx.e1rmKg]);
      if (e1 == null && type === 'Yielding') e1 = Calc.e1rm(load, rpe, dur);
      // match an existing entry on date (+ role if it disambiguates same-day sessions)
      const sameDay = byDate[date] || [];
      let match = sameDay.find(e => (e.role || '') === role) || (sameDay.length === 1 ? sameDay[0] : null);
      const entry = {
        id: match ? match.id : Templates.uid(), date, type, role, venue: c[idx.venue] || '',
        hangDurationSeconds: dur, grip: (match && match.grip) || 'HalfCrimp',
        topSetLoadKg: load, topSetRPE: rpe, sets: num(c[idx.sets]), bodyweightKg: (match && match.bodyweightKg) || null,
        taxing: num(c[idx.taxing]), feltStrong: num(c[idx.feltStrong]),
        nextDayFeel: num(c[idx.nextDayFeel]) != null ? num(c[idx.nextDayFeel]) : (match ? match.nextDayFeel : null),
        block: c[idx.block] || (match && match.block) || '', notes: c[idx.notes] || '', e1rmKg: e1
      };
      await DB.put('logEntries', entry);
      if (match) { updated++; const i2 = sameDay.indexOf(match); if (i2 >= 0) sameDay.splice(i2, 1); }
      else { (byDate[date] = byDate[date] || []).push(entry); added++; }
    }
    App.confirm(`Import complete: ${added} added, ${updated} updated.`, 'OK', () => App.render());
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

  // ---- full database backup / restore (JSON) ---------------------------
  // CSV only carries logs; this carries the whole DB (logs, working maxes,
  // cycles, benchmarks, settings) so it's a complete, GitHub-independent
  // safety net you can re-import on any device.
  App.exportBackupJSON = async function () {
    const data = await DB.exportBackup();
    const payload = { app: 'finger-trainer', version: 1, exportedAt: new Date().toISOString(), data };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `finger-trainer-backup-${todayISO()}.json` });
    document.body.appendChild(a); a.click(); a.remove();
  };

  App.importBackupJSON = function () {
    const input = el('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', () => {
      const file = input.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        let parsed;
        try { parsed = JSON.parse(reader.result); }
        catch (e) { return App.confirm('That file is not valid JSON.', 'OK'); }
        // accept either the wrapped payload or a bare data object
        const data = parsed && parsed.data ? parsed.data : parsed;
        const looksValid = data && (Array.isArray(data.logEntries) || Array.isArray(data.workingMaxes) ||
          Array.isArray(data.cycles) || Array.isArray(data.benchmarks));
        if (!looksValid) return App.confirm('This does not look like a Finger Trainer backup.', 'OK');
        const counts = `${(data.logEntries || []).length} logs, ${(data.workingMaxes || []).length} working maxes, ${(data.cycles || []).length} cycles, ${(data.benchmarks || []).length} benchmarks`;
        App.confirm(`Restore this backup? It will merge ${counts} into your current data (duplicates are collapsed automatically).`, 'Restore', async () => {
          try {
            await DB.importBackup(data);
            await DB.dedupe();
            App.confirm('Backup restored.', 'OK', () => App.go('today'));
          } catch (e) {
            App.confirm('Restore failed: ' + ((e && e.message) || e), 'OK');
          }
        });
      };
      reader.readAsText(file);
    });
    input.click();
  };

  App.resetData = function () {
    App.confirm('Reset ALL data? This deletes every log, working max, and cycle.', 'Continue', () => {
      App.confirm('Are you absolutely sure? This cannot be undone.', 'Delete everything', async () => {
        await DB.resetAll(); await DB.seedIfEmpty(); App.go('today');
      });
    });
  };

  // ---- session-end logging (called by Runner) --------------------------
  App.logSession = async function (plan, result) {
    const bw = (await DB.getMeta('bodyweightKg')) || null;
    const entry = {
      id: Templates.uid(), date: todayISO(), type: plan.role === 'OIprimer' ? 'OI' : 'Yielding',
      role: plan.role, venue: 'Board', hangDurationSeconds: plan.duration || null, grip: 'HalfCrimp',
      topSetLoadKg: result.load != null ? result.load : null,
      topSetRPE: result.rpe != null ? result.rpe : null, sets: result.sets,
      bodyweightKg: bw, taxing: result.taxing, feltStrong: result.felt, nextDayFeel: null,
      block: plan.blockName || '', notes: result.notes || ''
    };
    await DB.addLog(entry);
    await DB.setMeta('pendingNextDayFeel', { logEntryId: entry.id, sessionDate: entry.date });
    if (plan.role === 'Test' && entry.topSetLoadKg) await maybeBenchmark(entry);
    App.go('today');
  };

  // ---- boot -------------------------------------------------------------
  document.body.addEventListener('touchstart', () => {}, { passive: true });
  document.querySelectorAll('#tabbar .tab').forEach(t =>
    t.addEventListener('click', () => App.go(t.dataset.tab)));

  (async function init() {
    try {
      await DB.seedIfEmpty();
      await DB.dedupe(); // clean up any duplicate/triplicate rows from past syncs
    } catch (err) {
      console.error('Init error:', err);
    }
    App.go('today'); // render() has its own error boundary
  })();
})();

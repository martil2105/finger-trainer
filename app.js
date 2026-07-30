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
    // Children are coerced defensively (fuzz-hardened 2026-07-06): a corrupt
    // record with e.g. an object in `notes` used to reach appendChild and
    // kill the whole tab. null/undefined are skipped; non-nodes render as text.
    (children || []).forEach(c => {
      if (c == null) return;
      if (typeof c === 'string') { n.appendChild(document.createTextNode(c)); return; }
      n.appendChild(c && typeof c === 'object' && c.nodeType ? c : document.createTextNode(String(c)));
    });
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

    if (structRole === 'Pickup') {
      // One-handed edge block pulls. No `anchor`: this program never
      // prescribes a load. Both the ramp and the back-offs are percentages —
      // the ramp of each hand's last CLEAN top set, the back-offs of the top
      // set found today — so the only reference is history, which renderToday
      // attaches as `lastTop` (buildPlan is sync and has no DB access).
      return { rest: false, role: 'Pickup', week: wk, blockName: week.blockName,
        modality: 'pickup',
        duration: week.heavyDuration, rpe: week.heavyRPE, protocol: week.heavyProtocol,
        sets: week.heavySets, repsPerSet: week.repsPerSet, rampPcts: week.rampPcts,
        backoffPctOfTop: week.backoffPctOfTop, intraRestSeconds: 20,
        edgeMm: week.edgeMm, grip: week.grip,
        anchor: null, lastTop: null, firstHand: 'L', isLastBlockWeek };
    }
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

  // Most recent CLEAN top set per hand, from newest-first logs.
  // "Clean" is load-bearing here: the ramp and every back-off key off this
  // number, so anchoring to a session where the position broke would carry a
  // load forward that was never actually expressed in position — the error
  // compounds week over week and nothing in the numbers would show it.
  App.lastCleanTops = function (logs) {
    const out = { L: null, R: null, dates: { L: null, R: null }, staleL: false, staleR: false };
    Calc.HANDS.forEach(h => {
      let fallback = null, fallbackDate = null;
      for (let i = 0; i < logs.length; i++) {
        const l = logs[i];
        if (!Calc.isPickup(l)) continue;
        const load = Calc.topLoad(l, h);
        if (load == null) continue;
        if (Calc.topSetDegraded(l, h)) {
          if (fallback == null) { fallback = load; fallbackDate = l.date; }
          continue;
        }
        out[h] = load; out.dates[h] = l.date;
        return;
      }
      // Every logged top set for this hand broke position — fall back to the
      // most recent one rather than showing nothing, but say so.
      if (fallback != null) { out[h] = fallback; out.dates[h] = fallbackDate; out['stale' + h] = true; }
    });
    return out;
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

    // header: logo tile + week/block + next benchmark
    const curWeek = weeks[(plan.week || 1) - 1];
    const nextTest = weeks.find(w => w.isDeloadTest && w.weekNumber >= (plan.week || 1));
    const nextTestIso = nextTest ? testDayIso(cycle, nextTest) : null;
    const headerRow = el('div', { class: 'brand-header' }, [
      el('img', { class: 'brand-logo', src: 'icons/icon-192.png', alt: 'Finger Trainer' }),
      el('div', { class: 'brand-info' }, [
        el('h1', null, [curWeek ? `Week ${curWeek.weekNumber} · ${curWeek.blockName}` : cycle.name]),
        el('p', { class: 'sub' }, [
          nextTest ? `Benchmark test W${nextTest.weekNumber} · ${fmtDate(nextTestIso)}` : 'No upcoming test'
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
        if (entry) { entry.nextDayFeel = v; await DB.save('logEntries', entry); }
        await DB.setMeta('pendingNextDayFeel', null);
        App.render();
        if (window.Sync && Sync.auto) Sync.auto({ force: true });
      });
      card.appendChild(r);
      view.appendChild(card);
    }

    // recovery banner (advisory, never a blocker)
    const logs = await DB.logsNewestFirst();
    const rec = Calc.recoveryFlag(logs);
    if (rec.flagged) {
      const lastFeel = (logs.find(l => l.nextDayFeel != null) || {}).nextDayFeel;
      view.appendChild(el('div', { class: 'banner warn' }, [
        el('p', { style: 'margin:0' }, lastFeel != null
          ? ['Yesterday felt ', el('b', null, [`${lastFeel}/5`]),
             ' — consider one fewer back-off set today. ',
             el('span', { class: 'fine' }, ['(Suggestion, not a rule.)'])]
          : ['Recovery trending down — consider dropping a set or taking an extra rest day. ',
             el('span', { class: 'fine' }, ['(Suggestion, not a rule.)'])])
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
        el('p', { class: 'muted', style: 'margin:0 0 6px' }, [plan.note || 'No fingers today. Sleep + mobility.']),
        next ? el('p', { class: 'sub', style: 'margin:0' }, [`Next session: ${next.label} — ${fmtDate(next.date)}`]) : el('span', null, [''])
      ]));
    } else if (plan.modality === 'pickup') {
      const tops = App.lastCleanTops(logs);
      await attachPickupRefs(plan, logs);
      view.appendChild(pickupSessionCard(plan, { blockType: curWeek && curWeek.blockType, tops }));
    } else {
      const lastSession = logs.find(l => l.type === 'Yielding' && l.hangDurationSeconds === plan.duration && l.topSetLoadKg != null);
      view.appendChild(sessionCard(plan, { blockType: curWeek && curWeek.blockType, lastSession }));
    }

    // pick a different workout
    view.appendChild(el('button', { class: 'btn secondary', onclick: () => showWorkoutPicker(cycle, weeks, wmFor, plan) }, ['Do a different workout →']));

    // log-without-runner quick action
    const pickupCycle = (cycle && cycle.modality === 'pickup') || plan.modality === 'pickup';
    view.appendChild(el('button', { class: 'btn secondary',
      onclick: () => pickupCycle ? App.openPickupLog() : App.openManualLog() }, ['Log a session manually']));
    if (pickupCycle) {
      view.appendChild(el('button', { class: 'btn ghost small',
        onclick: () => App.openManualLog() }, ['Log a hang session instead']));
    }
  }

  // Fill the runtime references a pickup plan can't know statically: each
  // hand's last clean top set (the ramp basis) and which hand leads. Hand
  // order is fixed per athlete rather than alternated — swapping it would put
  // an unmodelled order effect into a dataset whose whole point is that the
  // sessions are identical.
  async function attachPickupRefs(plan, logs) {
    const tops = App.lastCleanTops(logs || await DB.logsNewestFirst());
    plan.lastTop = { L: tops.L, R: tops.R };
    plan.firstHand = (await DB.getMeta('pickupFirstHand')) === 'R' ? 'R' : 'L';
    return plan;
  }

  function pickupSessionCard(plan, ctx) {
    const c = el('div', { class: 'card', style: 'padding:16px' });
    const tops = (ctx && ctx.tops) || { L: null, R: null, dates: {} };
    c.appendChild(el('div', { class: 'row' }, [
      el('h2', { style: 'margin:0;font-size:18px' }, ['Block pull']),
      el('span', { class: 'tint-chip blue',
        style: 'text-transform:uppercase;letter-spacing:0.6px;font-size:10px;font-weight:800;padding:5px 11px' },
        [plan.edgeMm ? plan.edgeMm + 'MM' : 'PICKUP'])
    ]));
    const bits = [];
    if (plan.repsPerSet) bits.push(`${plan.repsPerSet} × ${plan.duration}s`);
    bits.push(`top set + ${plan.sets} back-offs`);
    bits.push('per hand · alternating');
    c.appendChild(el('p', { class: 'sc-meta' }, [bits.join(' · ')]));

    // Per-hand reference. Explicitly NOT a prescription — the top set is
    // discovered, and this is only what it was last time.
    const grid = el('div', { class: 'grid2', style: 'margin:10px 0' });
    Calc.HANDS.forEach(h => {
      const v = tops[h];
      const stale = tops['stale' + h];
      grid.appendChild(el('div', null, [
        el('p', { class: 'micro anchor-label' }, [h === 'L' ? 'Left · last clean' : 'Right · last clean']),
        v != null
          ? el('div', { class: 'hero-readout', style: 'margin:0' }, [
              el('span', { class: 'hero-num', 'data-countup': '' }, [String(v)]),
              el('span', { class: 'hero-unit' }, ['kg'])
            ])
          : el('div', { style: 'font-size:18px;font-weight:800' }, ['find it']),
        el('p', { class: 'anchor-last', style: 'margin:2px 0 0' }, [
          v == null ? 'no history yet'
            : stale ? 'position broke last time — repeat it'
            : (tops.dates && tops.dates[h] ? fmtDate(tops.dates[h]) : '')
        ])
      ]));
    });
    c.appendChild(grid);

    if (plan.rampPcts && plan.rampPcts.length) {
      const ladderFor = (h) => tops[h] == null ? null
        : plan.rampPcts.map(p => Calc.roundTo05(tops[h] * p) + 'kg').join(' → ');
      const lL = ladderFor('L'), lR = ladderFor('R');
      c.appendChild(el('div', { class: 'callout' }, [
        lL || lR
          ? `Ramp (1 rep each, hands alternating): L ${lL || '—'} · R ${lR || '—'}. Prime, don't fatigue.`
          : `Ramp at ${plan.rampPcts.map(p => Math.round(p * 100) + '%').join(' → ')} of your top set — first session, so find it by feel in small steps.`
      ]));
    }

    c.appendChild(el('div', { class: 'callout' }, [
      `Top set: ${plan.repsPerSet} reps at RIR 1–2, judged against technical failure — the rep where position would break. ` +
      `Back-offs: ${plan.sets} sets at ${Math.round((plan.backoffPctOfTop || 0.88) * 100)}% of today's top. Reps are fixed; don't stop on feel.`
    ]));
    c.appendChild(el('p', { class: 'rules-line' }, [
      'Ramp to the weight over ~2s, no snatch. A rep where the fingers rolled open is logged degraded and will not advance the load. Pain stops the session.'
    ]));
    if (plan.note) c.appendChild(el('p', { class: 'muted' }, [plan.note]));
    c.appendChild(el('button', { class: 'btn start', onclick: () => Runner.start(plan) }, ['Start session']));
    return c;
  }

  function showWorkoutPicker(cycle, weeks, wmFor, todayPlan) {
    const weekNum = (todayPlan && todayPlan.week) || 1;
    // Walk the 7 days of this cycle-week and collect any non-rest plans
    const weekStartIso = Calc.addDays(cycle.startDate, (weekNum - 1) * 7);
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const roleLabelMap = { Heavy: 'Heavy yielding', Volume: 'Volume yielding', OIprimer: 'OI primer',
                           Test: 'Benchmark test', Deload: 'Deload', Pickup: 'Block pull' };

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
      const btn = el('button', { class: 'list-item', onclick: async () => {
        App.closeSheet();
        // Pickup plans carry no anchors until history is attached (see
        // attachPickupRefs) — starting one straight from the picker would
        // otherwise ramp off nothing.
        if (plan.modality === 'pickup') await attachPickupRefs(plan);
        Runner.start(plan);
      } });
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

  function sessionCard(plan, ctx) {
    const c = el('div', { class: 'card', style: 'padding:16px' });
    const roleLabel = { Heavy: 'Heavy yielding', Volume: 'Volume yielding', OIprimer: 'OI primer',
                        Test: 'Benchmark test', Deload: 'Deload' }[plan.role] || plan.role;
    const tagMap = { Accumulation: 'Accum', Transmutation: 'Trans', Peak: 'Peak',
                     Realization: 'Real', DeloadTest: 'Test', TopSet: 'Top' };
    const tagTxt = (ctx && tagMap[ctx.blockType]) || plan.blockName || '';
    const tagTone = (plan.role === 'Test' || plan.role === 'Deload') ? 'amber' : 'blue';
    c.appendChild(el('div', { class: 'row' }, [
      el('h2', { style: 'margin:0;font-size:18px' }, [roleLabel]),
      tagTxt ? el('span', { class: `tint-chip ${tagTone}`,
        style: 'text-transform:uppercase;letter-spacing:0.6px;font-size:10px;font-weight:800;padding:5px 11px' }, [tagTxt])
             : el('span', null, [''])
    ]));
    const bits = [];
    if (plan.duration) bits.push(`${plan.duration}s hangs`);
    if (plan.rpe) bits.push(`@${plan.rpe}`);
    if (plan.sets) bits.push(`${plan.sets} ${plan.role === 'Heavy' && plan.protocol === 'topSetPlusBackoffs' ? 'back-offs' : plan.protocol === 'maxSingles' ? 'singles' : 'sets'}`);
    bits.push(plan.protocol === 'maxSingles' ? '4–5 min rest' : '3 min rest');
    c.appendChild(el('p', { class: 'sc-meta' }, [bits.join(' · ')]));

    if (plan.anchor != null || plan.role === 'OIprimer') {
      const aRow = el('div', { class: 'anchor-row' });
      const left = el('div');
      left.appendChild(el('p', { class: 'micro anchor-label' }, ['Anchor']));
      left.appendChild(plan.anchor != null
        ? el('div', { class: 'hero-readout', style: 'margin:0' }, [
            el('span', { class: 'hero-num', 'data-countup': '' }, [`~${plan.anchor}`]),
            el('span', { class: 'hero-unit' }, ['kg'])
          ])
        : el('div', { style: 'font-size:20px;font-weight:800' }, ['Bodyweight / max intent']));
      aRow.appendChild(left);
      const lastS = ctx && ctx.lastSession;
      if (lastS) {
        aRow.appendChild(el('p', { class: 'anchor-last' }, [
          'last session', el('br'),
          `${lastS.topSetLoadKg} kg · felt @${lastS.topSetRPE != null ? lastS.topSetRPE : '?'}`
        ]));
      }
      c.appendChild(aRow);
    }
    if (plan.backoffAnchor != null) {
      c.appendChild(el('p', { class: 'muted', style: 'margin:0 0 10px' }, [`Back-offs around ~${plan.backoffAnchor} kg (@7–8, ~4–5 kg below top).`]));
    }
    if (plan.wmMissing) {
      c.appendChild(el('div', { class: 'banner danger' }, [`No ${plan.duration}s Working Max on file — set a benchmark for a correct anchor.`]));
    }

    // Fixed warm-up ladder (shown when the program defines one)
    if (plan.warmup && plan.warmup.length) {
      const ladder = plan.warmup.map((s, i) => `Set ${i + 1}: +${s.load}kg @${s.rpe}`).join('  ·  ');
      c.appendChild(el('div', { class: 'callout' }, [`Warm-up ladder (fixed · ${plan.duration}s · 2–3 min rest): ${ladder}. Prime the flexors, don't fatigue.`]));
      const last = plan.warmup[plan.warmup.length - 1];
      c.appendChild(el('p', { class: 'rules-line' }, [`Readiness check at +${last.load}kg: feels @8+ → reduce top-set expectation · @9+ or any joint discomfort → warm-up only, then go climb.`]));
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
      c.appendChild(el('p', { class: 'rules-line' }, [
        `3–5 quality singles only. 4–5 min full rest between efforts. ${rpeNote} Fatigue stop: load must drop >5% to maintain @9, grip breaks before second 2s, or any joint discomfort.`
      ]));
    } else if (plan.role === 'Heavy') {
      c.appendChild(el('div', { class: 'callout' }, [
        `Find today's top set — RPE leads (target @${plan.rpe}). WM anchor: ~${plan.anchor} kg. Load up/down freely. Back-offs: ${plan.sets} sets at genuinely @7–8 (~${plan.anchor - plan.backoffAnchor} kg lighter than top).`
      ]));
      c.appendChild(el('p', { class: 'rules-line' }, [
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
      c.appendChild(el('p', { class: 'rules-line' }, [
        `RPE creep rule: if RPE creeps to @8.5+ by set 3, drop load 5% and finish remaining sets. End early only if joint discomfort.`
      ]));
    }
    if (plan.note) c.appendChild(el('p', { class: 'muted' }, [plan.note]));

    c.appendChild(el('button', { class: 'btn start', onclick: () => Runner.start(plan) }, ['Start session']));
    return c;
  }

  function upcomingSession(cycle, weeks, wmFor) {
    for (let i = 1; i <= 14; i++) {
      const d = Calc.addDays(todayISO(), i);
      const p = App.buildPlan(cycle, weeks, d, wmFor);
      if (!p.rest) return { date: d, label: { Heavy: 'Heavy', Volume: 'Volume', OIprimer: 'OI primer', Test: 'Test', Deload: 'Deload', Pickup: 'Block pull' }[p.role] || p.role };
    }
    return null;
  }

  // =====================================================================
  // PROGRAM (timeline + builder toggle)
  // =====================================================================
  App.state.programView = 'timeline';
  App.state.expandedWeek = null;

  function toggleWeek(n) {
    const wasOpen = App.state.expandedWeek === n;
    const closing = App.state.expandedWeek != null
      ? document.querySelector(`.collapse-host[data-week="${App.state.expandedWeek}"]`) : null;
    const opening = document.querySelector(`.collapse-host[data-week="${n}"]`);
    App.state.expandedWeek = wasOpen ? null : n;
    if (window.Motion && Motion.toggleHeight) {
      if (closing && closing !== opening) Motion.toggleHeight(closing, false);
      if (opening) Motion.toggleHeight(opening, !wasOpen);
    } else {
      if (closing && closing !== opening) closing.classList.remove('open');
      if (opening) opening.classList.toggle('open', !wasOpen);
    }
  }

  async function renderProgram(view) {
    const cycle = await DB.activeCycle();

    // Builder (block editor) keeps its own screen behind "Edit blocks →"
    if (App.state.programView === 'builder') {
      view.appendChild(el('div', { class: 'row', style: 'margin:4px 0 10px;align-items:baseline' }, [
        el('h1', { style: 'margin:0' }, ['Program']),
        el('button', { class: 'textbtn', onclick: () => { App.state.programView = 'timeline'; App.render(); } }, ['← Timeline'])
      ]));
      await Builder.renderList(view);
      return;
    }

    view.appendChild(el('div', { class: 'row', style: 'margin:4px 0 0;align-items:baseline' }, [
      el('h1', { style: 'margin:0' }, ['Program']),
      el('button', { class: 'textbtn', onclick: () => { App.state.programView = 'builder'; App.render(); } }, ['Edit blocks →'])
    ]));
    if (!cycle) {
      view.appendChild(el('p', { class: 'sub', style: 'margin:3px 0 14px' }, ['No active cycle']));
      view.appendChild(el('div', { class: 'card' }, ['No active cycle. Tap "Edit blocks →" to create or activate one.']));
      return;
    }
    const wmFor = await wmForFn();
    const weeks = App.getWeeks(cycle, wmFor);
    const curWk = Calc.weekNumberFor(cycle, todayISO());
    view.appendChild(el('p', { class: 'sub', style: 'margin:3px 0 14px' },
      [`${cycle.name} · ${curWk ? `Week ${curWk} of ${weeks.length}` : `${weeks.length} weeks`}`]));

    // ---- cycle allocation card ----
    const bandColor = { Accumulation: '#33B94F', Transmutation: '#3D87F5', Peak: '#F04E4E',
                        Realization: '#9B6DF3', DeloadTest: '#F6A723', TopSet: '#3D87F5', Custom: '#A5A5BE' };
    const bandTag = { Accumulation: 'ACCUM', Transmutation: 'TRANS', Peak: 'PEAK',
                      Realization: 'REAL', DeloadTest: 'TEST', TopSet: 'TOP', Custom: 'CUST' };
    const nextTest = weeks.find(w => w.isDeloadTest && w.weekNumber >= (curWk || 1));
    const nextTestIso = nextTest ? testDayIso(cycle, nextTest) : null;
    const daysToTest = nextTestIso ? Calc.daysBetween(todayISO(), nextTestIso) : null;

    const alloc = el('div', { class: 'card', style: 'padding:14px;margin-top:0' });
    alloc.appendChild(el('div', { class: 'row', style: 'margin-bottom:12px' }, [
      el('span', { class: 'micro' }, ['Cycle']),
      (daysToTest != null && daysToTest >= 0)
        ? el('span', { class: 'tint-chip amber' },
            [daysToTest === 0 ? 'benchmark today' : `benchmark in ${daysToTest} day${daysToTest === 1 ? '' : 's'}`])
        : el('span', { class: 'tint-chip blue' }, [`${weeks.length} weeks`])
    ]));
    const segs = [];
    weeks.forEach(w => {
      const lastSeg = segs[segs.length - 1];
      if (lastSeg && lastSeg.type === w.blockType) lastSeg.n += 1;
      else segs.push({ type: w.blockType, n: 1 });
    });
    const wrap = el('div', { class: 'alloc-wrap' });
    const totalDays = weeks.length * 7;
    const elapsed = Math.min(Math.max(Calc.daysBetween(cycle.startDate, todayISO()), 0), totalDays);
    if (curWk) {
      const pct = ((elapsed / (totalDays || 1)) * 100).toFixed(1);
      wrap.appendChild(el('div', { class: 'alloc-now', style: `left:${pct}%` }));
      wrap.appendChild(el('div', { class: 'alloc-now-pill', style: `left:${pct}%` }, ['now']));
    }
    const track = el('div', { class: 'alloc-track' });
    const tags = el('div', { class: 'alloc-tags' });
    segs.forEach(s => {
      const c = bandColor[s.type] || '#A5A5BE';
      track.appendChild(el('div', { class: 'alloc-seg', style: `flex:${s.n};background:${c}` }));
      tags.appendChild(el('span', { class: 'alloc-tag', style: `flex:${s.n};color:${c}` },
        [bandTag[s.type] || String(s.type || '').toUpperCase().slice(0, 6)]));
    });
    wrap.appendChild(track);
    wrap.appendChild(tags);
    alloc.appendChild(wrap);
    alloc.appendChild(el('div', { class: 'alloc-dates' }, [
      el('span', null, [fmtShort(cycle.startDate)]),
      nextTestIso ? el('span', { class: 'amber' }, [`test · ${fmtShort(nextTestIso)}`])
                  : el('span', null, [fmtShort(Calc.addDays(cycle.startDate, totalDays - 1))])
    ]));
    view.appendChild(alloc);

    // ---- stepping-stone week list ----
    if (App.state.expandedWeek == null) App.state.expandedWeek = curWk || 1;
    // Dates that actually have a logged session — a past scheduled day is only
    // "done" if something was logged that day (green used to mean merely
    // "the date has passed", which showed skipped workouts as completed).
    const progLogs = await DB.logsNewestFirst();
    const loggedDates = new Set(progLogs.map(l => l.date));
    const hasVolumeDay = Object.values(cycle.weeklyStructure || {}).includes('Volume');
    const dayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const list = el('div', { style: 'margin-top:14px' });
    weeks.forEach((w, idx) => {
      const isCur = w.weekNumber === curWk;
      const isDone = curWk != null && w.weekNumber < curWk;
      const isTest = !!w.isDeloadTest;
      const row = el('div', { class: 'wk-row' });
      const colL = el('div', { class: 'wk-col' });
      colL.appendChild(el('div', { class: 'wk-tile' + (isCur ? ' current' : isDone ? ' done' : isTest ? ' test' : '') },
        ['W' + w.weekNumber]));
      if (idx < weeks.length - 1) colL.appendChild(el('div', { class: 'wk-rail' }));
      row.appendChild(colL);

      const card = el('button', { class: 'wk-card' + (isCur ? ' current' : isTest ? ' test' : ''),
        onclick: () => toggleWeek(w.weekNumber) });
      const chipCls = isDone ? 'done' : isCur ? 'current' : isTest ? 'benchmark' : '';
      const chipTxt = isDone ? 'Done' : isCur ? 'Current' : isTest ? 'Benchmark' : 'Upcoming';
      card.appendChild(el('div', { class: 'row', style: 'gap:8px' }, [
        el('span', { class: 'wk-title' }, [w.blockName]),
        el('span', { class: 'status-chip ' + chipCls }, [chipTxt])
      ]));
      const line = w.isDeloadTest
        ? `Deload @6 + test ${w.testDurations.join('/')}s · anchor ~${kg(w.deloadAnchorKg)}`
        : hasVolumeDay
          ? `Heavy ${w.heavyDuration}s @${w.heavyRPE} ~${kg(w.heavyAnchorKg)} · Vol ${Math.round((w.volumePct || 0) * 100)}% ~${kg(w.volumeAnchorKg)}`
          : `Top set ${w.heavyDuration}s @${w.heavyRPE} ~${kg(w.heavyAnchorKg)} · ${w.heavySets} back-offs ~${kg(w.backoffAnchorKg)}`;
      card.appendChild(el('p', { class: 'wk-meta' }, [line]));
      if (isTest) {
        card.appendChild(el('p', { class: 'wk-testnote' },
          [`${w.testDurations.join('s + ')}s benchmark — sets the anchors for your next cycle. Come in fresh.`]));
      }

      // expandable session rows (whole card is the tap target)
      const host = el('div', { class: 'collapse-host' + (App.state.expandedWeek === w.weekNumber ? ' open' : ''),
        'data-week': w.weekNumber });
      const detail = el('div', { class: 'wk-detail' });
      let sawNext = false;
      for (let i = 0; i < 7; i++) {
        const dIso = Calc.addDays(w.startDate, i);
        const p = App.buildPlan(cycle, weeks, dIso, wmFor);
        if (p.rest) continue;
        const roleTxt = { Heavy: 'Heavy', Volume: 'Volume', OIprimer: 'OI primer', Test: 'Benchmark test', Deload: 'Deload' }[p.role] || p.role;
        const bits = [roleTxt];
        if (p.duration) bits.push(p.duration + 's');
        if (p.rpe) bits.push('@' + p.rpe);
        if (p.sets) bits.push(p.sets + ' sets');
        if (p.anchor != null) bits.push('~' + p.anchor + ' kg');
        let dotCls = p.role === 'Test' ? 'test' : 'future';
        if (loggedDates.has(dIso)) dotCls = 'done';                      // actually logged
        else if (dIso < todayISO()) dotCls = 'missed';                   // scheduled, passed, no log
        else if (!sawNext && isCur) { if (p.role !== 'Test') dotCls = 'next'; sawNext = true; }
        detail.appendChild(el('div', { class: 'sess-row' }, [
          el('span', { class: 'sess-dot ' + dotCls }),
          el('span', { class: 'sess-day' }, [dayShort[new Date(dIso + 'T00:00:00').getDay()]]),
          el('span', { class: 'sess-txt' }, [bits.join(' · ')])
        ]));
      }
      host.appendChild(detail);
      card.appendChild(host);
      row.appendChild(card);
      list.appendChild(row);
    });
    view.appendChild(list);
    view.appendChild(el('p', { class: 'hint', style: 'margin:0 0 0 58px' },
      ['Tap a week to expand · blocks and cycle length are editable']));
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
  // ANALYTICS (Daylight Chunky: verdict-first)
  // =====================================================================
  App.state.analyticsRange = 'all';   // All is the primary range; Cycle is the drill-down

  // Test day within a deload/test week = the week's Heavy slot (presentation helper)
  function testDayIso(cycle, w) {
    let dIso = w.startDate;
    const ws = (cycle && cycle.weeklyStructure) || {};
    const heavyDow = Object.keys(ws).find(d => ws[d] === 'Heavy');
    if (heavyDow && w.startDate) {
      const d = new Date(w.startDate + 'T00:00:00');
      d.setDate(d.getDate() + ((DOW.indexOf(heavyDow) - d.getDay() + 7) % 7));
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      dIso = d.toISOString().slice(0, 10);
    }
    return dIso;
  }
  function monthShort(iso) { return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short' }); }
  function dowShort(iso) { return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' }); }

  App.state.analyticsModality = null;   // null = auto-pick on first render

  const HAND_COLOR = { L: '#F0A24E', R: '#3D87F5' };   // same as the runner
  const HAND_NAME = { L: 'Left', R: 'Right' };

  async function renderAnalytics(view) {
    const allLogs = (await DB.logsNewestFirst()).slice().reverse(); // oldest -> newest
    const anyPickup = allLogs.some(l => Calc.isPickup(l));
    const anyHang = allLogs.some(l => !Calc.isPickup(l) && l.e1rmKg != null);
    if (App.state.analyticsModality == null) {
      App.state.analyticsModality = anyPickup ? 'pickup' : 'hang';
    }
    const mode = App.state.analyticsModality;

    // Modality switch sits ABOVE the range toggle. Hang and pickup loads are
    // not on the same scale and never share an axis — a hang number is ADDED
    // weight on top of bodyweight across two hands, a pickup number is the
    // whole force on one hand. They happen to land in a similar range, which
    // makes silently mixing them the most plausible way to get a chart that
    // looks fine and means nothing.
    if (anyPickup && anyHang) {
      view.appendChild(el('div', { class: 'row', style: 'margin:4px 0 8px' }, [
        el('h1', { style: 'margin:0' }, ['Analytics']),
        el('div', { class: 'seg' }, [
          el('button', { class: mode === 'pickup' ? 'sel' : '', onclick: () => { App.state.analyticsModality = 'pickup'; App.render(); } }, ['Pickup']),
          el('button', { class: mode === 'hang' ? 'sel' : '', onclick: () => { App.state.analyticsModality = 'hang'; App.render(); } }, ['Hang'])
        ])
      ]));
      if (mode === 'pickup') return renderPickupAnalytics(view, allLogs);
      view.appendChild(el('p', { class: 'card-note', style: 'margin:-4px 0 10px' }, ['Hangboard history — separate scale from block pulls.']));
      return renderHangAnalytics(view, allLogs, true);
    }
    if (mode === 'pickup' && anyPickup) {
      view.appendChild(el('h1', { style: 'margin:4px 0 10px' }, ['Analytics']));
      return renderPickupAnalytics(view, allLogs);
    }
    return renderHangAnalytics(view, allLogs, false);
  }

  async function renderHangAnalytics(view, preLogs, headerDone) {
    // header row: title + Cycle | All range toggle
    view.appendChild(el('div', { class: 'row', style: 'margin:4px 0 10px' }, [
      headerDone ? el('span', null, ['']) : el('h1', { style: 'margin:0' }, ['Analytics']),
      el('div', { class: 'seg' }, [
        el('button', { class: App.state.analyticsRange === 'all' ? 'sel' : '', onclick: () => { App.state.analyticsRange = 'all'; App.render(); } }, ['All']),
        el('button', { class: App.state.analyticsRange === 'cycle' ? 'sel' : '', onclick: () => { App.state.analyticsRange = 'cycle'; App.render(); } }, ['Cycle'])
      ])
    ]));

    const logs = preLogs || (await DB.logsNewestFirst()).slice().reverse(); // oldest -> newest
    const yielding = logs.filter(l => l.type === 'Yielding' && l.e1rmKg != null);
    const cycle = await DB.activeCycle();
    const wmFor = await wmForFn();
    const weeks = cycle ? App.getWeeks(cycle, wmFor) : [];
    const curWk = cycle ? Calc.weekNumberFor(cycle, todayISO()) : null;
    const cycStart = cycle ? cycle.startDate : null;
    const benches = (await DB.getAll('benchmarks')).sort((a, b) => (a.date < b.date ? -1 : 1));

    // ---- personal RPE→%max curve (display-only; rpe_cal.js) -------------
    // When the athlete's own RPE spacing validates out-of-sample (strict
    // gate inside fitRpeCurve), every Analytics series below is recomputed
    // through it from load+RPE. Stored e1rmKg, WMs, anchors, and all
    // training math stay on the generic table — calc.js is untouched.
    const rpePts = yielding
      .filter(l => l.topSetLoadKg != null && l.topSetRPE != null)
      .map(l => ({ date: l.date, load: l.topSetLoadKg, rpe: l.topSetRPE, dur: l.hangDurationSeconds }));
    benches.forEach(b => {
      if (b.maxLoadKg != null && b.rpe != null) rpePts.push({ date: b.date, load: b.maxLoadKg, rpe: b.rpe, dur: b.durationSeconds });
    });
    const rpeCal = (typeof fitRpeCurve === 'function') ? fitRpeCurve(rpePts) : { k: 0.06, source: 'default', n: 0 };
    const calOn = rpeCal.source === 'calibrated';
    // 5s-equivalent E1RM (3s ÷1.1, same pipeline as calc.js) — personal curve
    // when calibrated + inputs exist, else the stored value.
    const pE1eq = (l) => {
      if (calOn && l.topSetLoadKg != null && l.topSetRPE != null) {
        const v = rpeCal.e1rm(l.topSetLoadKg, l.topSetRPE, l.hangDurationSeconds);
        if (v != null) return v;
      }
      return l.e1rmKg;
    };
    // Raw 3s E1RM: duration passed as 5 skips the ÷1.1 5s-normalisation
    const pE1raw3 = (l) => {
      if (calOn && l.topSetLoadKg != null && l.topSetRPE != null) {
        const v = rpeCal.e1rm(l.topSetLoadKg, l.topSetRPE, 5);
        if (v != null) return v;
      }
      return l.topSetLoadKg != null ? Calc.e1rm(l.topSetLoadKg, l.topSetRPE, 5) : Calc.roundTo(l.e1rmKg * 1.1, 1);
    };

    // series: per-session for the cycle view, per-benchmark for all-time
    // rpe rides along for the Kalman filter's per-session noise weighting
    // (kalman_data.js); every other consumer reads x/y only and ignores it.
    const s5all = yielding.filter(l => l.hangDurationSeconds === 5).map(l => ({ x: l.date, y: pE1eq(l), rpe: l.topSetRPE }));
    const s3all = yielding.filter(l => l.hangDurationSeconds === 3).map(l => ({ x: l.date, y: pE1eq(l) }));
    const inCyc = p => !cycStart || p.x >= cycStart;
    const s5cyc = s5all.filter(inCyc), s3cyc = s3all.filter(inCyc);
    const s3raw = yielding.filter(l => l.hangDurationSeconds === 3).map(l => ({
      x: l.date,
      y: pE1raw3(l),
      rpe: l.topSetRPE
    }));
    const isAll = App.state.analyticsRange === 'all';
    const r5 = isAll ? s5all : s5cyc;      // 5s sessions
    const r3eq = isAll ? s3all : s3cyc;    // 3s sessions as 5s-equivalent (stored e1rmKg)
    const r3raw = isAll ? s3raw : s3raw.filter(inCyc);
    // Single continuous 5s-equivalent timeline: 5s points solid; 3s points
    // carry dashedPrev so every segment ENTERING them draws dashed, and is3s
    // so their markers render hollow (lineChart's per-segment state machine).
    const combined = r5.map(p => ({ x: p.x, y: p.y }))
      .concat(r3eq.map(p => ({ x: p.x, y: p.y, is3s: true, dashedPrev: true })))
      .sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0));
    const nextTest = weeks.find(w => w.isDeloadTest && w.weekNumber >= (curWk || 1));
    const nextTestIso = nextTest ? testDayIso(cycle, nextTest) : null;

    // ---- hero: 5s E1RM trend (5s solid · 3s-as-5s-eq dashed) ----
    const hero = el('div', { class: 'card', style: 'padding:16px 14px 12px;margin-top:0' });
    const lastEq = combined.length ? combined[combined.length - 1].y : null;
    const last3raw = r3raw.length ? r3raw[r3raw.length - 1].y : null;
    const delta = combined.length >= 2 ? Calc.roundTo(combined[combined.length - 1].y - combined[0].y, 1) : null;
    hero.appendChild(el('div', { class: 'row' }, [
      el('span', { class: 'micro' }, ['5s E1RM']),
      delta != null
        ? el('span', { class: 'tint-chip ' + (delta >= 0 ? 'green' : 'amber') },
            [`${delta >= 0 ? '+' : '−'}${Math.abs(delta)} kg ${isAll ? 'all-time' : 'this cycle'}`])
        : el('span', { class: 'micro' }, [''])
    ]));
    hero.appendChild(el('div', { class: 'hero-readout' }, [
      el('span', { class: 'hero-num', 'data-countup': '' }, [lastEq != null ? String(lastEq) : '—']),
      el('span', { class: 'hero-unit' }, ['kg']),
      el('span', { class: 'hero-side' }, [last3raw != null ? `3s raw · ${last3raw} kg` : ''])
    ]));
    if (combined.length >= 2) {
      hero.appendChild(lineChart([
        { pts: combined, color: '#3D87F5', name: '5s hang', trendColor: '#3D87F5' }
      ], 'kg', { movingAvg: true, prMarkers: true }));
      hero.appendChild(el('p', { class: 'card-note', style: 'margin:4px 0 0' },
        ['solid = 5s hangs · dashed/hollow = 3s hangs (5s-eq) · thin = trend · ' +
         (calOn
           ? `RPE curve: personal, ${(rpeCal.k * 100).toFixed(1)}%/pt (n=${rpeCal.n}, holds up out-of-sample) — applied to all Analytics series`
           : 'RPE curve: generic 6%/pt (personal curve needs more sessions with varied RPE)')]));
    } else {
      hero.appendChild(el('p', { class: 'muted', style: 'margin:8px 0' }, ['Log Yielding sessions with load + RPE to build this chart.']));
    }
    const leftCap = combined.length
      ? `${combined.length} sessions · ${monthShort(combined[0].x)}–${monthShort(combined[combined.length - 1].x)}`
      : (isAll ? '' : 'W1 · cycle start');
    hero.appendChild(el('div', { class: 'chart-caps' }, [
      el('span', null, [leftCap]),
      nextTest ? el('span', { class: 'amber' }, [`next test W${nextTest.weekNumber} · ${dowShort(nextTestIso)}`]) : el('span', null, [''])
    ]));
    view.appendChild(hero);

    // ---- 3s E1RM trend (raw, unnormalised) ----
    view.appendChild(el('h2', null, ['3s E1RM · raw']));
    if (r3raw.length >= 2) {
      const c3 = el('div', { class: 'card', style: 'margin-top:0' });
      c3.appendChild(lineChart([
        { pts: r3raw, color: '#F04E4E', name: '3s raw', trendColor: '#F04E4E' }
      ], 'kg', { movingAvg: true, prMarkers: true }));
      c3.appendChild(el('p', { class: 'card-note', style: 'margin:4px 0 0' },
        ['unnormalised 3s top-set E1RM · thin = trend']));
      view.appendChild(c3);
    } else {
      view.appendChild(el('div', { class: 'card', style: 'margin-top:0' }, ['Log 3s Yielding sessions to build this chart.']));
    }

    // ---- stat strip ----
    const bw = await DB.getMeta('bodyweightKg');
    const best5 = s5all.length ? Math.max.apply(null, s5all.map(p => p.y)) : null;
    const r3c = s3raw.filter(inCyc);
    const d3pct = r3c.length >= 2 && r3c[0].y ? Math.round(((r3c[r3c.length - 1].y - r3c[0].y) / r3c[0].y) * 100) : null;
    const sessCyc = logs.filter(l => !cycStart || l.date >= cycStart).length;
    view.appendChild(el('div', { class: 'stat-strip' }, [
      el('div', { class: 'ss-col' }, [
        el('span', { class: 'ss-label' }, ['3s raw E1RM']),
        el('span', { class: 'ss-value', 'data-countup': '' },
          s3raw.length ? [String(s3raw[s3raw.length - 1].y), el('small', null, [' kg'])] : ['—']),
        d3pct != null
          ? el('span', { class: 'ss-sub' + (d3pct >= 0 ? ' pos' : '') }, [`${d3pct >= 0 ? '+' : ''}${d3pct}% cycle`])
          : el('span', { class: 'ss-sub' }, ['no cycle data'])
      ]),
      el('div', { class: 'ss-col' }, [
        el('span', { class: 'ss-label' }, ['Peak load']),
        (bw && best5 != null)
          ? el('span', { class: 'ss-value' }, [String(Math.round(((bw + best5) / bw) * 100)), el('small', null, ['% BW'])])
          : el('span', { class: 'ss-value' }, ['—']),
        el('span', { class: 'ss-sub' }, [(bw && best5 != null) ? `${Calc.roundTo(bw + best5, 1)} kg total` : (bw ? 'no 5s E1RM yet' : 'set bodyweight')])
      ]),
      el('div', { class: 'ss-col' }, [
        el('span', { class: 'ss-label' }, ['Sessions']),
        el('span', { class: 'ss-value', 'data-countup': '' }, [String(logs.length)]),
        el('span', { class: 'ss-sub' }, [`${sessCyc} this cycle`])
      ])
    ]));

    // ---- fatigue card: recovery matrix + weekly volume ----
    view.appendChild(el('h2', null, ['Fatigue · last 14 days']));
    const fat = el('div', { class: 'card', style: 'padding:14px;margin-top:0' });
    const ndfAll = logs.filter(l => l.nextDayFeel != null);
    const last14 = ndfAll.slice(-14);
    const prev14 = ndfAll.slice(-28, -14);
    const avgOf = a => (a.length ? a.reduce((s, l) => s + l.nextDayFeel, 0) / a.length : null);
    const a1 = avgOf(last14), a0 = avgOf(prev14);
    fat.appendChild(el('div', { class: 'row' }, [
      el('span', { class: 'card-title' }, ['Next-day feel']),
      a1 != null
        ? el('span', { class: 'tint-chip ' + (a1 >= 3.5 ? 'green' : 'amber') },
            [`${a1.toFixed(1)} avg` + (a0 != null ? ` · ${a1 - a0 >= 0 ? '+' : '−'}${Math.abs(a1 - a0).toFixed(1)}` : '')])
        : el('span', { class: 'tint-chip amber' }, ['no data'])
    ]));
    const recColor = { 5: '#33B94F', 4: '#9BDCA8', 3: '#F6C445', 2: '#F58F8F', 1: '#F04E4E' };
    const cells = el('div', { class: 'rec-cells' });
    const padN = 14 - last14.length;
    for (let i = 0; i < 14; i++) {
      const l = i < padN ? null : last14[i - padN];
      cells.appendChild(el('div', {
        class: 'rec-cell',
        style: l ? `background:${recColor[l.nextDayFeel] || '#F0F0F6'}` : null,
        role: 'img',
        'aria-label': l ? `${fmtDate(l.date)} — felt ${l.nextDayFeel} of 5` : 'no session'
      }));
    }
    fat.appendChild(cells);
    fat.appendChild(el('p', { class: 'card-note', style: 'margin:0' }, ['self-rated after each session · green = fresh · red = wrecked']));
    fat.appendChild(el('div', { class: 'card-divider' }));
    const byWeek = {};
    logs.forEach(l => {
      if (l.type !== 'Yielding' || l.topSetLoadKg == null || !l.sets) return;
      const wk = isoWeekKey(l.date);
      if (!wk) return;
      byWeek[wk] = (byWeek[wk] || 0) + l.topSetLoadKg * l.sets;
    });
    const wkKeys = Object.keys(byWeek).sort().slice(-8);
    const curKey = isoWeekKey(todayISO());
    fat.appendChild(el('div', { class: 'row' }, [
      el('span', { class: 'card-title' }, ['Weekly volume ', el('span', { class: 'soft' }, ['· sets × kg'])]),
      el('span', { style: 'font-size:12px;font-weight:800;font-variant-numeric:tabular-nums' },
        [Math.round(byWeek[curKey] || 0).toLocaleString() + ' kg'])
    ]));
    if (wkKeys.length) {
      const maxVol = Math.max.apply(null, wkKeys.map(k => byWeek[k]).concat([1]));
      const vbars = el('div', { class: 'vol-bars' });
      wkKeys.forEach(k => {
        vbars.appendChild(el('div', {
          class: 'vol-bar' + (k === curKey ? ' cur' : ''),
          style: `height:${Math.max(4, Math.round((byWeek[k] / maxVol) * 84))}px`,
          role: 'img', 'aria-label': `week ${k} — ${Math.round(byWeek[k])} kg`
        }));
      });
      fat.appendChild(vbars);
      fat.appendChild(el('div', { class: 'axis-caps' }, [el('span', null, [`−${wkKeys.length - 1}w`]), el('span', null, ['now'])]));
    } else {
      fat.appendChild(el('p', { class: 'muted', style: 'margin:10px 0 0' }, ['No volume data yet.']));
    }
    view.appendChild(fat);

    // ---- 3s E1RM projection cone -----------------------------------------
    // Display-only layer (cone.js + cone_data.js). Martin trains 3s now, so the
    // cone is built AND read natively in 3s E1RM units — the OLS fit, the slope
    // clamp, and the uncertainty bands all live in real 3s kg (no ×1.1 display
    // hack on a 5s-eq fit, which used to let the drawn slope exceed the clamp).
    // To reach back far enough to fit a trend, historical 5s sessions are
    // converted UP to 3s-equivalent by a factor estimated from Martin's OWN
    // 5s→3s data (trend-continuity ≈ 1.08; matches the ~10% short-hang premium).
    // Nothing here feeds anchors, Working Maxes, or any training math.
    view.appendChild(el('h2', null, ['E1RM projection · 3s']));
    const durFactor = (typeof estimateDurationFactor === 'function')
      ? estimateDurationFactor(s5all, s3raw, { default: 1.10 })
      : { factor: 1.10, source: 'default', n: 0 };
    // Native 3s history: 3s sessions as raw 3s E1RM (s3raw); 5s sessions ×factor.
    const hist3 = (typeof coneHistory === 'function')
      ? coneHistory(s5all.map(p => ({ x: p.x, y: Calc.roundTo(p.y * durFactor.factor, 1) })).concat(s3raw))
      : [];
    if (typeof drawStochasticCone !== 'function' || typeof buildConeProjection !== 'function') {
      view.appendChild(el('div', { class: 'card' }, ['Projection layer not loaded.']));
    } else if (hist3.length < 3) {
      view.appendChild(el('div', { class: 'card' }, ['Log at least three Yielding sessions with load + RPE to project a trend.']));
    } else {
      const tests = weeks
        .filter(w => w.isDeloadTest && w.startDate)
        .map(w => ({ date: testDayIso(cycle, w), label: 'Test W' + w.weekNumber }));
      const proj = buildConeProjection(hist3, { horizonWeeks: 6, tests });
      if (!proj) {
        view.appendChild(el('div', { class: 'card' }, ['Not enough spread in recent sessions to project.']));
      } else {
        const coneCard = el('div', { class: 'card' });
        drawStochasticCone(hist3, proj, coneCard, { unit: 'kg', todayX: todayISO() });
        const t = proj.targets[0];
        if (t) {
          const wm = wmFor(3);   // compare 3s projection against the 3s Working Max
          let verdict;
          if (wm == null) {
            verdict = 'Projected ~' + t.y + ' kg at ' + t.label + ' (90%: ' + t.lo + '–' + t.hi + ').';
          } else {
            const gain = Math.round((t.y - wm) * 2) / 2;
            const range = ' (' + t.lo + '–' + t.hi + ')';
            if (t.lo > wm) {
              verdict = 'Projected ~' + t.y + ' kg at ' + t.label + range + ' — trend supports a +' + gain + ' kg WM bump.';
            } else if (t.y > wm) {
              verdict = 'Projected ~' + t.y + ' kg at ' + t.label + range + ' — on track, but the range still straddles your ' + wm + ' kg WM.';
            } else {
              verdict = 'Projected ~' + t.y + ' kg at ' + t.label + range + ' — trend doesn\'t support a WM bump yet. Come in fresh.';
            }
          }
          coneCard.appendChild(el('p', { class: 'card-title', style: 'margin:10px 0 0;font-size:13px' }, [verdict]));
        }
        const convNote = durFactor.source === 'calibrated'
          ? '5s history converted to 3s-equivalent ×' + durFactor.factor + ' (from your 5s→3s data)'
          : '5s history converted to 3s-equivalent ×' + durFactor.factor + ' (default — log more 3s to calibrate)';
        coneCard.appendChild(el('p', { class: 'card-note' }, [
          'Projected 3s E1RM · ' + convNote + ' · green = adaptation range · red = fatigue range · rings = 90% benchmark intervals. Display only — does not affect anchors or WMs.'
        ]));
        view.appendChild(coneCard);
      }
    }

    // ---- Filtered strength (Kalman) — sibling of the cone, display-only ----
    // Local-linear-trend Kalman filter over the SAME 3s-native history the
    // cone uses (kalman_data.js + kalman.js). Separates the strength signal
    // from session noise and projects an asymmetric fan: upper = current rate
    // persists, median = gains slow gradually, lower = gains stall — sustained
    // strength loss while training continues is treated as unlikely, because
    // single-session dips are expression noise, not lost strength. Nothing
    // here feeds anchors, Working Maxes, or any training math.
    view.appendChild(el('h2', null, ['Filtered strength · 3s']));
    if (typeof drawKalmanTrack !== 'function' || typeof buildKalmanTrack !== 'function') {
      view.appendChild(el('div', { class: 'card' }, ['Filtered-strength layer not loaded.']));
    } else if (hist3.length < 3) {
      view.appendChild(el('div', { class: 'card' }, ['Log at least three Yielding sessions to filter a trend.']));
    } else {
      const ktests = weeks
        .filter(w => w.isDeloadTest && w.startDate)
        .map(w => ({ date: testDayIso(cycle, w), label: 'Test W' + w.weekNumber }));
      // Same series as hist3 but carrying each session's top-set RPE, so the
      // filter can trust near-limit sessions (@9.5) a little more than the
      // longer extrapolations (@8). rpeK = personal curve when calibrated.
      // Weights are mean-normalized inside — overall noise level unchanged.
      const khist = s5all.map(p => ({ x: p.x, y: Calc.roundTo(p.y * durFactor.factor, 1), rpe: p.rpe })).concat(s3raw);
      const kmodel = buildKalmanTrack(khist, { horizonWeeks: 6, tests: ktests, rpeK: rpeCal.k });
      if (!kmodel) {
        view.appendChild(el('div', { class: 'card' }, ['Not enough signal to filter yet.']));
      } else {
        const kCard = el('div', { class: 'card' });
        drawKalmanTrack(hist3, kmodel, kCard, { unit: 'kg', todayX: todayISO() });
        const kr = kmodel.readiness;
        const kTrend = (kmodel.slopePerWeek >= 0 ? '+' : '−') + Math.abs(kmodel.slopePerWeek);
        const kDelta = (kr.deltaKg >= 0 ? '+' : '−') + Math.abs(kr.deltaKg);
        kCard.appendChild(el('p', { class: 'card-title', style: 'margin:10px 0 0;font-size:13px' }, [
          'Filtered ' + kr.filtered + ' kg · trend ' + kTrend + ' kg/wk. Last session ' +
          kDelta + ' kg (' + kr.sigma + 'σ) — ' + kr.band + '.'
        ]));
        kCard.appendChild(el('p', { class: 'card-note' }, [
          'Kalman-filtered strength: solid line = signal through session noise · dots = logged sessions · ribbon = ±1σ · fan = 50/90% range. ' +
          'The fan is asymmetric by design — upper edge: current rate persists · dashed: gains slow gradually · lower edge: gains stall rather than reverse (sustained loss while training is unlikely; bad days are noise). ' +
          (kmodel.rpeWeighted
            ? 'Sessions are weighted by top-set RPE: near-limit efforts count as sharper reads than longer extrapolations. '
            : '') +
          'Assumes training continues. Display only — does not affect anchors or WMs.'
        ]));
        view.appendChild(kCard);
      }
    }

    // benchmark history table (benches already fetched ascending above)
    view.appendChild(el('h2', null, ['Benchmark history']));
    const benchesDesc = benches.slice().reverse();
    if (!benchesDesc.length) {
      view.appendChild(el('div', { class: 'card' }, ['No benchmark tests logged yet. Test weeks update your Working Max here.']));
    } else {
      const t = el('table', { class: 'prev' });
      t.appendChild(el('tr', { html: '<th>Date</th><th>Dur</th><th>Max kg</th><th>RPE</th><th>Δ</th>' }));
      // deltas vs the previous test of the same duration (ascending pass)
      const deltas = {}; const lastByDur = {};
      benches.forEach(b => {
        deltas[b.id] = lastByDur[b.durationSeconds] != null ? b.maxLoadKg - lastByDur[b.durationSeconds] : null;
        lastByDur[b.durationSeconds] = b.maxLoadKg;
      });
      benchesDesc.forEach(b => {
        t.appendChild(el('tr', { html:
          `<td>${fmtDate(b.date)}</td><td>${b.durationSeconds}s</td><td>${b.maxLoadKg}</td><td>@${b.rpe}</td><td>${deltas[b.id] == null ? '—' : (deltas[b.id] >= 0 ? '+' : '') + deltas[b.id]}</td>` }));
      });
      view.appendChild(el('div', { class: 'card' }, [t]));
    }
  }

  // =====================================================================
  // ANALYTICS · PICKUP
  // =====================================================================
  async function renderPickupAnalytics(view, logs) {
    view.appendChild(el('div', { class: 'row', style: 'margin:0 0 10px' }, [
      el('span', { class: 'micro' }, ['Block pull · one hand at a time']),
      el('div', { class: 'seg' }, [
        el('button', { class: App.state.analyticsRange === 'all' ? 'sel' : '', onclick: () => { App.state.analyticsRange = 'all'; App.render(); } }, ['All']),
        el('button', { class: App.state.analyticsRange === 'cycle' ? 'sel' : '', onclick: () => { App.state.analyticsRange = 'cycle'; App.render(); } }, ['Cycle'])
      ])
    ]));

    const cycle = await DB.activeCycle();
    const cycStart = cycle ? cycle.startDate : null;
    const isAll = App.state.analyticsRange === 'all';
    const pickups = logs.filter(l => Calc.isPickup(l) &&
      (isAll || !cycStart || l.date >= cycStart));

    if (pickups.length < 1) {
      view.appendChild(el('div', { class: 'card' }, ['No block-pull sessions logged yet.']));
      return;
    }

    // ---- RPE curve. Spacing between RPE points is a property of the PERSON,
    // not of the exercise, so pickup analytics can borrow the hang-calibrated
    // curve until it has enough of its own sessions to validate one. Stated in
    // the card note either way — a borrowed constant should never look native.
    const pickPts = [];
    pickups.forEach(l => Calc.HANDS.forEach(h => {
      const load = Calc.topLoad(l, h), rpe = Calc.topRPE(l, h);
      if (load != null && rpe != null) pickPts.push({ date: l.date, load, rpe, dur: 5 });
    }));
    const hangPts = logs.filter(l => !Calc.isPickup(l) && l.topSetLoadKg != null && l.topSetRPE != null)
      .map(l => ({ date: l.date, load: l.topSetLoadKg, rpe: l.topSetRPE, dur: l.hangDurationSeconds }));
    let rpeCal = (typeof fitRpeCurve === 'function') ? fitRpeCurve(pickPts) : { k: 0.06, source: 'default', n: 0 };
    let calSource = rpeCal.source === 'calibrated' ? 'pickup' : null;
    if (!calSource && typeof fitRpeCurve === 'function') {
      const fromHangs = fitRpeCurve(hangPts);
      if (fromHangs.source === 'calibrated') { rpeCal = fromHangs; calSource = 'hang'; }
    }
    const calOn = !!calSource;
    // dur 5 => the ÷1.1 cross-duration path is skipped. Pickups run one hold
    // length, so there is nothing to normalise between.
    const e1Of = (load, rpe, stored) => {
      if (calOn && load != null && rpe != null) {
        const v = rpeCal.e1rm(load, rpe, 5);
        if (v != null) return v;
      }
      if (stored != null) return stored;
      return Calc.e1rm(load, rpe, null, 'pickup');
    };

    const series = {};
    Calc.HANDS.forEach(h => {
      series[h] = pickups.map(l => {
        const load = Calc.topLoad(l, h);
        if (load == null) return null;
        const rpe = Calc.topRPE(l, h);
        const y = e1Of(load, rpe, Calc.e1rmOf(l, h));
        return y == null ? null : { x: l.date, y, rpe, degraded: Calc.topSetDegraded(l, h) };
      }).filter(Boolean);
    });

    // ---- hero: both hands, one axis ------------------------------------
    const hero = el('div', { class: 'card', style: 'padding:16px 14px 12px;margin-top:0' });
    const lastOf = h => series[h].length ? series[h][series[h].length - 1].y : null;
    const deltaOf = h => series[h].length >= 2
      ? Calc.roundTo(series[h][series[h].length - 1].y - series[h][0].y, 1) : null;
    hero.appendChild(el('div', { class: 'row' }, [
      el('span', { class: 'micro' }, ['Top-set E1RM · per hand']),
      el('span', { class: 'micro' }, [isAll ? 'all-time' : 'this cycle'])
    ]));
    const readout = el('div', { class: 'row', style: 'align-items:flex-end;margin:2px 0 6px' });
    Calc.HANDS.forEach(h => {
      const d = deltaOf(h), v = lastOf(h);
      readout.appendChild(el('div', null, [
        el('span', { class: 'micro', style: `color:${HAND_COLOR[h]}` }, [HAND_NAME[h]]),
        el('div', { class: 'hero-readout', style: 'margin:0' }, [
          el('span', { class: 'hero-num', 'data-countup': '' }, [v != null ? String(v) : '—']),
          el('span', { class: 'hero-unit' }, ['kg'])
        ]),
        d != null ? el('span', { class: 'tint-chip ' + (d >= 0 ? 'green' : 'amber') },
          [`${d >= 0 ? '+' : '−'}${Math.abs(d)} kg`]) : el('span', { class: 'micro' }, [''])
      ]));
    });
    hero.appendChild(readout);
    if (series.L.length + series.R.length >= 4) {
      hero.appendChild(lineChart([
        { pts: series.L, color: HAND_COLOR.L, name: 'Left', trendColor: HAND_COLOR.L },
        { pts: series.R, color: HAND_COLOR.R, name: 'Right', trendColor: HAND_COLOR.R }
      ], 'kg', { movingAvg: true, prMarkers: false }));
      hero.appendChild(el('p', { class: 'card-note', style: 'margin:4px 0 0' }, [
        `orange = left · blue = right · thin = trend · ` +
        (calSource === 'pickup'
          ? `RPE curve: personal, ${(rpeCal.k * 100).toFixed(1)}%/pt from pickup sessions`
          : calSource === 'hang'
            ? `RPE curve: personal, ${(rpeCal.k * 100).toFixed(1)}%/pt — borrowed from your hang sessions until pickups calibrate their own (RPE spacing is a property of you, not the exercise)`
            : 'RPE curve: generic 6%/pt')
      ]));
    } else {
      hero.appendChild(el('p', { class: 'muted', style: 'margin:8px 0' }, ['Two sessions per hand and this chart starts.']));
    }
    view.appendChild(hero);

    // ---- stat strip -----------------------------------------------------
    const bestOf = h => series[h].length ? Math.max.apply(null, series[h].map(p => p.y)) : null;
    const lastGap = (() => {
      const a = lastOf('L'), b = lastOf('R');
      if (a == null || b == null) return null;
      const hi = Math.max(a, b);
      return hi ? { pct: Math.round(((hi - Math.min(a, b)) / hi) * 1000) / 10, lead: a > b ? 'L' : (b > a ? 'R' : null) } : null;
    })();
    view.appendChild(el('div', { class: 'stat-strip' }, [
      el('div', { class: 'ss-col' }, [
        el('span', { class: 'ss-label' }, ['Best · left']),
        el('span', { class: 'ss-value', 'data-countup': '' }, bestOf('L') != null ? [String(bestOf('L')), el('small', null, [' kg'])] : ['—']),
        el('span', { class: 'ss-sub' }, [`${series.L.length} sessions`])
      ]),
      el('div', { class: 'ss-col' }, [
        el('span', { class: 'ss-label' }, ['Best · right']),
        el('span', { class: 'ss-value', 'data-countup': '' }, bestOf('R') != null ? [String(bestOf('R')), el('small', null, [' kg'])] : ['—']),
        el('span', { class: 'ss-sub' }, [`${series.R.length} sessions`])
      ]),
      el('div', { class: 'ss-col' }, [
        el('span', { class: 'ss-label' }, ['Latest gap']),
        el('span', { class: 'ss-value' }, lastGap ? [String(lastGap.pct), el('small', null, ['%'])] : ['—']),
        el('span', { class: 'ss-sub' }, [lastGap && lastGap.lead ? HAND_NAME[lastGap.lead] + ' stronger' : 'even'])
      ])
    ]));

    // ---- asymmetry ------------------------------------------------------
    view.appendChild(el('h2', null, ['Asymmetry']));
    const paired = (typeof buildPairedKalmanTrack === 'function')
      ? buildPairedKalmanTrack(
          series.L.map(p => ({ x: p.x, y: p.y, rpe: p.rpe, degraded: p.degraded })),
          series.R.map(p => ({ x: p.x, y: p.y, rpe: p.rpe, degraded: p.degraded })),
          { horizonWeeks: 6, rpeK: rpeCal.k })
      : null;
    const asymCard = el('div', { class: 'card', style: 'margin-top:0' });
    if (!paired) {
      asymCard.appendChild(el('p', { class: 'muted', style: 'margin:0' }, [
        'Three sessions with both hands and this starts. Until then the per-hand numbers above are the whole picture.'
      ]));
    } else {
      const rawGap = [];
      pickups.forEach(l => {
        const a = Calc.topLoad(l, 'L'), b = Calc.topLoad(l, 'R');
        if (a != null && b != null) rawGap.push({ x: l.date, y: Calc.roundTo(b - a, 1) });
      });
      asymCard.appendChild(lineChart([
        { pts: rawGap, color: '#C9C9D6', name: 'per session' },
        { pts: paired.asym.map(p => ({ x: p.x, y: p.y })), color: '#7A5AF8', name: 'filtered', trendColor: '#7A5AF8' }
      ], 'kg', { movingAvg: false, prMarkers: false }));
      const a = paired.asymNow;
      // Factual, no corrective framing: an asymmetry is a measurement, not a
      // fault, and the honest headline when it is inside one sigma is that the
      // hands are indistinguishable — not that one is "behind".
      asymCard.appendChild(el('p', { class: 'card-title', style: 'margin:10px 0 0;font-size:13px' }, [
        a.resolved
          ? `${HAND_NAME[a.lead] || '—'} is ahead by ${Math.abs(a.kg)} kg (${a.pct}%), ${a.sigma}σ — larger than the measurement noise.`
          : `Gap ${Math.abs(a.kg)} kg (${a.pct}%) at ${a.sigma}σ — inside the noise. On this much data the two hands are not distinguishable.`
      ]));
      asymCard.appendChild(el('p', { class: 'card-note' }, [
        'grey = raw per-session difference (right − left) · purple = filtered. The filter treats both hands as reads of one strength state plus a slowly drifting gap, ' +
        'which estimates that gap ~20% more accurately than subtracting two separately smoothed lines (measured on synthetic athletes, qa/kalman_paired_farm.js). Display only.'
      ]));
    }
    view.appendChild(asymCard);

    // ---- day-of-week: the question the uniform block exists to answer ----
    view.appendChild(el('h2', null, ['Day of week']));
    view.appendChild(dayOfWeekCard(pickups, e1Of));

    // ---- filtered strength, per hand ------------------------------------
    view.appendChild(el('h2', null, ['Filtered strength · per hand']));
    if (typeof buildKalmanTrack !== 'function' || typeof drawKalmanTrack !== 'function') {
      view.appendChild(el('div', { class: 'card' }, ['Filtered-strength layer not loaded.']));
    } else {
      Calc.HANDS.forEach(h => {
        const pts = series[h].map(p => ({ x: p.x, y: p.y, rpe: p.rpe, degraded: p.degraded }));
        if (pts.length < 3) {
          view.appendChild(el('div', { class: 'card' }, [`${HAND_NAME[h]}: three sessions needed to filter a trend.`]));
          return;
        }
        const model = buildKalmanTrack(pts, { horizonWeeks: 6, rpeK: rpeCal.k });
        if (!model) { view.appendChild(el('div', { class: 'card' }, [`${HAND_NAME[h]}: not enough signal yet.`])); return; }
        const card = el('div', { class: 'card' });
        card.appendChild(el('div', { class: 'row' }, [
          el('span', { class: 'card-title', style: `color:${HAND_COLOR[h]}` }, [HAND_NAME[h] + ' hand']),
          el('span', { class: 'micro' }, [`${model.n} sessions`])
        ]));
        drawKalmanTrack(pts, model, card, { unit: 'kg', todayX: todayISO() });
        const kr = model.readiness;
        card.appendChild(el('p', { class: 'card-title', style: 'margin:10px 0 0;font-size:13px' }, [
          `Filtered ${kr.filtered} kg · trend ${(model.slopePerWeek >= 0 ? '+' : '−') + Math.abs(model.slopePerWeek)} kg/wk. ` +
          `Last session ${(kr.deltaKg >= 0 ? '+' : '−') + Math.abs(kr.deltaKg)} kg (${kr.sigma}σ) — ${kr.band}.`
        ]));
        view.appendChild(card);
      });
      view.appendChild(el('p', { class: 'card-note', style: 'margin:2px 2px 0' }, [
        'Each hand is filtered independently. The paired model above is better at the GAP but measurably worse at the level — ' +
        'observing one hand tells you about that hand, not about a shared latent, and forcing the split leaks noise into both. Display only.'
      ]));
    }

    // ---- position integrity ---------------------------------------------
    view.appendChild(el('h2', null, ['Position']));
    view.appendChild(positionCard(pickups));

    // ---- context: readiness + climbing load ------------------------------
    view.appendChild(el('h2', null, ['Context']));
    view.appendChild(contextCard(pickups));

    if (pickups.length < 6) {
      view.appendChild(el('div', { class: 'banner warn', style: 'margin-top:12px' }, [
        el('p', { style: 'margin:0' }, [
          `${pickups.length} session${pickups.length === 1 ? '' : 's'} in. The trend line is mostly your RIR calibration for the first couple of months, not strength change — ` +
          'expect it to be noisy before it is informative.'
        ])
      ]));
    }
  }

  // Mean top-set E1RM by weekday. This is the payoff of running every session
  // identically: with the days held constant, a systematic Friday deficit
  // against Monday IS the answer to "is 3x/week too much for me". Reported
  // with n and a standard error because on six weeks of data it will usually
  // be too noisy to conclude anything, and saying so is the honest output.
  function dayOfWeekCard(pickups, e1Of) {
    const card = el('div', { class: 'card', style: 'margin-top:0' });
    const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const buckets = {};
    pickups.forEach(l => {
      const d = new Date(l.date + 'T00:00:00');
      if (!isFinite(d.getTime())) return;
      const vals = [];
      Calc.HANDS.forEach(h => {
        const load = Calc.topLoad(l, h);
        if (load == null) return;
        const v = e1Of(load, Calc.topRPE(l, h), Calc.e1rmOf(l, h));
        if (v != null) vals.push(v);
      });
      if (!vals.length) return;
      const k = d.getDay();
      (buckets[k] = buckets[k] || []).push(vals.reduce((s, v) => s + v, 0) / vals.length);
    });
    const keys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    if (!keys.length) {
      card.appendChild(el('p', { class: 'muted', style: 'margin:0' }, ['No sessions yet.']));
      return card;
    }
    const stats = keys.map(k => {
      const a = buckets[k];
      const mean = a.reduce((s, v) => s + v, 0) / a.length;
      const varr = a.length > 1 ? a.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (a.length - 1) : 0;
      return { k, n: a.length, mean, se: a.length > 1 ? Math.sqrt(varr / a.length) : null };
    });
    const lo = Math.min.apply(null, stats.map(s => s.mean));
    const hi = Math.max.apply(null, stats.map(s => s.mean));
    const span = Math.max(0.5, hi - lo);
    const bars = el('div', { class: 'vol-bars', style: 'align-items:flex-end' });
    stats.forEach(s => {
      bars.appendChild(el('div', {
        class: 'vol-bar',
        style: `height:${Math.max(6, Math.round(((s.mean - lo) / span) * 70) + 14)}px`,
        role: 'img', 'aria-label': `${DAY_LABEL[s.k]} mean ${s.mean.toFixed(1)} kg from ${s.n} sessions`
      }));
    });
    card.appendChild(bars);
    card.appendChild(el('div', { class: 'axis-caps' }, stats.map(s => el('span', null, [DAY_LABEL[s.k]]))));
    const rows = el('table', { class: 'prev' });
    rows.appendChild(el('tr', { html: '<th>Day</th><th>Mean E1RM</th><th>n</th><th>± SE</th>' }));
    stats.forEach(s => rows.appendChild(el('tr', {
      html: `<td>${DAY_LABEL[s.k]}</td><td>${s.mean.toFixed(1)} kg</td><td>${s.n}</td><td>${s.se != null ? '±' + s.se.toFixed(2) : '—'}</td>`
    })));
    card.appendChild(rows);

    const first = stats[0], last = stats[stats.length - 1];
    let verdict;
    if (stats.length < 2 || first.n < 3 || last.n < 3) {
      verdict = 'Three sessions on each training day before this says anything.';
    } else {
      const diff = last.mean - first.mean;
      const se = Math.sqrt((first.se || 0) * (first.se || 0) + (last.se || 0) * (last.se || 0));
      const z = se > 0 ? Math.abs(diff) / se : 0;
      verdict = z < 1.5
        ? `${DAY_LABEL[last.k]} runs ${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(1)} kg against ${DAY_LABEL[first.k]}, which is inside the noise (${z.toFixed(1)}σ). No frequency verdict yet.`
        : `${DAY_LABEL[last.k]} runs ${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(1)} kg against ${DAY_LABEL[first.k]} (${z.toFixed(1)}σ). ` +
          (diff < 0 ? 'A consistent late-week deficit is what accumulated fatigue looks like — the lever is weekly set count, not session count.'
                    : 'Late-week sessions are running higher, which is not a fatigue signature.');
    }
    card.appendChild(el('p', { class: 'card-title', style: 'margin:10px 0 0;font-size:13px' }, [verdict]));
    card.appendChild(el('p', { class: 'card-note' }, [
      'Mean of both hands per session, grouped by weekday. Only readable because every session in this block is prescribed identically — ' +
      'varying the days by design would confound this with the prescription.'
    ]));
    return card;
  }

  // Where does the position start breaking? The degraded rate against load is
  // the real working ceiling, and it is usually below the load you can "hold".
  function positionCard(pickups) {
    const card = el('div', { class: 'card', style: 'margin-top:0' });
    let total = 0, degraded = 0, failed = 0;
    const byLoad = [];
    pickups.forEach(l => Calc.HANDS.forEach(h => {
      const sets = Calc.setsDetailOf(l, h);
      if (!sets) return;
      sets.forEach(s => {
        if (!s) return;
        const reps = s.reps || (s.outcomes ? s.outcomes.length : 1) || 1;
        total += reps;
        if (s.outcome === 'degraded') degraded += reps;
        if (s.outcome === 'failed') failed += reps;
        if (s.load != null) byLoad.push({ load: s.load, bad: s.outcome && s.outcome !== 'clean' ? 1 : 0, hand: h });
      });
    }));
    if (!total) {
      card.appendChild(el('p', { class: 'muted', style: 'margin:0' }, ['No per-set position data yet.']));
      return card;
    }
    const badPct = Math.round(((degraded + failed) / total) * 1000) / 10;
    card.appendChild(el('div', { class: 'row' }, [
      el('span', { class: 'card-title' }, ['Reps not clean']),
      el('span', { class: 'tint-chip ' + (badPct <= 10 ? 'green' : 'amber') }, [badPct + '%'])
    ]));
    card.appendChild(el('p', { class: 'muted', style: 'margin:4px 0 0' }, [
      `${degraded} degraded · ${failed} failed · ${total} reps logged`
    ]));
    // Ceiling estimate: the lightest load band where things start breaking.
    const clean = byLoad.filter(p => !p.bad).map(p => p.load);
    const broken = byLoad.filter(p => p.bad).map(p => p.load);
    if (broken.length >= 3 && clean.length >= 3) {
      const meanBroken = broken.reduce((s, v) => s + v, 0) / broken.length;
      const maxClean = Math.max.apply(null, clean);
      card.appendChild(el('p', { class: 'card-title', style: 'margin:10px 0 0;font-size:13px' }, [
        `Position breaks around ${Calc.roundTo(meanBroken, 1)} kg on average; your heaviest fully clean set is ${maxClean} kg. ` +
        'The lower of those is closer to your real working ceiling than the higher one.'
      ]));
    }
    card.appendChild(el('p', { class: 'card-note' }, [
      'A degraded top set is logged and charted, but it does not advance the load and the filter trusts it less (4× the variance) — ' +
      'the load was real, it just was not expressed in position.'
    ]));
    return card;
  }

  // Readiness and climbing load, recorded before each top set. These are the
  // fields that make a dip interpretable after the fact.
  function contextCard(pickups) {
    const card = el('div', { class: 'card', style: 'margin-top:0' });
    const withR = pickups.filter(l => l.readiness != null);
    const byClimb = { none: [], easy: [], hard: [] };
    pickups.forEach(l => {
      if (!l.climbing48h || !byClimb[l.climbing48h]) return;
      const vals = Calc.HANDS.map(h => Calc.topLoad(l, h)).filter(v => v != null);
      if (vals.length) byClimb[l.climbing48h].push(vals.reduce((s, v) => s + v, 0) / vals.length);
    });
    if (!withR.length && !Object.keys(byClimb).some(k => byClimb[k].length)) {
      card.appendChild(el('p', { class: 'muted', style: 'margin:0' }, [
        'No pre-session readiness or climbing load recorded yet. Without them a dip in the trend cannot be separated from a hard week on the wall.'
      ]));
      return card;
    }
    if (withR.length) {
      const avg = withR.reduce((s, l) => s + l.readiness, 0) / withR.length;
      card.appendChild(el('div', { class: 'row' }, [
        el('span', { class: 'card-title' }, ['Readiness before session']),
        el('span', { class: 'tint-chip ' + (avg >= 3.5 ? 'green' : 'amber') }, [avg.toFixed(1) + ' avg'])
      ]));
    }
    const rows = [];
    ['none', 'easy', 'hard'].forEach(k => {
      const a = byClimb[k];
      if (!a.length) return;
      const m = a.reduce((s, v) => s + v, 0) / a.length;
      rows.push(`<tr><td>${k}</td><td>${Calc.roundTo(m, 1)} kg</td><td>${a.length}</td></tr>`);
    });
    if (rows.length) {
      const t = el('table', { class: 'prev' });
      t.appendChild(el('tr', { html: '<th>Climbing 48h</th><th>Mean top set</th><th>n</th>' }));
      t.innerHTML += rows.join('');
      card.appendChild(t);
    }
    card.appendChild(el('p', { class: 'card-note' }, [
      'Recorded before the top set, so it is not coloured by knowing how the session went.'
    ]));
    return card;
  }

  function isoWeekKey(iso) {
    const d = new Date(iso + 'T00:00:00');
    if (!isFinite(d.getTime())) return null;   // corrupt date: skip, don't throw
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
    // Group and aggregate points by date to avoid duplicate entries on the same date.
    // Keep the whole point object (max y wins) so per-point flags like `dashedPrev`
    // and `is3s` survive de-duplication — the dashed state machine and hollow markers
    // below depend on them.
    const cleanSeries = series.map(s => {
      const grouped = {};
      s.pts.forEach(p => {
        if (grouped[p.x] === undefined || p.y > grouped[p.x].y) {
          grouped[p.x] = p;
        }
      });
      const cleanPts = Object.keys(grouped).sort().map(x => grouped[x]);
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
      svg.appendChild(svgNS('line', { x1: padL, y1: yFor(yv), x2: W - padR, y2: yFor(yv), stroke: '#EFEFF3', 'stroke-width': 1.5 }));
      const tx = svgNS('text', { x: padL - 6, y: yFor(yv) + 4, fill: '#A5A5BE', 'font-size': 11, 'text-anchor': 'end' }); tx.textContent = yv; svg.appendChild(tx);
    });
    // axis title
    const axt = svgNS('text', { x: 12, y: padT + 4, fill: '#A5A5BE', 'font-size': 10 }); axt.textContent = unit; svg.appendChild(axt);
    // x labels (thinned to ~6)
    const step = Math.max(1, Math.ceil(dates.length / 6));
    dates.forEach((dt, i) => {
      if (i % step !== 0 && i !== dates.length - 1) return;
      const tx = svgNS('text', { x: xFor(dt), y: H - padB + 16, fill: '#A5A5BE', 'font-size': 10, 'text-anchor': 'middle' });
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
        const tColor = s.trendColor || '#A5A5BE';
        svg.appendChild(svgNS('path', { d, fill: 'none', stroke: tColor, 'stroke-width': 1.2, opacity: 0.4 }));
      }
      
      if (s.hideLine) {
        // do not draw line
      } else if (s.dashed) {
        let d = '';
        s.pts.forEach((p, i) => { d += (i ? ' L' : 'M') + xFor(p.x) + ' ' + yFor(p.y); });
        svg.appendChild(svgNS('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-dasharray': '5, 5', 'stroke-linejoin': 'round' }));
      } else {
        // Support per-segment dashes by breaking into multiple paths
        let currentPath = [];
        let isDashed = false;
        if (s.pts.length > 0) isDashed = !!s.pts[0].dashedPrev;
        
        const flushPath = () => {
          if (currentPath.length < 2) return;
          let d = '';
          currentPath.forEach((pt, i) => { d += (i ? ' L' : 'M') + xFor(pt.x) + ' ' + yFor(pt.y); });
          const attrs = { d, fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' };
          if (isDashed) {
            attrs['stroke-dasharray'] = '5, 5';
          }
          svg.appendChild(svgNS('path', attrs));
        };

        s.pts.forEach((p, i) => {
          if (i === 0) {
            currentPath.push(p);
          } else {
            const ptDashed = !!p.dashedPrev;
            if (ptDashed !== isDashed) {
              const prevPoint = s.pts[i - 1];
              flushPath();
              currentPath = [prevPoint];
              isDashed = ptDashed;
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

          if (p.is3s === false) return; // skip point rendering if explicitly marked false

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
            fill: p.is3s ? '#FFFFFF' : s.color, // surface fill makes the 3s marker hollow
            stroke: s.color,
            'stroke-width': p.is3s ? 1.5 : 1
          };
          const c = svgNS('circle', cAttrs);
          svg.appendChild(c);
        });
      }
    });

    // ---- full-surface scrubber -----------------------------------------
    // Touch or drag anywhere on the plot: a crosshair snaps to the nearest
    // session and the tooltip reads out kg + date (+ PR). Replaces the old
    // tiny per-point hit targets, which were fussy on a phone.
    if (opts.scrub !== false && typeof svg.addEventListener === 'function' && dates.length) {
      const prSets = series.map(s => {
        const set = new Set();
        if (opts.prMarkers) {
          let best = -Infinity;
          s.pts.forEach(p => { if (p.y > best) { best = p.y; set.add(p.x); } });
        }
        return set;
      });
      const xline = svgNS('line', {
        x1: 0, x2: 0, y1: padT, y2: H - padB,
        stroke: '#2E2E42', 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0
      });
      svg.appendChild(xline);
      const dots = series.map(s => {
        const c = svgNS('circle', { r: 6, cx: 0, cy: 0, fill: '#FFFFFF', stroke: s.color, 'stroke-width': 3, opacity: 0 });
        svg.appendChild(c);
        return c;
      });
      const showAt = (clientX) => {
        const rect = svg.getBoundingClientRect();
        if (!rect || !rect.width) return;
        const px = (clientX - rect.left) * (W / rect.width);
        let bestDt = null, bd = Infinity;
        dates.forEach(dt => {
          const d = Math.abs(xFor(dt) - px);
          if (d < bd) { bd = d; bestDt = dt; }
        });
        if (bestDt == null) return;
        const bx = xFor(bestDt);
        xline.setAttribute('x1', bx); xline.setAttribute('x2', bx);
        xline.setAttribute('opacity', 0.25);
        const rows = [];
        let topY = null;
        series.forEach((s, i) => {
          const p = s.pts.find(q => q.x === bestDt);
          if (!p) { dots[i].setAttribute('opacity', 0); return; }
          const py = yFor(p.y);
          dots[i].setAttribute('cx', bx); dots[i].setAttribute('cy', py);
          dots[i].setAttribute('opacity', 1);
          if (topY == null || py < topY) topY = py;
          const tag = p.is3s ? '3s hang (5s-eq)' : (s.name || '');
          rows.push(`<b>${p.y} ${unit}</b>${tag ? ' · ' + tag : ''}${prSets[i].has(p.x) ? ' · PR' : ''}`);
        });
        if (!rows.length) return;
        const t = tooltipEl();
        t.innerHTML = rows.join('<br>') + '<br>' + fmtShort(bestDt);
        const sxScreen = rect.left + (bx / W) * rect.width;
        const syScreen = rect.top + (((topY == null ? padT : topY)) / H) * rect.height;
        const vw = window.innerWidth || rect.width;
        t.style.left = Math.max(70, Math.min(vw - 70, sxScreen)) + 'px';
        t.style.top = (syScreen - 14) + 'px';
        t.style.opacity = '1';
      };
      const hideScrub = () => {
        xline.setAttribute('opacity', 0);
        dots.forEach(d => d.setAttribute('opacity', 0));
        tooltipEl().style.opacity = '0';
      };
      svg.addEventListener('pointerdown', e => showAt(e.clientX));
      svg.addEventListener('pointermove', e => showAt(e.clientX));
      svg.addEventListener('pointerleave', hideScrub);
      svg.addEventListener('touchstart', e => { if (e.touches && e.touches.length) showAt(e.touches[0].clientX); }, { passive: true });
      svg.addEventListener('touchmove', e => { if (e.touches && e.touches.length) showAt(e.touches[0].clientX); }, { passive: true });
      svg.addEventListener('touchend', hideScrub);
      svg.addEventListener('touchcancel', hideScrub);
    }
    return svg;
  }

  function barChart(bars, unit, opts) {
    opts = opts || {};
    const color = opts.color || '#3D87F5';
    const W = 600, H = 240, padL = 42, padR = 14, padT = 14, padB = 38;
    const max = Math.max.apply(null, bars.map(b => b.value)) || 1;
    const ticks = niceTicks(0, max, opts.intY ? Math.min(5, max + 1) : 5).filter(t => t >= 0);
    const ymax = ticks[ticks.length - 1] || 1;
    const yFor = (v) => H - padB - (v / ymax) * (H - padT - padB);
    const bw = (W - padL - padR) / bars.length;
    const svg = svgNS('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
    // gridlines + y labels
    ticks.forEach(tv => {
      svg.appendChild(svgNS('line', { x1: padL, y1: yFor(tv), x2: W - padR, y2: yFor(tv), stroke: '#EFEFF3', 'stroke-width': 1.5 }));
      const tx = svgNS('text', { x: padL - 6, y: yFor(tv) + 4, fill: '#A5A5BE', 'font-size': 11, 'text-anchor': 'end' }); tx.textContent = opts.intY ? Math.round(tv) : tv; svg.appendChild(tx);
    });
    const axt = svgNS('text', { x: 12, y: padT + 4, fill: '#A5A5BE', 'font-size': 10 }); axt.textContent = unit; svg.appendChild(axt);
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
        const vt = svgNS('text', { x: x + rw / 2, y: H - padB - h - 4, fill: '#2E2E42', 'font-size': 10, 'font-weight': 700, 'text-anchor': 'middle' }); vt.textContent = b.value; svg.appendChild(vt);
      }
      // x label (thinned)
      const lblStep = Math.max(1, Math.ceil(bars.length / 8));
      if (i % lblStep === 0 || i === bars.length - 1) {
        const tx = svgNS('text', { x: x + rw / 2, y: H - padB + 16, fill: '#A5A5BE', 'font-size': 10, 'text-anchor': 'middle' }); tx.textContent = b.label; svg.appendChild(tx);
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
    [['#33B94F', 4, 5, 'Good'], ['#F6A723', 3, 4, 'OK'], ['#F04E4E', 1, 3, 'Sore']].forEach(z => {
      svg.appendChild(svgNS('rect', { x: padL, y: yFor(z[2]), width: W - padL - padR, height: yFor(z[1]) - yFor(z[2]), fill: z[0], opacity: 0.08 }));
      const lt = svgNS('text', { x: W - padR - 2, y: yFor((z[1] + z[2]) / 2) + 4, fill: z[0], 'font-size': 10, 'text-anchor': 'end', opacity: 0.7 }); lt.textContent = z[3]; svg.appendChild(lt);
    });
    // y ticks 1..5
    [1, 2, 3, 4, 5].forEach(yv => {
      const tx = svgNS('text', { x: padL - 6, y: yFor(yv) + 4, fill: '#A5A5BE', 'font-size': 10, 'text-anchor': 'end' }); tx.textContent = yv; svg.appendChild(tx);
    });
    // x labels
    const step = Math.max(1, Math.ceil(pts.length / 6));
    pts.forEach((p, i) => {
      if (i % step !== 0 && i !== pts.length - 1) return;
      const tx = svgNS('text', { x: xFor(i), y: H - padB + 16, fill: '#A5A5BE', 'font-size': 10, 'text-anchor': 'middle' }); tx.textContent = fmtShort(p.x); svg.appendChild(tx);
    });
    let d = '';
    pts.forEach((p, i) => { d += (i ? ' L' : 'M') + xFor(i) + ' ' + yFor(p.y); });
    svg.appendChild(svgNS('path', { d, fill: 'none', stroke: '#C9CDDA', 'stroke-width': 2 }));
    pts.forEach((p, i) => {
      const c = svgNS('circle', { cx: xFor(i), cy: yFor(p.y), r: 4,
        fill: p.y >= 4 ? '#33B94F' : p.y === 3 ? '#F6A723' : '#F04E4E', stroke: '#FFFFFF', 'stroke-width': 1.5 });
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
        el('span', { class: 'stat-value', 'data-countup': '', style: s.color ? `color:${s.color}` : null }, [s.value]),
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
    const filters = ['All', 'Pickup', 'Yielding', 'OI', 'Climbing', 'Heavy', 'Volume'];
    const chips = el('div', { class: 'chips' });
    filters.forEach(f => chips.appendChild(chip(f, App.state.historyFilter === f, () => { App.state.historyFilter = f; App.render(); })));
    view.appendChild(chips);
    view.appendChild(el('button', { class: 'btn small ghost', onclick: () => App.importCSV() }, ['Import CSV']));

    let logs = await DB.logsNewestFirst();
    const f = App.state.historyFilter;
    if (f !== 'All') logs = logs.filter(l => l.type === f || l.role === f);
    if (!logs.length) { view.appendChild(el('div', { class: 'card' }, ['No entries.'])); return; }
    logs.forEach(l => {
      const pickup = Calc.isPickup(l);
      const item = el('button', { class: 'list-item',
        onclick: () => pickup ? App.openPickupLog(l) : App.openManualLog(l) });
      item.appendChild(el('div', { class: 'li-top' }, [
        el('span', { class: 'li-date' }, [fmtDate(l.date)]),
        el('span', { class: 'muted' }, [
          pickup ? `Block pull · ${Calc.holdSecondsOf(l) || '?'}s${l.edgeMm ? ' · ' + l.edgeMm + 'mm' : ''}`
                 : `${l.role || l.type} · ${l.venue || ''}`
        ])
      ]));
      const bits = [];
      if (pickup) {
        Calc.HANDS.forEach(h => {
          const load = Calc.topLoad(l, h);
          if (load == null) return;
          const rpe = Calc.topRPE(l, h);
          // RIR is what was entered; RPE is only the storage form.
          const rir = rpe != null ? Math.round((10 - rpe) * 10) / 10 : null;
          bits.push(`${h} ${load}kg${rir != null ? ' · ' + rir + ' RIR' : ''}` +
                    (Calc.topSetDegraded(l, h) ? ' ⚠' : ''));
        });
        const lL = Calc.topLoad(l, 'L'), lR = Calc.topLoad(l, 'R');
        if (lL != null && lR != null) {
          const hi = Math.max(lL, lR);
          if (hi) bits.push('gap ' + (Math.round(((hi - Math.min(lL, lR)) / hi) * 1000) / 10) + '%');
        }
      }
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
      di.addEventListener('change', async () => { cycle.startDate = di.value; await DB.save('cycles', cycle); });
      c3.appendChild(el('div', { class: 'field' }, [el('label', null, [`Start date · ${cycle.name}`]), di]));
      c3.appendChild(el('p', { class: 'muted' }, ['Units: kg']));
      view.appendChild(c3);
    }
    
    // GitHub Gist Sync Card
    const token = await DB.getMeta('githubToken');
    const gistId = await DB.getMeta('githubGistId');
    const lastSyncAt = await DB.getMeta('lastSyncAt');
    const cSync = el('div', { class: 'card' });
    cSync.appendChild(el('h2', { style: 'margin-top:0' }, ['GitHub Gist Sync']));

    if (token) {
      cSync.appendChild(el('p', { class: 'muted', style: 'margin-bottom:8px' }, [
        `Status: Connected `,
        el('span', { style: 'color:var(--success);font-weight:700' }, ['●'])
      ]));
      if (gistId) {
        cSync.appendChild(el('p', { class: 'muted', style: 'margin-bottom:4px' }, [`Gist ID: ${gistId}`]));
      } else {
        cSync.appendChild(el('p', { class: 'muted', style: 'margin-bottom:4px' }, ['No Gist linked yet. It will be created on the first sync.']));
      }
      cSync.appendChild(el('p', { class: 'muted', style: 'margin-bottom:12px' }, [
        lastSyncAt ? `Last synced: ${new Date(lastSyncAt).toLocaleString()} · syncs automatically` : 'Not synced yet on this device · syncs automatically once connected'
      ]));

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

      const tokInput = el('input', { type: 'password', class: 'input', placeholder: 'ghp_xxxxxxxxxxxx', style: 'margin-bottom:12px' });
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
        await DB.save('workingMaxes', { id: Templates.uid(), durationSeconds: duration, valueKg: newVal,
          date: todayISO(), source: 'manual', notes: '' });
        App.render();
        if (window.Sync && Sync.auto) Sync.auto({ force: true });
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
    // Pickup records have a different shape entirely — send them to their own
    // editor rather than letting this form write nulls over the hands object.
    if (Calc.isPickup(existing)) return App.openPickupLog(existing);
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
    body.push(selectField('Type', ['Yielding', 'OI', 'Climbing'], state.type, v => {
      state.type = v; updE1RM();
      boField.style.display = v === 'Yielding' ? '' : 'none';   // per-set rows are a Yielding concept
      if (v !== 'Yielding') setsField.style.display = '';
      else syncSets();
    }));
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
    const setsField = el('div', { class: 'field' }, [el('label', null, ['Sets']), setsSt]);
    body.push(setsField);
    const e1rmLine = el('p', { class: 'muted' }, ['']);
    body.push(e1rmLine);

    // ---- back-off sets (per-set detail) --------------------------------
    // setsDetail[0] always mirrors the top-set steppers; the rows below are
    // the back-offs. While rows exist the Sets count is derived (1 + rows)
    // and the manual Sets stepper is hidden to keep the two consistent.
    const boRows = (Array.isArray(e.setsDetail) ? e.setsDetail.slice(1) : [])
      .map(s => ({ load: (s && s.load != null) ? s.load : 0, rpe: (s && s.rpe != null) ? s.rpe : 7.5 }));
    const hadDetail = Array.isArray(e.setsDetail) && e.setsDetail.length > 0;
    const boList = el('div', null, []);
    const boField = el('div', { class: 'field' }, [el('label', null, ['Back-off sets']), boList]);
    function syncSets() {
      if (boRows.length) setsSt.setValue(1 + boRows.length);
      setsField.style.display = boRows.length ? 'none' : '';
    }
    function redrawBo() {
      boList.innerHTML = '';
      boRows.forEach((r, i) => {
        const lSt = stepper({ min: 0, max: 80, step: 0.5, value: r.load, fmt: v => v + ' kg', onChange: v => r.load = v });
        const rSt = stepper({ min: 5, max: 10, step: 0.5, value: r.rpe, fmt: v => '@' + v, onChange: v => r.rpe = v });
        boList.appendChild(el('div', { class: 'row', style: 'margin:8px 0 4px' }, [
          el('span', { class: 'muted' }, ['Set ' + (i + 2)]),
          el('button', { class: 'btn secondary', style: 'padding:2px 12px;min-height:0',
            onclick: () => { boRows.splice(i, 1); redrawBo(); } }, ['×'])
        ]));
        boList.appendChild(el('div', { class: 'grid2' }, [lSt, rSt]));
      });
      boList.appendChild(el('button', { class: 'btn secondary', style: 'margin-top:6px', onclick: () => {
        if (boRows.length >= 9) return;
        const prev = boRows[boRows.length - 1];
        boRows.push(prev ? { load: prev.load, rpe: prev.rpe }
          : { load: Calc.roundTo05(loadSt.getValue() * 0.85), rpe: 7.5 });   // ~85% of top, @7-8 zone
        redrawBo();
      } }, ['+ Add back-off set']));
      syncSets();
    }
    redrawBo();
    if (state.type !== 'Yielding') boField.style.display = 'none';
    body.push(boField);
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
        // Per-set detail: [0] mirrors the top-set steppers, rest come from the
        // back-off rows above. Entries that never had detail and got no rows
        // stay null; non-Yielding types keep whatever they had (no UI for it).
        setsDetail: state.type === 'Yielding'
          ? ((boRows.length || hadDetail)
              ? [{ load: loadSt.getValue(), rpe: rpeSt.getValue() }]
                  .concat(boRows.map(r => ({ load: r.load, rpe: r.rpe })))
              : null)
          : (e.setsDetail || null),
        sets: setsSt.getValue(), bodyweightKg: bw,
        taxing: taxR.getValue(), feltStrong: feltR.getValue(), nextDayFeel: state.ndf != null ? state.ndf : (e.nextDayFeel || null),
        block: blk || '', notes: state.notes
      };
      await DB.addLog(entry);
      // benchmark capture: Test role explicitly, any other session on a PR
      if (entry.role === 'Test' && entry.topSetLoadKg) await maybeBenchmark(entry);
      else await maybeAutoBenchmarkPR(entry);
      App.closeSheet(); App.render();
      if (window.Sync && Sync.auto) Sync.auto({ force: true });
    } }, [existing ? 'Save changes' : 'Save session']));

    if (existing) body.push(el('button', { class: 'btn danger', style: 'margin-top:8px', onclick: async () => {
      App.confirm('Delete this entry?', 'Delete', async () => { await DB.softDelete('logEntries', e.id); App.closeSheet(); App.render(); });
    } }, ['Delete']));

    App.sheet(existing ? 'Edit session' : 'Log session', body);
  };

  // =====================================================================
  // MANUAL PICKUP LOG (also used for editing)
  // =====================================================================
  // Separate sheet rather than a branch inside openManualLog: the two record
  // shapes barely overlap (two hands, reps per set, per-set position outcome,
  // no bodyweight, no working max) and interleaving them produced a form where
  // most fields were hidden most of the time.
  App.openPickupLog = function (existing) {
    const e = existing || {};
    const body = [];
    const st = {
      date: e.date || todayISO(),
      holdSeconds: Calc.holdSecondsOf(e) || 3,
      edgeMm: e.edgeMm != null ? e.edgeMm : 20,
      grip: e.grip || 'HalfCrimp',
      firstHand: e.firstHand === 'R' ? 'R' : 'L',
      readiness: e.readiness != null ? e.readiness : null,
      climbing48h: e.climbing48h || null,
      taxing: e.taxing, felt: e.feltStrong, ndf: e.nextDayFeel,
      notes: e.notes || ''
    };

    // Existing detail wins; a record with only a top set degrades to one row.
    const rows = { L: [], R: [] };
    Calc.HANDS.forEach(h => {
      const d = Calc.setsDetailOf(e, h);
      if (d && d.length) {
        rows[h] = d.map(s => ({
          load: s && s.load != null ? s.load : 0,
          rpe: s && s.rpe != null ? s.rpe : 8.5,
          reps: s && s.reps != null ? s.reps : null,
          outcome: (s && OUTCOMES.indexOf(s.outcome) >= 0) ? s.outcome : 'clean'
        }));
        return;
      }
      const load = Calc.topLoad(e, h);
      if (load != null) {
        const r = Calc.topRPE(e, h);
        rows[h] = [{ load, rpe: r != null ? r : 8.5, reps: null, outcome: 'clean' }];
      }
    });

    const dInput = el('input', { type: 'date', value: st.date });
    dInput.addEventListener('change', () => st.date = dInput.value);
    body.push(el('div', { class: 'field' }, [el('label', null, ['Date']), dInput]));

    const edgeSt = stepper({ min: 6, max: 40, step: 1, value: st.edgeMm, fmt: v => v + ' mm', onChange: v => st.edgeMm = v });
    const holdSt = stepper({ min: 1, max: 15, step: 1, value: st.holdSeconds, fmt: v => v + ' s', onChange: v => st.holdSeconds = v });
    body.push(el('div', { class: 'grid2' }, [
      el('div', { class: 'field' }, [el('label', null, ['Edge']), edgeSt]),
      el('div', { class: 'field' }, [el('label', null, ['Hold']), holdSt])
    ]));
    body.push(selectField('Grip', ['HalfCrimp', 'OpenHand', 'ThreeFingerDrag'], st.grip, v => st.grip = v));
    body.push(selectField('First hand', ['L', 'R'], st.firstHand, v => st.firstHand = v));

    const readyR = rating(5, st.readiness, v => st.readiness = v);
    body.push(el('div', { class: 'field' }, [el('label', null, ['Readiness before the session (1–5)']), readyR]));
    body.push(selectField('Climbing in last 48h', ['', 'none', 'easy', 'hard'], st.climbing48h || '',
      v => st.climbing48h = v || null));

    // ---- per-hand sets --------------------------------------------------
    // Row 0 is the top set; the rest are back-offs. Outcome is per SET here
    // (the runner records it per rep and collapses to the worst) — a manual
    // entry after the fact can't honestly reconstruct individual reps.
    Calc.HANDS.forEach(h => {
      const list = el('div', null, []);
      const field = el('div', { class: 'field' }, [
        el('label', null, [h === 'L' ? 'Left hand · sets' : 'Right hand · sets']), list
      ]);
      function redraw() {
        list.innerHTML = '';
        rows[h].forEach((r, i) => {
          const lSt = stepper({ min: 0, max: 120, step: 0.5, value: r.load, fmt: v => v + ' kg', onChange: v => r.load = v });
          const rSt = stepper({ min: 0, max: 4, step: 0.5, value: Math.min(4, Math.max(0, 10 - r.rpe)),
            fmt: v => v + ' RIR', onChange: v => r.rpe = 10 - v });
          const oSel = el('select');
          OUTCOMES.forEach(o => {
            const op = el('option', { value: o }, [o]); if (o === r.outcome) op.selected = true; oSel.appendChild(op);
          });
          oSel.addEventListener('change', () => r.outcome = oSel.value);
          list.appendChild(el('div', { class: 'row', style: 'margin:8px 0 4px' }, [
            el('span', { class: 'muted' }, [i === 0 ? 'Top set' : 'Back-off ' + i]),
            el('button', { class: 'btn secondary', style: 'padding:2px 12px;min-height:0',
              onclick: () => { rows[h].splice(i, 1); redraw(); } }, ['×'])
          ]));
          list.appendChild(el('div', { class: 'grid2' }, [lSt, rSt]));
          list.appendChild(oSel);
        });
        list.appendChild(el('button', { class: 'btn secondary', style: 'margin-top:6px', onclick: () => {
          if (rows[h].length >= 9) return;
          const prev = rows[h][rows[h].length - 1];
          const top = rows[h][0];
          rows[h].push(prev && top
            ? { load: Calc.roundTo05(top.load * 0.88), rpe: prev.rpe, reps: prev.reps, outcome: 'clean' }
            : { load: 0, rpe: 8.5, reps: null, outcome: 'clean' });
          redraw();
        } }, [rows[h].length ? '+ Add set' : '+ Add top set']));
      }
      redraw();
      body.push(field);
    });

    const taxR = rating(5, st.taxing, v => st.taxing = v);
    const feltR = rating(10, st.felt, v => st.felt = v);
    const ndfR = rating(5, st.ndf, v => st.ndf = v);
    body.push(el('div', { class: 'field' }, [el('label', null, ['Session taxing (1–5)']), taxR]));
    body.push(el('div', { class: 'field' }, [el('label', null, ['Felt strong (1–10)']), feltR]));
    body.push(el('div', { class: 'field' }, [el('label', null, ['Next-day feel (1–5, fill tomorrow)']), ndfR]));

    const notes = el('textarea', { placeholder: 'Notes' }); notes.value = st.notes;
    notes.addEventListener('input', () => st.notes = notes.value);
    body.push(el('div', { class: 'field' }, [el('label', null, ['Notes']), notes]));

    body.push(el('button', { class: 'btn', onclick: async () => {
      const hands = {};
      Calc.HANDS.forEach(h => {
        if (!rows[h].length) { hands[h] = null; return; }
        hands[h] = {
          topSetLoadKg: rows[h][0].load,
          topSetRPE: rows[h][0].rpe,
          setsDetail: rows[h].map(r => ({ load: r.load, rpe: r.rpe, reps: r.reps, outcome: r.outcome, outcomes: [] }))
        };
      });
      if (!hands.L && !hands.R) { App.confirm('Add at least one set for one hand.', 'OK', () => {}); return; }
      const entry = App.buildPickupEntry(null, {
        date: st.date, holdSeconds: st.holdSeconds, grip: st.grip, edgeMm: st.edgeMm,
        hands, firstHand: st.firstHand, readiness: st.readiness, climbing48h: st.climbing48h,
        sets: rows.L.length + rows.R.length,
        taxing: taxR.getValue(), felt: feltR.getValue(), nextDayFeel: ndfR.getValue(),
        notes: st.notes
      }, e);
      entry.block = e.block || (await blockNameFor(st.date)) || '';
      await DB.addLog(entry);
      App.closeSheet(); App.render();
      if (window.Sync && Sync.auto) Sync.auto({ force: true });
    } }, [existing ? 'Save changes' : 'Save session']));

    if (existing) body.push(el('button', { class: 'btn danger', style: 'margin-top:8px', onclick: () => {
      App.confirm('Delete this entry?', 'Delete', async () => {
        await DB.softDelete('logEntries', e.id); App.closeSheet(); App.render();
      });
    } }, ['Delete']));

    App.sheet(existing ? 'Edit block pull' : 'Log block pull', body);
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
    await DB.save('benchmarks', { id: Templates.uid(), date: entry.date, durationSeconds: dur,
      maxLoadKg: entry.topSetLoadKg, rpe: entry.topSetRPE, resultingWMId: null });
    // offer to update WM
    const guard = Calc.wmJumpGuard(entry.topSetLoadKg, cur && cur.valueKg);
    const apply = async () => {
      await DB.save('workingMaxes', { id: Templates.uid(), durationSeconds: dur, valueKg: entry.topSetLoadKg,
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

  // Auto-benchmark on a session PR: a Yielding top set heavier than every
  // previous log AND benchmark for that duration demonstrated a new max —
  // record it as a benchmark automatically (Martin, 2026-07-04). Test-day
  // sessions keep the explicit maybeBenchmark path; CSV/bundled imports
  // never pass through here, so history loads can't spam benchmarks.
  // The Working Max update stays behind the same confirm + jump guard as
  // test days — the benchmark is automatic, the anchor change is a choice.
  async function maybeAutoBenchmarkPR(entry) {
    if (!entry || entry.type !== 'Yielding' || entry.topSetLoadKg == null || !entry.hangDurationSeconds) return;
    const dur = entry.hangDurationSeconds;
    const [logs, benches] = await Promise.all([DB.getAll('logEntries'), DB.getAll('benchmarks')]);
    const prevLogs = logs.filter(l => l.id !== entry.id && l.type === 'Yielding' &&
      l.hangDurationSeconds === dur && l.topSetLoadKg != null).map(l => l.topSetLoadKg);
    const prevBench = benches.filter(b => b.durationSeconds === dur && b.maxLoadKg != null).map(b => b.maxLoadKg);
    const baseline = prevLogs.concat(prevBench);
    if (!baseline.length) return;                      // first entry for this duration — no PR to beat
    const prevBest = Math.max.apply(null, baseline);
    if (!(entry.topSetLoadKg > prevBest)) return;      // not a PR

    const cur = await DB.currentWM(dur);
    await DB.save('benchmarks', { id: Templates.uid(), date: entry.date, durationSeconds: dur,
      maxLoadKg: entry.topSetLoadKg, rpe: entry.topSetRPE, resultingWMId: null, source: 'session-pr' });
    const guard = Calc.wmJumpGuard(entry.topSetLoadKg, cur && cur.valueKg);
    const apply = async () => {
      await DB.save('workingMaxes', { id: Templates.uid(), durationSeconds: dur, valueKg: entry.topSetLoadKg,
        date: entry.date, source: 'session-pr', notes: 'From session PR (auto benchmark)' });
      App.render();
    };
    const rpeTxt = entry.topSetRPE != null ? ` @${entry.topSetRPE}` : '';
    if (guard.triggered) {
      App.confirm(`New ${dur}s PR — ${entry.topSetLoadKg} kg${rpeTxt} saved as a benchmark. That's a big jump (+${guard.pct}%) for your ${dur}s WM. Update it to ${entry.topSetLoadKg} kg? If it felt like an absolute ceiling, consider 1–2 kg lower.`, `Set ${dur}s WM`, apply);
    } else {
      App.confirm(`New ${dur}s PR — ${entry.topSetLoadKg} kg${rpeTxt} saved as a benchmark. Update your ${dur}s Working Max to ${entry.topSetLoadKg} kg?`, `Set ${dur}s WM`, apply);
    }
  }
  App.maybeAutoBenchmarkPR = maybeAutoBenchmarkPR;

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
      await DB.save('logEntries', entry);
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
  // Sanitizer shared by the runner and the manual pickup editor.
  const OUTCOMES = ['clean', 'degraded', 'failed'];
  function sanitizePickupSets(arr) {
    if (!Array.isArray(arr)) return null;
    return arr.map(s => ({
      load: (s && s.load != null && isFinite(+s.load)) ? +s.load : null,
      rpe: (s && s.rpe != null && isFinite(+s.rpe)) ? +s.rpe : null,
      reps: (s && s.reps != null && isFinite(+s.reps)) ? +s.reps : null,
      outcome: (s && OUTCOMES.indexOf(s.outcome) >= 0) ? s.outcome : null,
      outcomes: Array.isArray(s && s.outcomes) ? s.outcomes.filter(o => OUTCOMES.indexOf(o) >= 0) : []
    }));
  }
  function pickupSide(src) {
    if (!src || src.topSetLoadKg == null || !isFinite(+src.topSetLoadKg)) return null;
    return {
      topSetLoadKg: +src.topSetLoadKg,
      topSetRPE: (src.topSetRPE != null && isFinite(+src.topSetRPE)) ? +src.topSetRPE : null,
      setsDetail: sanitizePickupSets(src.setsDetail),
      e1rmKg: null           // DB.addLog computes it per hand
    };
  }

  App.buildPickupEntry = function (plan, result, existing) {
    const e = existing || {};
    return {
      id: e.id || Templates.uid(),
      date: result.date || todayISO(),
      modality: 'pickup',
      // type stays 'Yielding' — it IS yielding isometric work, and `modality`
      // is the single discriminator. The FLAT load/RPE/E1RM fields stay null,
      // which is what keeps this record out of every hang query (analytics
      // series, deloadTrend, auto-PR benchmarks, weekly volume) with no
      // changes at those call sites. See the accessor block in calc.js.
      type: 'Yielding', role: 'Pickup', venue: e.venue || 'Home',
      hangDurationSeconds: null,
      holdSeconds: result.holdSeconds != null ? result.holdSeconds : ((plan && plan.duration) || 3),
      grip: result.grip || (plan && plan.grip) || 'HalfCrimp',
      edgeMm: result.edgeMm != null ? result.edgeMm : ((plan && plan.edgeMm) || null),
      hands: { L: pickupSide(result.hands && result.hands.L),
               R: pickupSide(result.hands && result.hands.R) },
      firstHand: result.firstHand === 'R' ? 'R' : 'L',
      readiness: result.readiness != null ? result.readiness : null,
      climbing48h: result.climbing48h || null,
      topSetLoadKg: null, topSetRPE: null, e1rmKg: null, setsDetail: null,
      sets: result.sets != null ? result.sets : null,
      bodyweightKg: null,
      taxing: result.taxing != null ? result.taxing : null,
      feltStrong: result.felt != null ? result.felt : (e.feltStrong != null ? e.feltStrong : null),
      nextDayFeel: result.nextDayFeel != null ? result.nextDayFeel : (e.nextDayFeel != null ? e.nextDayFeel : null),
      block: (plan && plan.blockName) || e.block || '',
      notes: result.notes || ''
    };
  };

  async function logPickupSession(plan, result) {
    const entry = App.buildPickupEntry(plan, result);
    entry.block = entry.block || (await blockNameFor(entry.date)) || '';
    await DB.addLog(entry);
    await DB.setMeta('pendingNextDayFeel', { logEntryId: entry.id, sessionDate: entry.date });
    // No benchmark/WM path: pickups opt out of the Working Max system
    // entirely (see annotateWeekAnchors) — there is no anchor for a test to
    // refresh, and the WM store keys on durationSeconds alone, so a 3s pickup
    // max would collide with the 3s hang max already on file.
    App.go('today');
    if (window.Sync && Sync.auto) Sync.auto({ force: true });
  }

  App.logSession = async function (plan, result) {
    if (result && result.modality === 'pickup') return logPickupSession(plan, result);
    const bw = (await DB.getMeta('bodyweightKg')) || null;
    const entry = {
      // result.date: the runner carries the day the session was STARTED, so a
      // session recovered after an app kill still logs under its real date.
      id: Templates.uid(), date: result.date || todayISO(), type: plan.role === 'OIprimer' ? 'OI' : 'Yielding',
      role: plan.role, venue: 'Board', hangDurationSeconds: plan.duration || null, grip: 'HalfCrimp',
      topSetLoadKg: result.load != null ? result.load : null,
      topSetRPE: result.rpe != null ? result.rpe : null, sets: result.sets,
      // Per-effort capture from the runner: [{load, rpe}, ...] — top set first,
      // then back-offs. Raw data only; nothing reads it yet (future: back-off
      // fatigue/readiness analytics). Additive field: sync merge + import keep
      // whole records, so old clients simply carry it along.
      setsDetail: Array.isArray(result.setsDetail)
        ? result.setsDetail.map(s => ({
            load: (s && s.load != null && isFinite(+s.load)) ? +s.load : null,
            rpe: (s && s.rpe != null && isFinite(+s.rpe)) ? +s.rpe : null
          }))
        : null,
      bodyweightKg: bw, taxing: result.taxing, feltStrong: result.felt, nextDayFeel: null,
      block: plan.blockName || '', notes: result.notes || ''
    };
    await DB.addLog(entry);
    await DB.setMeta('pendingNextDayFeel', { logEntryId: entry.id, sessionDate: entry.date });
    if (plan.role === 'Test' && entry.topSetLoadKg) await maybeBenchmark(entry);
    else await maybeAutoBenchmarkPR(entry);
    App.go('today');
    if (window.Sync && Sync.auto) Sync.auto({ force: true });
  };

  // ---- unfinished-session recovery --------------------------------------
  // The runner snapshots in-progress sessions to the (device-local) meta key
  // 'pendingRunnerSession'. If the app was killed mid-session, offer at launch:
  // resume (same-day only), save what's done (dated to the session day), or
  // discard. Closing the sheet keeps the snapshot for the next launch.
  async function checkPendingRunnerSession() {
    let snap;
    try { snap = await DB.getMeta('pendingRunnerSession'); } catch (e) { return; }
    if (!snap || !snap.plan) return;
    const sets = Array.isArray(snap.sets) ? snap.sets : [];
    const stale = !!snap.date && snap.date < todayISO();
    if (stale && !sets.length) { DB.setMeta('pendingRunnerSession', null); return; } // nothing worth saving
    const clear = () => DB.setMeta('pendingRunnerSession', null);

    const when = snap.date ? (stale ? fmtDate(snap.date) : 'today') : 'earlier';
    const what = [snap.plan.blockName, snap.plan.role].filter(Boolean).join(' · ');
    const loads = sets.filter(s => s && s.load != null).map(s => s.load + 'kg@' + s.rpe).join('  ');
    const nodes = [
      el('p', null, [`You left a session unfinished ${when} (${what}).`]),
      el('p', { class: 'muted' }, [
        sets.length
          ? `${sets.length} of ${snap.totalEfforts || '?'} efforts logged` + (loads ? ': ' + loads : '')
          : 'No efforts logged yet.'
      ])
    ];
    if (!stale) nodes.push(el('button', {
      class: 'btn',
      onclick: () => { App.closeSheet(); Runner.resume(snap); }
    }, ['Resume session']));
    if (sets.length) nodes.push(el('button', {
      class: !stale ? 'btn secondary' : 'btn',
      onclick: () => { App.closeSheet(); Runner.finishPending(snap); }
    }, ['Save what’s done']));
    nodes.push(el('div', { class: 'spacer' }));
    nodes.push(el('button', {
      class: 'btn secondary',
      onclick: () => { clear(); App.closeSheet(); }
    }, ['Discard']));
    App.sheet('Unfinished session', nodes);
  }

  // ---- boot -------------------------------------------------------------
  document.body.addEventListener('touchstart', () => {}, { passive: true });
  document.querySelectorAll('#tabbar .tab').forEach(t =>
    t.addEventListener('click', () => App.go(t.dataset.tab)));

  (async function init() {
    try {
      // Ask the browser to protect IndexedDB from storage-pressure eviction
      // (matters on iOS Safari for an offline-first training log).
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
      }
      await DB.seedIfEmpty();
      await DB.dedupe(); // clean up any duplicate/triplicate rows from past syncs
    } catch (err) {
      console.error('Init error:', err);
    }
    App.go('today'); // render() has its own error boundary
    checkPendingRunnerSession().catch(() => {});
    // Background sync: on launch and whenever the app returns to foreground.
    if (window.Sync && Sync.auto) {
      Sync.auto();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') Sync.auto();
      });
    }
  })();
})();

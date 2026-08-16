/* timer.js — full-screen in-session runner.
 * State machine: PREP -> HANG -> LOG_SET -> (REST -> HANG -> LOG_SET ...) -> END
 * Hands-free: Wake Lock, Web Speech + Web Audio tones. Audio unlocked on first tap. */
(function (root) {
  'use strict';

  let audioCtx = null, wakeLock = null;
  let tickHandle = null;

  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      // tiny silent blip to satisfy iOS gesture unlock
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      g.gain.value = 0.0001; o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.02);
    } catch (e) {}
  }
  function tone(freq, ms, vol) {
    if (!audioCtx) return;
    try {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.type = 'sine';
      g.gain.setValueAtTime(vol || 0.3, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + ms / 1000);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + ms / 1000);
    } catch (e) {}
  }
  function bell() { tone(880, 180, 0.35); setTimeout(() => tone(1175, 320, 0.3), 120); }
  function say(text) {
    try {
      if (!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; u.volume = 1; u.pitch = 1;
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await Promise.race([
          navigator.wakeLock.request('screen'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000))
        ]);
      }
    } catch (e) {}
  }
  function releaseWakeLock() { try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {} }
  document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') await acquireWakeLock();
  });

  const Runner = {};
  let R = null; // current session state

  // ---- crash/close recovery ---------------------------------------------
  // R lives only in memory, so an app kill (iOS reclaiming the PWA, closed
  // tab, forgotten session) used to lose everything. We snapshot the
  // serializable session state to a device-local meta key after every logged
  // set / phase change; app.js checks it at launch and offers to recover.
  const PENDING_KEY = 'pendingRunnerSession';
  function localToday() { // local calendar date, same rule as app.js todayISO
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  }
  function persistR() {
    if (!R) return;
    try {
      const snap = JSON.parse(JSON.stringify({ // strips _steppers/undefined
        plan: R.plan, restDefault: R.restDefault, phase: R.phase,
        effort: R.effort, totalEfforts: R.totalEfforts, hangSeconds: R.hangSeconds,
        sets: R.sets, curLoad: R.curLoad, curRPE: R.curRPE,
        warmupKg: R.warmupKg, readiness: R.readiness, skipExtensions: R.skipExtensions,
        date: R.date,
        // Pickup state. Omitted entirely on hang sessions, so an old snapshot
        // resumes exactly as before.
        modality: R.modality, stage: R.stage, hand: R.hand, firstHand: R.firstHand,
        rampIdx: R.rampIdx, rep: R.rep, repsPerSet: R.repsPerSet,
        repOutcomes: R.repOutcomes, handSets: R.handSets, curLoadBy: R.curLoadBy,
        topBy: R.topBy, prep: R.prep,
        savedAt: Date.now()
      }));
      DB.setMeta(PENDING_KEY, snap).catch(() => {});
    } catch (e) {}
  }

  // ---- pickup helpers ----------------------------------------------------
  // Block pulls are one-handed, so a session is two interleaved series. The
  // hands ALTERNATE (L set -> ~90s -> R set -> ~90s -> L set ...): each hand
  // then gets ~3 min of real recovery while the session costs half the wall
  // clock of doing all of one hand and then all of the other. Alternating also
  // avoids the second hand always working in a more fatigued whole-body state.
  const OTHER = { L: 'R', R: 'L' };
  const HAND_LABEL = { L: 'Left', R: 'Right' };
  function isPickup() { return R && R.modality === 'pickup'; }
  // Load for the current hand at the current point in the session. Ramp steps
  // are percentages of that hand's last CLEAN top set; back-offs are a
  // percentage of the top set found TODAY, which is why they can't be
  // prescribed in advance.
  function pickupTargetLoad() {
    const p = R.plan, h = R.hand;
    const last = (p.lastTop && p.lastTop[h] != null) ? p.lastTop[h] : null;
    if (R.stage === 'ramp') {
      const pct = (p.rampPcts || [])[R.rampIdx];
      return (last != null && pct != null) ? Calc.roundTo05(last * pct) : null;
    }
    if (R.effort === 0) return last;                       // top set: yesterday's number as a starting point
    const top = R.topBy && R.topBy[h];
    return top != null ? Calc.roundTo05(top * (p.backoffPctOfTop || 0.88)) : last;
  }

  // Set-level outcome = the WORST rep in it. One rep where the fingers rolled
  // open means the load wasn't expressed in position, so the set doesn't count
  // as clean — averaging outcomes would let a broken rep hide behind two good
  // ones, which defeats the point of recording them.
  const OUTCOME_RANK = { clean: 0, degraded: 1, failed: 2 };
  function worstOutcome(list) {
    let worst = 'clean';
    (list || []).forEach(o => {
      if ((OUTCOME_RANK[o] || 0) > (OUTCOME_RANK[worst] || 0)) worst = o;
    });
    return worst;
  }
  function handPayload(h) {
    const list = (R.handSets && R.handSets[h]) || [];
    if (!list.length) return null;
    const top = list[0];                      // effort 0 is always logged first
    return {
      topSetLoadKg: top.load != null ? top.load : null,
      topSetRPE: top.rpe != null ? top.rpe : null,
      setsDetail: list.map(s => ({
        load: s.load != null ? s.load : null,
        rpe: s.rpe != null ? s.rpe : null,
        reps: s.reps != null ? s.reps : null,
        outcome: worstOutcome(s.outcomes),
        outcomes: Array.isArray(s.outcomes) ? s.outcomes.slice() : []
      }))
    };
  }
  function pickupSummaryLine() {
    const hs = R.handSets || { L: [], R: [] };
    const parts = ['L', 'R'].map(h => {
      const list = hs[h] || [];
      if (!list.length) return HAND_LABEL[h] + ' —';
      const top = list[0];
      const bad = list.reduce((n, s) => n + (worstOutcome(s.outcomes) !== 'clean' ? 1 : 0), 0);
      return `${HAND_LABEL[h]} ${top.load}kg · ${list.length} set${list.length === 1 ? '' : 's'}` +
             (bad ? ` · ${bad} not clean` : '');
    });
    const l = (hs.L || [])[0], r = (hs.R || [])[0];
    if (l && r && l.load && r.load) {
      const hi = Math.max(l.load, r.load), lo = Math.min(l.load, r.load);
      parts.push('gap ' + (Math.round(((hi - lo) / hi) * 1000) / 10) + '%');
    }
    return parts.join(' · ');
  }
  function clearPending() { try { DB.setMeta(PENDING_KEY, null).catch(() => {}); } catch (e) {} }

  // Rebuild a session from a recovery snapshot. Mid-timer phases restart at
  // the prep screen for that effort (COUNT/HANG: the hang wasn't logged;
  // REST: real-world rest is long over) — logged sets are exactly preserved.
  Runner.resume = async function (snap) {
    if (R) { clearTick(); releaseWakeLock(); R = null; const h = host(); if (h) h.innerHTML = ''; }
    try {
      unlockAudio();
      await acquireWakeLock();
      R = {
        plan: snap.plan, restDefault: snap.restDefault || 180,
        phase: snap.phase || 'PREP', effort: snap.effort || 0,
        totalEfforts: snap.totalEfforts || 1,
        hangSeconds: snap.hangSeconds || (snap.plan && snap.plan.duration) || 5,
        sets: Array.isArray(snap.sets) ? snap.sets : [],
        curLoad: snap.curLoad != null ? snap.curLoad : 25,
        curRPE: snap.curRPE != null ? snap.curRPE : 9,
        timeLeft: 0, stopped: false,
        warmupKg: snap.warmupKg != null ? snap.warmupKg : null,
        readiness: snap.readiness || null, skipExtensions: !!snap.skipExtensions,
        date: snap.date || localToday()
      };
      if (snap.modality === 'pickup') {
        Object.assign(R, {
          modality: 'pickup',
          stage: snap.stage || 'work',
          rampIdx: snap.rampIdx || 0,
          firstHand: snap.firstHand === 'R' ? 'R' : 'L',
          hand: snap.hand === 'R' ? 'R' : 'L',
          // A part-finished SET is not recoverable as a set: its reps were
          // interrupted, so the count and the rest intervals are both wrong.
          // Restart the current set cleanly; completed sets are untouched.
          rep: 0, repOutcomes: [],
          repsPerSet: snap.repsPerSet || 1,
          handSets: (snap.handSets && typeof snap.handSets === 'object')
            ? { L: Array.isArray(snap.handSets.L) ? snap.handSets.L : [],
                R: Array.isArray(snap.handSets.R) ? snap.handSets.R : [] }
            : { L: [], R: [] },
          topBy: (snap.topBy && typeof snap.topBy === 'object')
            ? { L: snap.topBy.L != null ? snap.topBy.L : null,
                R: snap.topBy.R != null ? snap.topBy.R : null }
            : { L: null, R: null },
          curLoadBy: (snap.curLoadBy && typeof snap.curLoadBy === 'object')
            ? snap.curLoadBy : { L: null, R: null },
          prep: snap.prep || { readiness: null, climbing48h: null, edgeMm: null }
        });
      }
      if (R.phase === 'COUNT' || R.phase === 'HANG' || R.phase === 'REST' ||
          R.phase === 'REP_LOG' || R.phase === 'INTRA') R.phase = 'PREP';
      renderRunner();
    } catch (err) {
      alert('Error resuming session: ' + err.message);
      R = null;
    }
  };

  // Recovery option "save what's done": jump straight to the end screen so
  // the banked sets can be logged (dated to the original session day).
  Runner.finishPending = function (snap) {
    return Runner.resume(Object.assign({}, snap, { phase: 'END' }));
  };

  Runner.start = async function (plan) {
    // A previous session left in memory (user switched tabs / backgrounded the
    // PWA / abandoned it mid-way) used to make every future start silently
    // no-op via `if (R) return` — the session screen just "wouldn't show up"
    // until an app reload. Tear any stale session down and start fresh instead.
    if (R) { clearTick(); releaseWakeLock(); R = null; const h = host(); if (h) h.innerHTML = ''; }
    try {
      unlockAudio();
      await acquireWakeLock();
      // Pickup rest is the HAND-SWITCH interval, not the per-hand recovery:
      // with hands alternating, ~90s between switches gives each hand ~3 min.
      const restDefault = plan.modality === 'pickup'
        ? (await DB.getMeta('restPickupSwitch') || 90)
        : plan.protocol === 'maxSingles'
          ? (await DB.getMeta('restPeak') || 270)
          : (await DB.getMeta('restBackoff') || 180);

      let totalEfforts;
      if (plan.protocol === 'topSetPlusBackoffs') { totalEfforts = 1 + (plan.sets || 0); }
      else if (plan.protocol === 'test') { totalEfforts = (plan.testDurations || [plan.duration]).length; }
      else if (plan.protocol === 'oi' && typeof plan.sets === 'string' && plan.sets.includes('-')) {
        totalEfforts = parseInt(plan.sets.split('-')[1], 10) || 5;
      }
      else { totalEfforts = plan.sets || 1; }

      // Readiness check applies to load-based hang sessions (not OI primer).
      const loadBased = plan.protocol && plan.protocol !== 'oi';
      // Warm-up reference must come from THIS edge's 5s max: on a 15mm session
      // a 20mm-derived warm-up is several kg too heavy, which is exactly the
      // load the readiness check then misreads as "you're weak today".
      const wm5 = await DB.currentWM(5, plan.edgeMm != null ? plan.edgeMm : undefined);
      const warmupRef = (wm5 && wm5.valueKg != null) ? wm5.valueKg
        : (plan.anchor != null ? plan.anchor : null);
      const warmupKg = warmupRef != null ? Calc.roundTo05(warmupRef * 0.7) : null;

      R = {
        plan, restDefault, phase: loadBased ? 'READINESS' : 'PREP', effort: 0, totalEfforts,
        hangSeconds: plan.duration || 5,
        sets: [], // logged efforts {load,rpe}
        curLoad: plan.anchor != null ? plan.anchor : (plan.role === 'OIprimer' ? null : 25),
        curRPE: typeof plan.rpe === 'number' ? plan.rpe : (plan.rpe ? Calc.parseRPE(plan.rpe) : 9),
        timeLeft: 0, stopped: false,
        warmupKg, readiness: null, skipExtensions: false,
        date: localToday()
      };
      if (plan.modality === 'pickup') {
        const first = plan.firstHand === 'R' ? 'R' : 'L';
        const hasRamp = Array.isArray(plan.rampPcts) && plan.rampPcts.length &&
          plan.lastTop && (plan.lastTop.L != null || plan.lastTop.R != null);
        Object.assign(R, {
          modality: 'pickup',
          // Ramp percentages are of LAST session's top set, so the very first
          // session of a block has nothing to ramp off — it starts by feel.
          stage: hasRamp ? 'ramp' : 'work',
          rampIdx: 0,
          firstHand: first, hand: first,
          rep: 0, repOutcomes: [],
          repsPerSet: plan.repsPerSet || 1,
          handSets: { L: [], R: [] },     // logged sets per hand
          topBy: { L: null, R: null },    // today's top set per hand (back-off basis)
          curLoadBy: {                    // stepper memory per hand
            L: (plan.lastTop && plan.lastTop.L != null) ? plan.lastTop.L : null,
            R: (plan.lastTop && plan.lastTop.R != null) ? plan.lastTop.R : null
          },
          prep: { readiness: null, climbing48h: null, edgeMm: plan.edgeMm || null }
        });
        R.hangSeconds = plan.duration || 3;
        R.curRPE = typeof plan.rpe === 'number' ? plan.rpe : 8.5;
      }
      renderRunner();
    } catch (err) {
      alert('Error starting session: ' + err.message);
      R = null;
    }
  };

  function host() { return document.getElementById('modal-host'); }
  function clearTick() { if (tickHandle) { clearInterval(tickHandle); tickHandle = null; } }

  function effortLabel() {
    const p = R.plan;
    if (isPickup()) {
      if (R.stage === 'ramp') return `Ramp ${R.rampIdx + 1}/${(p.rampPcts || []).length}`;
      const which = R.effort === 0 ? 'Top set' : `Back-off ${R.effort}/${p.sets}`;
      return R.repsPerSet > 1 ? `${which} · rep ${Math.min(R.rep + 1, R.repsPerSet)}/${R.repsPerSet}` : which;
    }
    if (p.protocol === 'topSetPlusBackoffs') return R.effort === 0 ? 'Top set' : `Back-off ${R.effort}/${p.sets}`;
    if (p.protocol === 'maxSingles') return `Single ${R.effort + 1}/${R.totalEfforts}`;
    if (p.protocol === 'fixedVolume') return `Set ${R.effort + 1}/${R.totalEfforts}`;
    if (p.protocol === 'test') return `Test ${R.plan.testDurations[R.effort]}s`;
    if (p.protocol === 'deload') return `Deload set ${R.effort + 1}/3`;
    if (p.protocol === 'oi' && p.sets === '3-5') return `Set ${R.effort + 1}/3–5`;
    return `Effort ${R.effort + 1}`;
  }

  function shell(cls, inner) {
    const wrap = document.createElement('div');
    wrap.className = 'runner ' + (cls || '') + (isPickup() ? ' is-pickup hand-' + R.hand : '');
    // Which hand is working has to be unmissable on EVERY screen — mixing the
    // hands up mid-session silently corrupts both series for that day, and
    // there is no way to tell afterwards which number belonged to which hand.
    const handTag = isPickup()
      ? `<span class="r-hand">${HAND_LABEL[R.hand]}</span>` : '';
    wrap.innerHTML =
      `<div class="r-head"><span>${R.plan.blockName || ''} · ${R.plan.role}</span>` +
      handTag +
      `<button id="r-quit">Quit</button></div>` +
      `<div class="r-body">${inner.body}</div>` +
      `<div class="r-foot">${inner.foot}</div>`;
    host().innerHTML = '';
    host().appendChild(wrap);
    const q = document.getElementById('r-quit');
    if (q) q.addEventListener('click', () => Runner.abort());
    return wrap;
  }

  function renderRunner() {
    clearTick();
    if (R.phase === 'READINESS') return isPickup() ? renderPickupPrep() : renderReadiness();
    if (R.phase === 'PREP') return renderPrep();
    if (R.phase === 'HANG') return renderHang();
    if (R.phase === 'REP_LOG') return renderRepLog();
    if (R.phase === 'INTRA') return renderIntraRest();
    if (R.phase === 'LOG_SET') return renderLogSet();
    if (R.phase === 'REST') return renderRest();
    if (R.phase === 'END') return renderEnd();
  }

  // ---- pickup pre-session capture ---------------------------------------
  // Readiness and recent climbing load are recorded BEFORE the top set, on
  // purpose. taxing / feltStrong / nextDayFeel are all retrospective, and a
  // rating given after you find out how strong you were is contaminated by
  // knowing the answer. Without these two, a dip in the top-set trend is
  // uninterpretable later — you can't tell program fatigue from a hard
  // Tuesday on the wall, and neither can be reconstructed from memory.
  function renderPickupPrep() {
    persistR();
    const wrap = shell('', { body: '', foot: '' });
    const rb = wrap.querySelector('.r-body');
    rb.style.justifyContent = 'flex-start'; rb.style.paddingTop = '10px'; rb.innerHTML = '';
    const box = document.createElement('div'); box.style.width = '100%'; box.style.textAlign = 'left';
    box.innerHTML = '<div class="phase" style="text-align:center">Before you start</div>';

    const readyR = App.rating(5, R.prep.readiness);
    const f1 = document.createElement('div'); f1.className = 'field';
    f1.innerHTML = '<label>Readiness (1 = wrecked, 5 = fresh)</label>';
    f1.appendChild(readyR);

    const climbWrap = document.createElement('div'); climbWrap.className = 'field';
    climbWrap.innerHTML = '<label>Climbing in the last 48h</label>';
    const climbRow = document.createElement('div'); climbRow.className = 'seg';
    let climb = R.prep.climbing48h || null;
    [['none', 'None'], ['easy', 'Easy'], ['hard', 'Hard']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.textContent = label; if (climb === v) b.className = 'sel';
      b.addEventListener('click', () => {
        climb = v;
        climbRow.querySelectorAll('button').forEach(x => x.className = '');
        b.className = 'sel';
      });
      climbRow.appendChild(b);
    });
    climbWrap.appendChild(climbRow);

    const note = document.createElement('p'); note.className = 'muted'; note.style.fontSize = '12.5px';
    note.textContent = R.plan.edgeMm
      ? `${R.plan.edgeMm}mm · ${R.plan.grip === 'HalfCrimp' ? 'half crimp' : R.plan.grip || ''} · ${R.hangSeconds}s holds · ${HAND_LABEL[R.firstHand]} hand first. Same setup every session — that is what makes the numbers comparable.`
      : 'Same setup every session — that is what makes the numbers comparable.';

    box.appendChild(f1); box.appendChild(climbWrap); box.appendChild(note);
    rb.appendChild(box);

    const rf = wrap.querySelector('.r-foot'); rf.innerHTML = '';
    const go = document.createElement('button'); go.className = 'btn'; go.textContent = 'Start warm-up';
    go.addEventListener('click', () => {
      R.prep.readiness = readyR.getValue();
      R.prep.climbing48h = climb;
      R.phase = 'PREP'; renderPrep();
    });
    rf.appendChild(go);
  }

  // ---- readiness check (autoregulation from the Reference sheet) --------
  function renderReadiness() {
    persistR();
    const rpeSt = App.stepper({ min: 5, max: 10, step: 0.5, value: 6, fmt: v => '@' + v });
    const wrap = shell('', { body: '', foot: '' });
    const rb = wrap.querySelector('.r-body'); rb.style.justifyContent = 'flex-start'; rb.style.paddingTop = '10px'; rb.innerHTML = '';
    const box = document.createElement('div'); box.style.width = '100%';
    box.innerHTML = `<div class="phase" style="text-align:center">Readiness check</div>
      <p class="muted center" style="margin-top:10px">Do one easy warmup hang at ${R.warmupKg != null ? '~' + R.warmupKg + ' kg (≈70% of your 5s max)' : '≈70% of your 5s max'} for 5s, then rate how hard it felt.</p>`;
    const guide = document.createElement('p'); guide.className = 'muted center'; guide.style.fontSize = '12.5px';
    guide.textContent = 'Normal is @5–6. @7+ → loads drop and no fatigue extensions today. @8+ or any joint tenderness → the rule says skip today.';
    const f = document.createElement('div'); f.className = 'field'; f.innerHTML = '<label>Warmup hang RPE</label>'; f.appendChild(rpeSt);
    box.appendChild(guide); box.appendChild(f); rb.appendChild(box);
    const rf = wrap.querySelector('.r-foot'); rf.innerHTML = '';
    const go = document.createElement('button'); go.className = 'btn'; go.textContent = 'Apply & continue';
    go.addEventListener('click', () => applyReadiness(rpeSt.getValue()));
    const skip = document.createElement('button'); skip.className = 'btn secondary'; skip.textContent = 'Skip check';
    skip.addEventListener('click', () => { R.phase = 'PREP'; renderPrep(); });
    rf.appendChild(go); rf.appendChild(skip);
  }

  function setReadiness(rpe, factor) {
    const dropPct = Math.round((1 - factor) * 100);
    R.readiness = { rpe, factor, dropPct };
    if (factor < 1) {
      if (R.curLoad != null) R.curLoad = Calc.roundTo05(R.curLoad * factor);
      R.skipExtensions = true;
      if (R.plan.protocol === 'topSetPlusBackoffs') R.totalEfforts = Math.max(1, R.totalEfforts - 1);
      R.readiness.note = `Readiness @${rpe} — loads dropped ~${dropPct}% and fatigue extensions off today. Stop at any joint discomfort.`;
    } else {
      R.readiness.note = `Readiness @${rpe} — good to go.`;
    }
  }

  function applyReadiness(rpe) {
    if (rpe >= 8) {
      return App.confirm(
        `Warmup felt @${rpe}. With even the warmup that hard, joint load is high — the autoregulation rule says skip today to protect your tendons.`,
        'Skip today', () => cancelSession(),
        () => { setReadiness(rpe, 0.90); R.phase = 'PREP'; renderPrep(); },
        'Train lighter anyway');
    }
    setReadiness(rpe, rpe >= 7 ? 0.93 : 1);
    R.phase = 'PREP'; renderPrep();
  }

  function cancelSession() {
    clearTick(); releaseWakeLock(); clearPending(); host().innerHTML = ''; R = null; App.closeSheet(); App.render();
  }

  function renderPrep() {
    persistR();
    if (isPickup()) return renderPickupSetPrep();
    const p = R.plan;
    const lines = [];
    if (p.duration) lines.push(`${p.duration}s hang`);
    // The edge is on screen for the same reason the hand is on every pickup
    // screen: it decides which series this session lands in, and it can't be
    // recovered afterwards from the numbers alone.
    if (p.edgeMm) lines.push(`${p.edgeMm}mm`);
    if (p.rpe) lines.push(`@${p.rpe}`);
    if (p.anchor != null) lines.push(`anchor ~${p.anchor} kg`);
    lines.push(effortLabel());
    const wrap = shell('', {
      body: `<div class="phase">Get ready</div>
             <div style="font-size:22px;margin:14px 0;font-weight:700">${p.role}</div>
             <div style="color:#9a9aa8">${lines.join(' · ')}</div>
             ${p.protocol === 'fixedVolume' ? '<div style="color:#f7b955;margin-top:14px">Fixed sets — no extensions. RPE creep: if @8.5+ by set 3, drop load 5%.</div>' : ''}
             ${p.protocol === 'topSetPlusBackoffs' ? '<div style="color:#f7b955;margin-top:14px">Fatigue stop rule is active for back-offs.</div>' : ''}
             ${p.protocol === 'maxSingles' ? '<div style="color:#ff6b6b;margin-top:14px">Max singles — full rest, no back-offs.</div>' : ''}
             ${R.readiness && R.readiness.note ? '<div style="color:' + (R.readiness.factor < 1 ? '#f7b955' : '#4ecb71') + ';margin-top:14px">' + R.readiness.note + '</div>' : ''}`,
      foot: `<button class="btn" id="r-ready">Ready — start countdown</button>
             <p class="muted center">Keep the screen on. Audio cues will guide you.</p>`
    });
    document.getElementById('r-ready').addEventListener('click', () => { unlockAudio(); startCountdownToHang(); });
  }

  // Prep screen for one pickup set (or one ramp step). Deliberately repeats
  // the hand and the target load every single time: this screen appears 16+
  // times a session and it is the only thing standing between an alternating
  // protocol and a mislabelled data series.
  function renderPickupSetPrep() {
    const p = R.plan;
    const target = pickupTargetLoad();
    const ramping = R.stage === 'ramp';
    const reps = ramping ? 1 : R.repsPerSet;
    const lines = [`${reps} × ${R.hangSeconds}s`];
    if (target != null) lines.push(`~${target} kg`);
    if (!ramping && R.effort > 0) lines.push(`${Math.round((p.backoffPctOfTop || 0.88) * 100)}% of today's top`);
    if (ramping) lines.push(`${Math.round(((p.rampPcts || [])[R.rampIdx] || 0) * 100)}% of last top set`);

    const guidance = ramping
      ? 'Warm-up rep — prime, do not fatigue.'
      : R.effort === 0
        ? 'Find today\'s top set. RIR 1–2 against TECHNICAL failure — the first rep where the position would break, not where you physically couldn\'t hold it.'
        : 'Fixed reps. Do not chase — the back-off load is already set by today\'s top set.';

    const wrap = shell('', {
      body: `<div class="phase">Get ready</div>
             <div style="font-size:26px;margin:12px 0 4px;font-weight:800">${HAND_LABEL[R.hand]} hand</div>
             <div style="color:#9a9aa8">${lines.join(' · ')}</div>
             <div style="color:#9a9aa8;margin-top:6px">${effortLabel()}</div>
             <div style="color:#f7b955;margin-top:14px">${guidance}</div>
             <div style="color:#9a9aa8;margin-top:10px;font-size:13px">Ramp to the weight over ~2s. No snatch.</div>`,
      foot: `<button class="btn" id="r-ready">Ready — start countdown</button>
             <p class="muted center">Keep the screen on. Audio cues will guide you.</p>`
    });
    document.getElementById('r-ready').addEventListener('click', () => { unlockAudio(); startCountdownToHang(); });
  }

  function startCountdownToHang() {
    R.phase = 'COUNT'; let n = 3;
    const wrap = shell('', { body: `<div class="phase">Starting</div><div class="countdown" id="r-cd">${n}</div>`, foot: '' });
    say('3'); tone(660, 150);
    tickHandle = setInterval(() => {
      n--;
      const cd = document.getElementById('r-cd');
      if (n > 0) { if (cd) cd.textContent = n; say(String(n)); tone(660, 150); }
      else { clearTick(); say(isPickup() ? 'Lift' : 'Hang!'); enterHang(); }
    }, 1000);
  }

  function enterHang() {
    R.phase = 'HANG';
    R.hangSeconds = R.plan.protocol === 'test' ? (R.plan.testDurations[R.effort])
      : (R.plan.duration || (isPickup() ? 3 : 5));
    R.timeLeft = R.hangSeconds;
    bell();
    const verb = isPickup() ? 'HOLD' : 'HANG';
    const wrap = shell('is-hang', {
      body: `<div class="phase">${effortLabel()} — ${verb}</div><div class="countdown" id="r-cd">${R.timeLeft}</div>`,
      foot: `<button class="btn secondary" id="r-stop">Stop early</button>`
    });
    document.getElementById('r-stop').addEventListener('click', () => { clearTick(); afterHold(true); });
    tickHandle = setInterval(() => {
      R.timeLeft--;
      const cd = document.getElementById('r-cd');
      if (R.timeLeft > 0) { if (cd) cd.textContent = R.timeLeft; if (R.timeLeft <= 3) tone(700, 120); }
      else { clearTick(); bell(); say('Down'); afterHold(false); }
    }, 1000);
  }

  // stoppedEarly: the hold was cut short by hand. For a pickup that is by
  // definition a failed rep, so the outcome screen opens pre-answered.
  function afterHold(stoppedEarly) {
    if (!isPickup()) return toLogSet();
    if (R.stage === 'ramp') return advance();     // warm-up reps are never logged
    R.phase = 'REP_LOG';
    renderRepLog(stoppedEarly);
  }

  function toLogSet() { R.phase = 'LOG_SET'; renderLogSet(); }

  // ---- per-rep outcome ---------------------------------------------------
  // The position gate. A rep held for the full 3s in a half crimp that rolled
  // open is not the same rep as a clean one — the load is real but it doesn't
  // mean what a clean rep means. Short holds don't self-police position the
  // way an 8s hold does, so this has to be recorded deliberately. Downstream
  // it does two things: a degraded top set can't advance the load however
  // good the RIR felt, and it inflates that session's observation noise in
  // the filter instead of dragging the trend around.
  function renderRepLog(stoppedEarly) {
    persistR();
    const wrap = shell('', { body: '', foot: '' });
    const rb = wrap.querySelector('.r-body');
    rb.style.justifyContent = 'flex-start'; rb.style.paddingTop = '10px'; rb.innerHTML = '';
    const box = document.createElement('div'); box.style.width = '100%';
    box.innerHTML =
      `<div class="phase" style="text-align:center">${HAND_LABEL[R.hand]} · rep ${R.rep + 1}/${R.repsPerSet}</div>
       <p class="muted center" style="margin-top:10px">How was the position?</p>`;
    rb.appendChild(box);

    const opts = [
      ['clean', 'Clean', 'Position held. Fingers and wrist where they started.'],
      ['degraded', 'Degraded', 'Held the time, but the fingers rolled open or the wrist collapsed.'],
      ['failed', 'Failed', "Couldn't hold it for the full time."]
    ];
    opts.forEach(([v, label, help]) => {
      const b = document.createElement('button');
      b.className = 'btn' + (v === 'clean' ? '' : ' secondary');
      b.style.marginTop = '8px';
      b.innerHTML = `<span style="display:block;font-weight:800">${label}</span>` +
                    `<span style="display:block;font-size:11.5px;opacity:0.75;font-weight:500">${help}</span>`;
      b.addEventListener('click', () => recordRep(v));
      box.appendChild(b);
    });
    if (stoppedEarly) {
      box.appendChild(el2('p', 'muted center', 'You stopped this one early — that is a failed rep unless you set it down deliberately.'));
    }
  }

  function el2(tag, cls, text) {
    const n = document.createElement(tag); n.className = cls || ''; n.textContent = text || ''; return n;
  }

  function recordRep(outcome) {
    R.repOutcomes.push(outcome);
    R.rep++;
    persistR();
    // A failed rep ends the set — there is nothing to learn from grinding out
    // the remainder at a load you just demonstrated you can't hold in position.
    if (outcome === 'failed' || R.rep >= R.repsPerSet) { R.phase = 'LOG_SET'; return renderLogSet(); }
    R.phase = 'INTRA'; renderIntraRest();
  }

  // Intra-rep rest inside a cluster set. Short by design: long enough to
  // repeat the rep at the same load, short enough that the set still
  // accumulates fatigue as one unit.
  function renderIntraRest() {
    persistR();
    R.timeLeft = R.plan.intraRestSeconds || 20;
    const wrap = shell('is-rest', {
      body: `<div class="phase">${HAND_LABEL[R.hand]} · next rep ${R.rep + 1}/${R.repsPerSet}</div>` +
            `<div class="countdown rest" id="r-cd">${R.timeLeft}</div>`,
      foot: `<button class="btn" id="r-skip">Ready now</button>`
    });
    document.getElementById('r-skip').addEventListener('click', () => { clearTick(); startCountdownToHang(); });
    tickHandle = setInterval(() => {
      R.timeLeft--;
      const cd = document.getElementById('r-cd');
      if (R.timeLeft > 0) { if (cd) cd.textContent = R.timeLeft; if (R.timeLeft <= 3) tone(700, 120); }
      else { clearTick(); bell(); startCountdownToHang(); }
    }, 1000);
  }

  // Log one pickup set. RIR rather than RPE because reps are discrete and
  // countable, which is the same reason RIR works for barbells and "seconds
  // in reserve" doesn't work for a plank. Stored as RPE = 10 − RIR so the
  // whole existing analytics stack keeps reading one scale.
  function renderPickupLogSet() {
    const target = pickupTargetLoad();
    const startLoad = R.curLoadBy[R.hand] != null ? R.curLoadBy[R.hand]
      : (target != null ? target : 40);
    const loadSt = App.stepper({ min: 0, max: 120, step: 0.5, value: startLoad,
      fmt: v => v + ' kg', onChange: v => R.curLoadBy[R.hand] = v });
    // RIR 0-4 in half steps. 0 = the next rep would have broken position.
    const startRir = Math.min(4, Math.max(0, 10 - (R.curRPE != null ? R.curRPE : 8.5)));
    const rirSt = App.stepper({ min: 0, max: 4, step: 0.5, value: startRir,
      fmt: v => v + ' RIR', onChange: v => R.curRPE = 10 - v });

    const body = document.createElement('div');
    body.innerHTML = `<div class="phase">${HAND_LABEL[R.hand]} · ${effortLabel().split(' · ')[0]} — log it</div>`;
    const grid = document.createElement('div'); grid.className = 'grid2';
    const f1 = document.createElement('div'); f1.className = 'field'; f1.innerHTML = '<label>Load</label>'; f1.appendChild(loadSt);
    const f2 = document.createElement('div'); f2.className = 'field'; f2.innerHTML = '<label>Reps in reserve</label>'; f2.appendChild(rirSt);
    grid.appendChild(f1); grid.appendChild(f2); body.appendChild(grid);

    const outs = R.repOutcomes;
    const bad = outs.filter(o => o !== 'clean').length;
    body.appendChild(el2('p', 'muted center',
      `${outs.length} rep${outs.length === 1 ? '' : 's'} · ` +
      (bad ? outs.join(', ') : 'all clean')));

    if (R.effort === 0) {
      const note = document.createElement('div'); note.className = 'callout';
      note.textContent = bad
        ? 'Position broke on this top set — it is logged, but it will not advance next week\'s load whatever the RIR says. The gate overrides the number.'
        : 'RIR against TECHNICAL failure: the rep where the position would break, not where you physically could not hold on. Back-offs follow at ' +
          Math.round((R.plan.backoffPctOfTop || 0.88) * 100) + '% of this.';
      body.appendChild(note);
    }
    R._steppers = { loadSt, rpeSt: { getValue: () => 10 - rirSt.getValue() } };

    const wrap = shell('', { body: '', foot: '' });
    const rb = wrap.querySelector('.r-body'); rb.innerHTML = ''; rb.appendChild(body);
    const rf = wrap.querySelector('.r-foot'); rf.innerHTML = '';
    const logged = document.createElement('button'); logged.className = 'btn'; logged.textContent = 'Logged';
    logged.addEventListener('click', () => recordEffort());
    const loggedDone = document.createElement('button'); loggedDone.className = 'btn secondary'; loggedDone.textContent = 'Log & finish';
    loggedDone.addEventListener('click', () => recordEffort({ finishAfter: true }));
    rf.appendChild(logged); rf.appendChild(loggedDone);
  }

  function renderLogSet() {
    persistR();
    if (isPickup()) return renderPickupLogSet();
    const p = R.plan;
    const isOI = p.protocol === 'oi';
    const body = document.createElement('div');
    body.innerHTML = `<div class="phase">${effortLabel()} — log it</div>`;
    const foot = document.createElement('div'); foot.className = 'r-foot';

    if (!isOI) {
      const loadSt = App.stepper({ min: 0, max: 80, step: 0.5, value: R.curLoad != null ? R.curLoad : 25, fmt: v => v + ' kg', onChange: v => R.curLoad = v });
      const rpeSt = App.stepper({ min: 5, max: 10, step: 0.5, value: R.curRPE, fmt: v => '@' + v, onChange: v => R.curRPE = v });
      const grid = document.createElement('div'); grid.className = 'grid2';
      const f1 = document.createElement('div'); f1.className = 'field'; f1.innerHTML = '<label>Load</label>'; f1.appendChild(loadSt);
      const f2 = document.createElement('div'); f2.className = 'field'; f2.innerHTML = '<label>RPE</label>'; f2.appendChild(rpeSt);
      grid.appendChild(f1); grid.appendChild(f2); body.appendChild(grid);
      const e1 = document.createElement('p'); e1.className = 'muted center';
      const upd = () => { const v = Calc.e1rm(loadSt.getValue(), rpeSt.getValue()); e1.textContent = v != null ? 'E1RM ' + v + ' kg' : ''; };
      loadSt.onChangeExtra = upd;
      body.appendChild(e1); upd();
      // hook live e1rm to steppers
      f1.addEventListener('click', upd); f2.addEventListener('click', upd);

      // protocol-specific guidance
      if (p.protocol === 'topSetPlusBackoffs' && R.effort === 0) {
        const note = document.createElement('div'); note.className = 'callout';
        note.textContent = `Back-offs from here ~${p.backoffAnchor != null ? p.backoffAnchor : '?'} kg (@7–8). Halt back-offs if: (1) can't hold full 5s, (2) load drop >5% to stay @8, (3) grip breaks before second 4, (4) any joint discomfort.`;
        body.appendChild(note);
      }
      R._steppers = { loadSt, rpeSt };
    } else {
      body.innerHTML += '<p class="muted center">OI effort done — log how it felt at the end.</p>';
    }

    const logged = document.createElement('button'); logged.className = 'btn'; logged.textContent = 'Logged';
    logged.addEventListener('click', () => recordEffort());
    foot.appendChild(logged);

    // Early finish: bank this set and go straight to save — for short sessions
    // where you don't want to (or can't) complete the remaining back-off sets.
    const loggedDone = document.createElement('button'); loggedDone.className = 'btn secondary'; loggedDone.textContent = 'Log & finish';
    loggedDone.addEventListener('click', () => recordEffort({ finishAfter: true }));

    const wrap = shell('', { body: '', foot: '' });
    const rb = wrap.querySelector('.r-body'); rb.innerHTML = ''; rb.appendChild(body);
    const rf = wrap.querySelector('.r-foot'); rf.innerHTML = ''; rf.appendChild(logged); rf.appendChild(loggedDone);
  }

  function recordEffort(opts) {
    opts = opts || {};
    const p = R.plan;
    if (isPickup()) {
      const load = R._steppers.loadSt.getValue();
      const rpe = R._steppers.rpeSt.getValue();
      R.handSets[R.hand].push({
        load, rpe, reps: R.repOutcomes.length, outcomes: R.repOutcomes.slice()
      });
      R.curLoadBy[R.hand] = load;
      if (R.effort === 0) R.topBy[R.hand] = load;   // back-offs key off TODAY's top
      R.sets.push({ load, rpe, hand: R.hand });     // flat list feeds the recovery summary
      persistR();
      if (opts.finishAfter) { R.phase = 'END'; return renderEnd(); }
      return advance();
    }
    if (R._steppers) {
      const loggedLoad = R._steppers.loadSt.getValue();
      const loggedRPE = R._steppers.rpeSt.getValue();
      R.sets.push({ load: loggedLoad, rpe: loggedRPE });
      persistR(); // bank the set immediately — survives an app kill mid-prompt

      // Early finish: this set is banked — skip the autoregulation prompts and
      // go straight to the save screen so a short session still logs cleanly.
      if (opts.finishAfter) { R.phase = 'END'; return renderEnd(); }

      // Volume session RPE creep rule: if @8.5+ by set 3, drop load 5% and finish
      if (p.protocol === 'fixedVolume' && R.effort === 2 && loggedRPE >= 8.5) {
        const nextLoad = R.curLoad != null ? Calc.roundTo05(R.curLoad * 0.95) : null;
        const msg = nextLoad != null
          ? `RPE reached @${loggedRPE} on set 3. The RPE creep rule says drop load 5% (~${nextLoad} kg) for remaining sets. Drop load?`
          : `RPE reached @${loggedRPE} on set 3. The RPE creep rule says drop load 5% for remaining sets. Drop load?`;
        return App.confirm(
          msg,
          'Drop load',
          () => { if (nextLoad != null) R.curLoad = nextLoad; advance(); },
          () => advance()
        );
      }

      // fatigue-stop suggestion for back-offs: above @8 -> offer to stop, else continue.
      if (p.protocol === 'topSetPlusBackoffs' && R.effort >= 1 && loggedRPE > 8) {
        return App.confirm(
          'That back-off was above @8 — the fatigue-stop rule says stop here. End back-offs now?',
          'End back-offs',
          () => { R.phase = 'END'; renderEnd(); },          // confirm = stop
          () => advance()                                   // cancel = keep going
        );
      }
    } else {
      R.sets.push({ load: null, rpe: null });
      persistR();
      if (opts.finishAfter) { R.phase = 'END'; return renderEnd(); }
      if (p.protocol === 'oi' && p.sets === '3-5') {
        if (R.effort === 2 || R.effort === 3) {
          return App.confirm(
            `You have completed ${R.effort + 1} sets. The target is 3–5 sets. Do you want to perform another set?`,
            'Do another set',
            () => advance(),
            () => { R.phase = 'END'; renderEnd(); },
            'Finish session'
          );
        }
      }
    }
    advance();
  }

  function advance() {
    if (isPickup()) return advancePickup();
    R.effort++;
    // fixed-volume hard cap
    if (R.plan.protocol === 'fixedVolume' && R.effort >= R.totalEfforts) { R.phase = 'END'; return showVolumeCapThenEnd(); }
    if (R.effort >= R.totalEfforts) { R.phase = 'END'; return renderEnd(); }
    R.phase = 'REST'; renderRest();
  }

  // Alternation: BOTH hands complete the current step before the step index
  // moves on. First hand -> switch -> second hand -> switch + advance step.
  // Each hand therefore rests for the other hand's set plus both switch
  // intervals, which is where the ~3 min per hand comes from.
  function advancePickup() {
    R.rep = 0; R.repOutcomes = [];
    if (R.hand === R.firstHand) {
      R.hand = OTHER[R.hand];
      R.phase = 'REST'; return renderRest();
    }
    R.hand = R.firstHand;
    if (R.stage === 'ramp') {
      R.rampIdx++;
      if (R.rampIdx >= (R.plan.rampPcts || []).length) { R.stage = 'work'; R.effort = 0; }
      R.phase = 'REST'; return renderRest();
    }
    R.effort++;
    if (R.effort >= R.totalEfforts) { R.phase = 'END'; return renderEnd(); }
    R.phase = 'REST'; renderRest();
  }

  function showVolumeCapThenEnd() {
    const wrap = shell('', {
      body: `<div class="done-stop">DONE — do not extend.</div>
             <p class="muted" style="margin-top:14px">${R.totalEfforts} fixed sets complete. Adding sets is disabled by design (tendon management).</p>`,
      foot: `<button class="btn" id="r-toend">Finish session</button>`
    });
    say('Done. Do not extend.'); bell();
    document.getElementById('r-toend').addEventListener('click', () => renderEnd());
  }

  function renderRest() {
    persistR();
    // Ramp steps need less recovery than working sets — they are priming, and
    // stretching the warm-up out is how a 25-minute session becomes 40.
    R.timeLeft = (isPickup() && R.stage === 'ramp') ? 60 : R.restDefault;
    let pinged = false;
    const nextLabel = isPickup()
      ? `${HAND_LABEL[R.hand]} hand — ${effortLabel()}`
      : effortLabel();
    const wrap = shell('is-rest', {
      body: `<div class="phase">Rest · next: ${nextLabel}</div><div class="countdown rest" id="r-cd">${fmtClock(R.timeLeft)}</div>`,
      foot: `<button class="btn" id="r-skip">Skip rest — ready now</button>` +
            `<button class="btn secondary" id="r-finish">Finish &amp; log now</button>`
    });
    document.getElementById('r-skip').addEventListener('click', () => { clearTick(); startCountdownToHang(); });
    // End here and save the sets already completed (short-session escape hatch).
    document.getElementById('r-finish').addEventListener('click', () => { clearTick(); R.phase = 'END'; renderEnd(); });
    tickHandle = setInterval(() => {
      R.timeLeft--;
      const cd = document.getElementById('r-cd');
      if (cd) cd.textContent = fmtClock(Math.max(0, R.timeLeft));
      if (!pinged && R.timeLeft === 30) { pinged = true; tone(660, 200); say('30 seconds'); }
      if (R.timeLeft <= 0) { clearTick(); say('Rest over'); bell(); startCountdownToHang(); }
    }, 1000);
  }
  function fmtClock(s) { const m = Math.floor(s / 60), ss = s % 60; return m + ':' + String(ss).padStart(2, '0'); }

  function renderEnd() {
    clearTick();
    R.phase = 'END'; persistR();
    const tax = App.rating(5, null);
    const felt = App.rating(10, null);
    const notes = document.createElement('textarea'); notes.placeholder = 'Notes (optional)';
    const wrap = shell('', { body: '', foot: '' });
    const rb = wrap.querySelector('.r-body'); rb.style.justifyContent = 'flex-start'; rb.style.paddingTop = '10px'; rb.innerHTML = '';
    const box = document.createElement('div'); box.style.width = '100%'; box.style.textAlign = 'left';
    const summary = isPickup()
      ? pickupSummaryLine()
      : (R.sets.filter(s => s.load != null).map(s => s.load + 'kg@' + s.rpe).join('  ') || R.sets.length + ' efforts');
    box.innerHTML = `<div class="phase" style="text-align:center">Session complete</div>
      <p class="muted center">${summary}</p>`;
    const f1 = document.createElement('div'); f1.className = 'field'; f1.innerHTML = '<label>Session taxing (1–5)</label>'; f1.appendChild(tax);
    const f2 = document.createElement('div'); f2.className = 'field'; f2.innerHTML = '<label>Felt strong (1–10)</label>'; f2.appendChild(felt);
    const f3 = document.createElement('div'); f3.className = 'field'; f3.innerHTML = '<label>Notes</label>'; f3.appendChild(notes);
    box.appendChild(f1); box.appendChild(f2); box.appendChild(f3);
    rb.appendChild(box);
    const save = document.createElement('button'); save.className = 'btn'; save.textContent = 'Save & close';
    save.addEventListener('click', async () => {
      const top = R.sets.find(s => s.load != null) || {};
      // Log all completed sets (including top set for Heavy sessions)
      const setsCount = R.sets.length;
      const pickup = isPickup();
      const payload = pickup
        ? {
            modality: 'pickup',
            hands: { L: handPayload('L'), R: handPayload('R') },
            firstHand: R.firstHand,
            // Recorded before the top set; see renderPickupPrep.
            readiness: R.prep ? R.prep.readiness : null,
            climbing48h: R.prep ? R.prep.climbing48h : null,
            edgeMm: R.prep ? R.prep.edgeMm : null,
            sets: setsCount, taxing: tax.getValue(), felt: felt.getValue(),
            notes: notes.value, date: R.date || null
          }
        : {
            load: top.load != null ? top.load : null, rpe: top.rpe != null ? top.rpe : null,
            // Edge comes off the plan, which the Today card already resolved
            // (including a same-day override) before the runner started.
            edgeMm: R.plan.edgeMm != null ? R.plan.edgeMm : null,
            sets: setsCount, taxing: tax.getValue(), felt: felt.getValue(), notes: notes.value,
            // Full per-effort capture (top set first, then back-offs in order) —
            // until 2026-07-10 this was collected by the steppers and discarded here.
            setsDetail: R.sets.map(s => ({ load: s.load, rpe: s.rpe })),
            // Recovered sessions keep the day they were actually trained.
            date: R.date || null
          };
      releaseWakeLock();
      host().innerHTML = '';
      await App.logSession(R.plan, payload);
      clearPending();
      R = null;
    });
    const rf = wrap.querySelector('.r-foot'); rf.innerHTML = ''; rf.appendChild(save);
  }

  Runner.abort = function () {
    App.confirm('Quit this session? Nothing will be logged.', 'Quit', () => {
      clearTick(); releaseWakeLock(); clearPending(); host().innerHTML = ''; R = null; App.closeSheet(); App.render();
    });
  };

  root.Runner = Runner;
})(typeof self !== 'undefined' ? self : this);

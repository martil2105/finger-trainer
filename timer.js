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
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  function releaseWakeLock() { try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {} }
  document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') await acquireWakeLock();
  });

  const Runner = {};
  let R = null; // current session state

  Runner.start = async function (plan) {
    unlockAudio();
    await acquireWakeLock();
    const restDefault = plan.protocol === 'maxSingles'
      ? (await DB.getMeta('restPeak') || 270)
      : (await DB.getMeta('restBackoff') || 180);

    // For Heavy topSetPlusBackoffs: total efforts = 1 top set + N back-offs.
    // For maxSingles: N singles. For fixedVolume: N sets (hard cap). Deload: 3 sets. Test: per duration.
    let totalEfforts, label;
    if (plan.protocol === 'topSetPlusBackoffs') { totalEfforts = 1 + (plan.sets || 0); }
    else if (plan.protocol === 'test') { totalEfforts = (plan.testDurations || [plan.duration]).length; }
    else { totalEfforts = plan.sets || 1; }

    R = {
      plan, restDefault, phase: 'PREP', effort: 0, totalEfforts,
      hangSeconds: plan.duration || 5,
      sets: [], // logged efforts {load,rpe}
      curLoad: plan.anchor != null ? plan.anchor : (plan.role === 'OIprimer' ? null : 25),
      curRPE: typeof plan.rpe === 'number' ? plan.rpe : (plan.rpe ? Calc.parseRPE(plan.rpe) : 9),
      timeLeft: 0, stopped: false
    };
    renderRunner();
  };

  function host() { return document.getElementById('modal-host'); }
  function clearTick() { if (tickHandle) { clearInterval(tickHandle); tickHandle = null; } }

  function effortLabel() {
    const p = R.plan;
    if (p.protocol === 'topSetPlusBackoffs') return R.effort === 0 ? 'Top set' : `Back-off ${R.effort}/${p.sets}`;
    if (p.protocol === 'maxSingles') return `Single ${R.effort + 1}/${R.totalEfforts}`;
    if (p.protocol === 'fixedVolume') return `Set ${R.effort + 1}/${R.totalEfforts}`;
    if (p.protocol === 'test') return `Test ${R.plan.testDurations[R.effort]}s`;
    if (p.protocol === 'deload') return `Deload set ${R.effort + 1}/3`;
    return `Effort ${R.effort + 1}`;
  }

  function shell(cls, inner) {
    const wrap = document.createElement('div');
    wrap.className = 'runner ' + (cls || '');
    wrap.innerHTML =
      `<div class="r-head"><span>${R.plan.blockName || ''} · ${R.plan.role}</span>` +
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
    if (R.phase === 'PREP') return renderPrep();
    if (R.phase === 'HANG') return renderHang();
    if (R.phase === 'LOG_SET') return renderLogSet();
    if (R.phase === 'REST') return renderRest();
    if (R.phase === 'END') return renderEnd();
  }

  function renderPrep() {
    const p = R.plan;
    const lines = [];
    if (p.duration) lines.push(`${p.duration}s hang`);
    if (p.rpe) lines.push(`@${p.rpe}`);
    if (p.anchor != null) lines.push(`anchor ~${p.anchor} kg`);
    lines.push(effortLabel());
    const wrap = shell('', {
      body: `<div class="phase">Get ready</div>
             <div style="font-size:22px;margin:14px 0;font-weight:700">${p.role}</div>
             <div style="color:#9a9aa8">${lines.join(' · ')}</div>
             ${p.protocol === 'fixedVolume' ? '<div style="color:#f7b955;margin-top:14px">Fixed sets — no extensions. RPE creep: if @8.5+ by set 3, drop load 5%.</div>' : ''}
             ${p.protocol === 'topSetPlusBackoffs' ? '<div style="color:#f7b955;margin-top:14px">Fatigue stop rule is active for back-offs.</div>' : ''}
             ${p.protocol === 'maxSingles' ? '<div style="color:#ff6b6b;margin-top:14px">Max singles — full rest, no back-offs.</div>' : ''}`,
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
      else { clearTick(); say('Hang!'); enterHang(); }
    }, 1000);
  }

  function enterHang() {
    R.phase = 'HANG';
    R.hangSeconds = R.plan.protocol === 'test' ? (R.plan.testDurations[R.effort]) : (R.plan.duration || 5);
    R.timeLeft = R.hangSeconds;
    bell();
    const wrap = shell('is-hang', {
      body: `<div class="phase">${effortLabel()} — HANG</div><div class="countdown" id="r-cd">${R.timeLeft}</div>`,
      foot: `<button class="btn secondary" id="r-stop">Stop early</button>`
    });
    document.getElementById('r-stop').addEventListener('click', () => { clearTick(); toLogSet(); });
    tickHandle = setInterval(() => {
      R.timeLeft--;
      const cd = document.getElementById('r-cd');
      if (R.timeLeft > 0) { if (cd) cd.textContent = R.timeLeft; if (R.timeLeft <= 3) tone(700, 120); }
      else { clearTick(); bell(); say('Done'); toLogSet(); }
    }, 1000);
  }

  function toLogSet() { R.phase = 'LOG_SET'; renderLogSet(); }

  function renderLogSet() {
    const p = R.plan;
    const isOI = p.protocol === 'oi';
    const body = document.createElement('div');
    body.innerHTML = `<div class="phase">${effortLabel()} — log it</div>`;
    const foot = document.createElement('div'); foot.className = 'r-foot';

    if (!isOI) {
      const loadSt = App.stepper({ min: 0, max: 80, step: 0.5, value: R.curLoad != null ? R.curLoad : 25, fmt: v => v + ' kg', onChange: v => R.curLoad = v });
      const rpeSt = App.stepper({ min: 6, max: 10, step: 0.25, value: R.curRPE, fmt: v => '@' + v, onChange: v => R.curRPE = v });
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

    const wrap = shell('', { body: '', foot: '' });
    const rb = wrap.querySelector('.r-body'); rb.innerHTML = ''; rb.appendChild(body);
    const rf = wrap.querySelector('.r-foot'); rf.innerHTML = ''; rf.appendChild(logged);
  }

  function recordEffort() {
    const p = R.plan;
    if (R._steppers) {
      const loggedLoad = R._steppers.loadSt.getValue();
      const loggedRPE = R._steppers.rpeSt.getValue();
      R.sets.push({ load: loggedLoad, rpe: loggedRPE });

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
    }
    advance();
  }

  function advance() {
    R.effort++;
    // fixed-volume hard cap
    if (R.plan.protocol === 'fixedVolume' && R.effort >= R.totalEfforts) { R.phase = 'END'; return showVolumeCapThenEnd(); }
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
    R.timeLeft = R.restDefault;
    let pinged = false;
    const wrap = shell('is-rest', {
      body: `<div class="phase">Rest · next: ${effortLabel()}</div><div class="countdown rest" id="r-cd">${fmtClock(R.timeLeft)}</div>`,
      foot: `<button class="btn" id="r-skip">Skip rest — ready now</button>`
    });
    document.getElementById('r-skip').addEventListener('click', () => { clearTick(); startCountdownToHang(); });
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
    const tax = App.rating(5, null);
    const felt = App.rating(10, null);
    const notes = document.createElement('textarea'); notes.placeholder = 'Notes (optional)';
    const wrap = shell('', { body: '', foot: '' });
    const rb = wrap.querySelector('.r-body'); rb.style.justifyContent = 'flex-start'; rb.style.paddingTop = '10px'; rb.innerHTML = '';
    const box = document.createElement('div'); box.style.width = '100%'; box.style.textAlign = 'left';
    box.innerHTML = `<div class="phase" style="text-align:center">Session complete</div>
      <p class="muted center">${R.sets.filter(s => s.load != null).map(s => s.load + 'kg@' + s.rpe).join('  ') || R.sets.length + ' efforts'}</p>`;
    const f1 = document.createElement('div'); f1.className = 'field'; f1.innerHTML = '<label>Session taxing (1–5)</label>'; f1.appendChild(tax);
    const f2 = document.createElement('div'); f2.className = 'field'; f2.innerHTML = '<label>Felt strong (1–10)</label>'; f2.appendChild(felt);
    const f3 = document.createElement('div'); f3.className = 'field'; f3.innerHTML = '<label>Notes</label>'; f3.appendChild(notes);
    box.appendChild(f1); box.appendChild(f2); box.appendChild(f3);
    rb.appendChild(box);
    const save = document.createElement('button'); save.className = 'btn'; save.textContent = 'Save & close';
    save.addEventListener('click', async () => {
      const top = R.sets.find(s => s.load != null) || {};
      // back-off count for Heavy = efforts after top set; volume/peak = sets done
      let setsCount;
      if (R.plan.protocol === 'topSetPlusBackoffs') setsCount = Math.max(0, R.sets.length - 1);
      else setsCount = R.sets.length;
      releaseWakeLock();
      host().innerHTML = '';
      await App.logSession(R.plan, {
        load: top.load != null ? top.load : null, rpe: top.rpe != null ? top.rpe : null,
        sets: setsCount, taxing: tax.getValue(), felt: felt.getValue(), notes: notes.value
      });
      R = null;
    });
    const rf = wrap.querySelector('.r-foot'); rf.innerHTML = ''; rf.appendChild(save);
  }

  Runner.abort = function () {
    App.confirm('Quit this session? Nothing will be logged.', 'Quit', () => {
      clearTick(); releaseWakeLock(); host().innerHTML = ''; R = null; App.closeSheet(); App.render();
    });
  };

  root.Runner = Runner;
})(typeof self !== 'undefined' ? self : this);

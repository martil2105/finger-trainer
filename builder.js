/* builder.js — program builder: cycle list, cycle/block editors,
 * live preview table, periodization guardrails (§11), templates (§12), activate. */
(function (root) {
  'use strict';

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
  function kg(v) { return v == null ? '—' : v; }

  const Builder = {};

  // ---- 10.1 cycle list --------------------------------------------------
  Builder.renderList = async function (view) {
    const cycles = await DB.getAll('cycles');
    const order = { active: 0, draft: 1, archived: 2 };
    cycles.sort((a, b) => (order[a.status] - order[b.status]));

    view.appendChild(el('div', { class: 'card' }, [
      el('strong', null, ['New cycle from template']),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn small secondary', style: 'margin:4px 6px 0 0', onclick: () => newFrom('A') }, ['Current (Trans→Peak)']),
      el('button', { class: 'btn small secondary', style: 'margin:4px 6px 0 0', onclick: () => newFrom('B') }, ['Descending 7→5→3']),
      el('button', { class: 'btn small secondary', style: 'margin:4px 0 0', onclick: () => newFrom('C') }, ['Blank'])
    ]));

    cycles.forEach(c => {
      const card = el('div', { class: 'card' });
      card.appendChild(el('div', { class: 'row' }, [
        el('strong', null, [c.name]),
        el('span', { class: 'pill ' + (c.status === 'active' ? 'accent' : '') }, [c.status])
      ]));
      const totalWk = (c.blocks || []).reduce((s, b) => s + b.durationWeeks, 0);
      card.appendChild(el('p', { class: 'muted' }, [`${c.blocks.length} blocks · ${totalWk} weeks · starts ${c.startDate}`]));
      const actions = el('div', { class: 'chips' });
      actions.appendChild(el('button', { class: 'btn small ghost', onclick: () => Builder.openCycleEditor(c) }, ['Edit']));
      actions.appendChild(el('button', { class: 'btn small ghost', onclick: () => cloneCycle(c) }, ['Clone']));
      if (c.status !== 'active') actions.appendChild(el('button', { class: 'btn small', onclick: () => activate(c) }, ['Activate']));
      if (c.status === 'active') actions.appendChild(el('button', { class: 'btn small ghost', onclick: () => setStatus(c, 'archived') }, ['Archive']));
      actions.appendChild(el('button', { class: 'btn small ghost', onclick: () => delCycle(c) }, ['Delete']));
      card.appendChild(actions);
      view.appendChild(card);
    });
  };

  async function newFrom(which) {
    const c = which === 'A' ? Templates.templateA() : which === 'B' ? Templates.templateB() : Templates.templateC();
    c.status = 'draft';
    await DB.put('cycles', c);
    Builder.openCycleEditor(c);
  }
  async function cloneCycle(c) {
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = Templates.uid(); copy.name = c.name + ' (copy)'; copy.status = 'draft';
    copy.blocks.forEach(b => b.id = Templates.uid());
    await DB.put('cycles', copy); App.render();
  }
  async function setStatus(c, s) { c.status = s; await DB.put('cycles', c); App.render(); }
  async function delCycle(c) {
    App.confirm(`Delete cycle "${c.name}"? Log entries are kept (they key on date).`, 'Delete', async () => {
      await DB.del('cycles', c.id); App.render();
    });
  }

  // ---- 10.5 activate ----------------------------------------------------
  async function activate(c) {
    const all = await DB.getAll('cycles');
    await Promise.all(all.filter(x => x.status === 'active').map(x => { x.status = 'archived'; return DB.put('cycles', x); }));
    c.status = 'active';
    c.generatedWeeks = Calc.expandCycle(c); // derived snapshot
    await DB.put('cycles', c);
    App.go('today');
  }
  Builder.activate = activate;

  // ---- 10.2 cycle editor ------------------------------------------------
  Builder.openCycleEditor = function (cycle) {
    const body = [];
    const nameI = el('input', { value: cycle.name });
    nameI.addEventListener('input', () => { cycle.name = nameI.value; });
    body.push(el('div', { class: 'field' }, [el('label', null, ['Cycle name']), nameI]));

    const dateI = el('input', { type: 'date', value: cycle.startDate });
    dateI.addEventListener('change', () => { cycle.startDate = dateI.value; refresh(); });
    body.push(el('div', { class: 'field' }, [el('label', null, ['Start date']), dateI]));

    // weekly structure editor
    body.push(el('label', { class: '', style: 'font-size:13px;color:var(--text-dim)' }, ['Weekly structure']));
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const roles = ['Rest', 'Heavy', 'Volume', 'OIprimer', 'Climb'];
    const wsWrap = el('div', { class: 'card tight' });
    days.forEach(d => {
      const sel = el('select');
      roles.forEach(r => { const o = el('option', { value: r }, [r]); if ((cycle.weeklyStructure || {})[d] === r) o.selected = true; sel.appendChild(o); });
      sel.addEventListener('change', () => { cycle.weeklyStructure[d] = sel.value; refresh(); });
      wsWrap.appendChild(el('div', { class: 'row', style: 'margin:4px 0' }, [el('span', { class: 'muted' }, [d.toUpperCase()]), sel]));
    });
    body.push(wsWrap);

    // block list
    body.push(el('h2', null, ['Blocks']));
    const blockList = el('div');
    body.push(blockList);
    body.push(el('button', { class: 'btn secondary', onclick: () => {
      cycle.blocks.push(Templates.block('New block', 'Custom', 4, 5, 'topSetPlusBackoffs', 8, 8, 3, 3, 0.82, 5, 0.82, 0.85, 4, 3));
      refresh();
    } }, ['+ Add block']));

    // guardrails panel
    const guardPanel = el('div');
    body.push(guardPanel);

    // live preview
    body.push(el('h2', null, ['Live preview']));
    const preview = el('div', { class: 'card', style: 'overflow-x:auto' });
    body.push(preview);

    body.push(el('div', { class: 'spacer' }));
    body.push(el('button', { class: 'btn', onclick: async () => { await DB.put('cycles', cycle); App.closeSheet(); App.render(); } }, ['Save draft']));
    body.push(el('button', { class: 'btn ghost', style: 'margin-top:8px', onclick: async () => { await DB.put('cycles', cycle); activate(cycle); App.closeSheet(); } }, ['Save & activate']));

    App.sheet('Edit cycle', body);

    async function refresh() {
      // block cards
      blockList.innerHTML = '';
      cycle.blocks.forEach((b, i) => {
        const card = el('div', { class: 'card tight' });
        card.appendChild(el('div', { class: 'row' }, [
          el('strong', null, [b.name]),
          el('span', null, [
            el('button', { class: 'btn small ghost', style: 'margin-right:4px', onclick: () => { if (i > 0) { cycle.blocks.splice(i - 1, 0, cycle.blocks.splice(i, 1)[0]); refresh(); } } }, ['↑']),
            el('button', { class: 'btn small ghost', style: 'margin-right:4px', onclick: () => { if (i < cycle.blocks.length - 1) { cycle.blocks.splice(i + 1, 0, cycle.blocks.splice(i, 1)[0]); refresh(); } } }, ['↓']),
            el('button', { class: 'btn small ghost', onclick: () => { cycle.blocks.splice(i, 1); refresh(); } }, ['✕'])
          ])
        ]));
        const desc = b.isDeloadTest
          ? `Deload + test ${b.testConfig.testDurations.join('/')}s`
          : `${b.type} · ${b.durationWeeks}wk · ${b.heavy.hangDurationSeconds}s @${b.heavy.rpeStart}→${b.heavy.rpeEnd}`;
        card.appendChild(el('p', { class: 'muted', style: 'margin:6px 0' }, [desc]));
        card.appendChild(el('button', { class: 'btn small secondary', onclick: () => Builder.openBlockEditor(b, refresh) }, ['Edit block']));
        blockList.appendChild(card);
      });

      // guardrails
      const wmDurs = await DB.wmDurationsOnFile();
      const warns = Calc.guardrails(cycle, wmDurs);
      guardPanel.innerHTML = '';
      if (warns.length) {
        guardPanel.appendChild(el('details', { class: 'card', open: 'true' }, [
          el('summary', { style: 'cursor:pointer;color:var(--warn)' }, [`Periodization warnings (${warns.length})`]),
          ...warns.map(w => el('p', { class: 'muted', style: 'margin:8px 0' }, ['• ' + w.message]))
        ]));
      } else {
        guardPanel.appendChild(el('p', { class: 'muted' }, ['No periodization warnings.']));
      }

      // live preview table
      const wmFor = await wmForFn();
      const weeks = App.getWeeks(cycle, wmFor);
      const t = el('table', { class: 'prev' });
      t.appendChild(el('tr', { html: '<th>Wk</th><th>Block</th><th>H RPE</th><th>H dur</th><th>Anchor</th><th>Vol %</th><th>Vol anchor</th><th>Sets</th>' }));
      weeks.forEach(w => {
        if (w.isDeloadTest) {
          t.appendChild(el('tr', { html:
            `<td>${w.weekNumber}</td><td>${w.blockName}</td><td>deload</td><td>${w.testDurations.join('/')}s</td><td>${w.deloadAnchorKg == null ? '<span class="wmneed">WM needed</span>' : kg(w.deloadAnchorKg)}</td><td>—</td><td>—</td><td>3</td>` }));
        } else {
          const anchorCell = w.wmMissing ? '<span class="wmneed">WM needed</span>' : kg(w.heavyAnchorKg);
          t.appendChild(el('tr', { html:
            `<td>${w.weekNumber}</td><td>${w.blockName}</td><td>@${w.heavyRPE}</td><td>${w.heavyDuration}s</td><td>${anchorCell}</td><td>${Math.round((w.volumePct || 0) * 100)}%</td><td>${kg(w.volumeAnchorKg)}</td><td>${w.volumeSets}</td>` }));
        }
      });
      preview.innerHTML = ''; preview.appendChild(t);
    }
    refresh();
  };

  async function wmForFn() {
    const [w5, w3, w7] = await Promise.all([DB.currentWM(5), DB.currentWM(3), DB.currentWM(7)]);
    const map = { 5: w5 && w5.valueKg, 3: w3 && w3.valueKg, 7: w7 && w7.valueKg };
    return (d) => (map[d] != null ? map[d] : null);
  }

  // ---- 10.3 block editor ------------------------------------------------
  Builder.openBlockEditor = function (b, onSave) {
    const body = [];
    const nameI = el('input', { value: b.name });
    nameI.addEventListener('input', () => b.name = nameI.value);
    body.push(el('div', { class: 'field' }, [el('label', null, ['Block name']), nameI]));

    body.push(sel('Type', ['Accumulation', 'Transmutation', 'Peak', 'Realization', 'DeloadTest', 'Custom'], b.type, v => {
      b.type = v; b.isDeloadTest = (v === 'DeloadTest');
      if (b.isDeloadTest && !b.testConfig) b.testConfig = { deloadPctOfWM: 0.75, testDurations: [5] };
      if (b.isDeloadTest) { b.heavy = null; b.volume = null; } else if (!b.heavy) {
        Object.assign(b, Templates.block(b.name, v, b.durationWeeks, 5, 'topSetPlusBackoffs', 8, 8, 3, 3, 0.82, 5, 0.82, 0.85, 4, 3));
        b.type = v;
      }
      rerender();
    }));

    const weeksSt = App.stepper({ min: 1, max: 12, step: 1, value: b.durationWeeks, fmt: v => v + ' wk', onChange: v => b.durationWeeks = v });
    body.push(el('div', { class: 'field' }, [el('label', null, ['Weeks']), weeksSt]));

    const dyn = el('div'); body.push(dyn);

    body.push(el('button', { class: 'btn', onclick: () => { App.closeSheet(); onSave && onSave(); } }, ['Done']));
    App.sheet('Edit block', body);

    function rerender() {
      dyn.innerHTML = '';
      if (b.isDeloadTest) {
        const dl = App.stepper({ min: 0.5, max: 0.9, step: 0.05, value: b.testConfig.deloadPctOfWM, fmt: v => Math.round(v * 100) + '%', onChange: v => b.testConfig.deloadPctOfWM = v });
        dyn.appendChild(el('div', { class: 'field' }, [el('label', null, ['Deload %']), dl]));
        dyn.appendChild(el('label', { style: 'font-size:13px;color:var(--text-dim)' }, ['Test durations']));
        const row = el('div', { class: 'chips' });
        [7, 5, 3].forEach(d => {
          const on = b.testConfig.testDurations.includes(d);
          const c = el('button', { class: 'chip' + (on ? ' sel' : '') }, [d + 's']);
          c.addEventListener('click', () => {
            const arr = b.testConfig.testDurations; const i = arr.indexOf(d);
            if (i >= 0) arr.splice(i, 1); else arr.push(d);
            arr.sort((a, z) => z - a); rerender();
          });
          row.appendChild(c);
        });
        dyn.appendChild(row);
        return;
      }
      // HEAVY section
      dyn.appendChild(el('h2', null, ['Heavy']));
      dyn.appendChild(sel('Hang duration', ['7', '5', '3'], String(b.heavy.hangDurationSeconds), v => b.heavy.hangDurationSeconds = +v));
      dyn.appendChild(sel('Protocol', ['topSetPlusBackoffs', 'maxSingles', 'fixedVolume'], b.heavy.protocol, v => { b.heavy.protocol = v; rerender(); }));
      const rpeS = App.stepper({ min: 6, max: 10, step: 0.5, value: b.heavy.rpeStart, fmt: v => '@' + v, onChange: v => b.heavy.rpeStart = v });
      const rpeE = App.stepper({ min: 6, max: 10, step: 0.5, value: b.heavy.rpeEnd, fmt: v => '@' + v, onChange: v => b.heavy.rpeEnd = v });
      dyn.appendChild(el('div', { class: 'grid2' }, [
        el('div', { class: 'field' }, [el('label', null, ['RPE start']), rpeS]),
        el('div', { class: 'field' }, [el('label', null, ['RPE end']), rpeE])
      ]));
      const setsS = App.stepper({ min: 0, max: 8, step: 1, value: b.heavy.setsStart, onChange: v => b.heavy.setsStart = v });
      const setsE = App.stepper({ min: 0, max: 8, step: 1, value: b.heavy.setsEnd, onChange: v => b.heavy.setsEnd = v });
      dyn.appendChild(el('div', { class: 'grid2' }, [
        el('div', { class: 'field' }, [el('label', null, ['Sets start']), setsS]),
        el('div', { class: 'field' }, [el('label', null, ['Sets end']), setsE])
      ]));
      if (b.heavy.protocol !== 'maxSingles') {
        const bo = App.stepper({ min: 0.5, max: 0.95, step: 0.01, value: b.heavy.backoffPctOfTop || 0.82, fmt: v => Math.round(v * 100) + '%', onChange: v => b.heavy.backoffPctOfTop = v });
        dyn.appendChild(el('div', { class: 'field' }, [el('label', null, ['Back-off %']), bo]));
      } else { b.heavy.backoffPctOfTop = null; }

      // VOLUME section
      dyn.appendChild(el('h2', null, ['Volume']));
      dyn.appendChild(sel('Volume duration', ['7', '5', '3'], String(b.volume.hangDurationSeconds), v => b.volume.hangDurationSeconds = +v));
      const pS = App.stepper({ min: 0.6, max: 1, step: 0.01, value: b.volume.pctStart, fmt: v => Math.round(v * 100) + '%', onChange: v => b.volume.pctStart = v });
      const pE = App.stepper({ min: 0.6, max: 1, step: 0.01, value: b.volume.pctEnd, fmt: v => Math.round(v * 100) + '%', onChange: v => b.volume.pctEnd = v });
      dyn.appendChild(el('div', { class: 'grid2' }, [
        el('div', { class: 'field' }, [el('label', null, ['Vol % start']), pS]),
        el('div', { class: 'field' }, [el('label', null, ['Vol % end']), pE])
      ]));
      const vSets = App.stepper({ min: 1, max: 8, step: 1, value: b.volume.sets, onChange: v => b.volume.sets = v });
      dyn.appendChild(el('div', { class: 'field' }, [el('label', null, ['Volume sets (fixed)']), vSets]));
      const noExt = el('div', { class: 'row' }, [el('span', { class: 'muted' }, ['No extensions']),
        toggle(b.volume.fixedNoExtensions, v => b.volume.fixedNoExtensions = v)]);
      dyn.appendChild(el('div', { class: 'field' }, [noExt]));

      // OI
      dyn.appendChild(el('h2', null, ['OI primer']));
      dyn.appendChild(sel('OI sets', ['0', '1', '2', '3', '4', '5', '3-5'], String(b.oi && b.oi.sets !== undefined ? b.oi.sets : '3-5'), v => {
        b.oi = b.oi || {};
        b.oi.sets = v === '3-5' ? '3-5' : +v;
      }));
    }
    rerender();
  };

  function sel(label, opts, value, onChange) {
    const s = el('select');
    opts.forEach(o => { const op = el('option', { value: o }, [o]); if (o === value) op.selected = true; s.appendChild(op); });
    s.addEventListener('change', () => onChange(s.value));
    return el('div', { class: 'field' }, [el('label', null, [label]), s]);
  }
  function toggle(on, onChange) {
    const b = el('button', { class: 'chip' + (on ? ' sel' : '') }, [on ? 'On' : 'Off']);
    b.addEventListener('click', () => { on = !on; b.className = 'chip' + (on ? ' sel' : ''); b.textContent = on ? 'On' : 'Off'; onChange(on); });
    return b;
  }

  root.Builder = Builder;
})(typeof self !== 'undefined' ? self : this);

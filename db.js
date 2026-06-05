/* db.js — self-contained Promise-based IndexedDB layer.
 * No CDN dependency so the app works fully offline. Stores:
 * workingMaxes, cycles, logEntries, benchmarks, meta (kv). */
(function (root) {
  'use strict';

  const DB_NAME = 'fingerTrainer';
  const DB_VERSION = 2; // v2 adds the tombstones store (soft-delete sync)
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('workingMaxes')) {
          const s = db.createObjectStore('workingMaxes', { keyPath: 'id' });
          s.createIndex('durationSeconds', 'durationSeconds');
          s.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('cycles')) {
          db.createObjectStore('cycles', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('logEntries')) {
          const s = db.createObjectStore('logEntries', { keyPath: 'id' });
          s.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('benchmarks')) {
          const s = db.createObjectStore('benchmarks', { keyPath: 'id' });
          s.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        // Tombstones: one record per deleted item so deletions propagate
        // through Gist sync instead of the item resurrecting from a peer.
        if (!db.objectStoreNames.contains('tombstones')) {
          db.createObjectStore('tombstones', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return open().then(db => db.transaction(store, mode).objectStore(store));
  }
  function reqP(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }

  function put(store, val) { return tx(store, 'readwrite').then(s => reqP(s.put(val))); }
  function del(store, key) { return tx(store, 'readwrite').then(s => reqP(s.delete(key))); }
  function getAll(store) { return tx(store, 'readonly').then(s => reqP(s.getAll())); }
  function get(store, key) { return tx(store, 'readonly').then(s => reqP(s.get(key))); }
  function clear(store) { return tx(store, 'readwrite').then(s => reqP(s.clear())); }

  // ---- meta key/value ---------------------------------------------------
  function getMeta(key) { return get('meta', key).then(r => r ? r.value : undefined); }
  function setMeta(key, value) { return put('meta', { key, value }); }

  // ---- soft delete ------------------------------------------------------
  // Records a tombstone AND removes the record. The tombstone travels through
  // Gist sync so other devices delete their copy too (a plain delete would be
  // undone on the next merge, since merge only ever adds by id).
  function softDelete(store, id) {
    return Promise.all([
      put('tombstones', { id: id, store: store, deletedAt: new Date().toISOString() }),
      del(store, id)
    ]);
  }
  // Strip tombstoned records out of an in-memory backup object (keeps the
  // tombstones themselves so peers still learn about the deletion).
  function applyTombstones(data) {
    const tombs = data.tombstones || [];
    const byStore = {};
    tombs.forEach(t => { (byStore[t.store] = byStore[t.store] || new Set()).add(t.id); });
    const strip = (arr, store) => {
      const dead = byStore[store];
      return dead ? (arr || []).filter(x => !dead.has(x.id)) : (arr || []);
    };
    return {
      logEntries: strip(data.logEntries, 'logEntries'),
      workingMaxes: strip(data.workingMaxes, 'workingMaxes'),
      cycles: strip(data.cycles, 'cycles'),
      benchmarks: strip(data.benchmarks, 'benchmarks'),
      tombstones: tombs,
      meta: data.meta || []
    };
  }

  // ---- domain helpers ---------------------------------------------------
  // Current WM for a duration = latest-dated entry for that duration.
  function currentWM(durationSeconds) {
    return getAll('workingMaxes').then(all => {
      const f = all.filter(w => w.durationSeconds === durationSeconds);
      if (!f.length) return null;
      f.sort((a, b) => (a.date < b.date ? 1 : -1));
      return f[0];
    });
  }
  function wmDurationsOnFile() {
    return getAll('workingMaxes').then(all =>
      Array.from(new Set(all.map(w => w.durationSeconds))));
  }
  function activeCycle() {
    return getAll('cycles').then(all => {
      if (!all.length) return null;
      const active = all.find(c => c.status === 'active');
      if (active) return active;
      // Self-heal (READ-ONLY — no writes, so it can't ping-pong across synced
      // devices): no cycle is flagged active, which can happen when a sync
      // merge or a delete strands the data. Fall back so Today still works,
      // preferring a cycle whose date range contains today, else the most
      // recently started one. The user can make it official via "Activate".
      let todayIso;
      try {
        const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
        todayIso = d.toISOString().slice(0, 10);
      } catch (e) { todayIso = new Date().toISOString().slice(0, 10); }
      const containsToday = (typeof Calc !== 'undefined' && Calc.weekNumberFor)
        ? all.filter(c => Calc.weekNumberFor(c, todayIso) != null) : [];
      const pool = containsToday.length ? containsToday : all.slice();
      pool.sort((a, b) => (a.startDate < b.startDate ? 1 : (a.startDate > b.startDate ? -1 : 0)));
      return pool[0] || null;
    });
  }
  function logsNewestFirst() {
    return getAll('logEntries').then(all => {
      all.sort((a, b) => (a.date < b.date ? 1 : (a.date > b.date ? -1 : 0)));
      return all;
    });
  }

  function addLog(entry) {
    if (!entry.id) entry.id = Templates.uid();
    // recompute E1RM for Yielding roles (3s hangs normalised ÷1.1 to 5s-equivalent)
    const yielding = entry.type === 'Yielding';
    entry.e1rmKg = yielding ? Calc.e1rm(entry.topSetLoadKg, entry.topSetRPE, entry.hangDurationSeconds) : null;
    return put('logEntries', entry).then(() => entry);
  }

  // ---- first-run seed (§7 + §5 + imported history) ----------------------
  function seedIfEmpty() {
    return getMeta('seeded').then(done => {
      if (done) return false;
      const cycle = Templates.templateA();
      cycle.id = 'seed_cycle_main'; // stable id so devices don't duplicate it
      const wm = {
        id: 'seed_wm_5s_init', durationSeconds: 5, valueKg: 25,
        date: '2026-05-26', source: 'estimated',
        notes: 'Reset from +25kg given Thu @10 ceiling — recheck on rested day'
      };
      const ops = [ put('cycles', cycle), put('workingMaxes', wm) ];
      // seed historical log with E1RM computed
      Templates.SEED_LOG.forEach(e => {
        const entry = Object.assign({}, e);
        entry.e1rmKg = entry.type === 'Yielding'
          ? Calc.e1rm(entry.topSetLoadKg, entry.topSetRPE, entry.hangDurationSeconds) : null;
        ops.push(put('logEntries', entry));
      });
      return Promise.all(ops).then(() => setMeta('seeded', true)).then(() => true);
    });
  }

  // ---- de-duplication ---------------------------------------------------
  // Records that are logically identical but carry different ids (e.g. the
  // seed history that older versions re-created with a random id on every
  // device) pile up when Gist sync merges by id. We collapse them using a
  // content signature, keeping ONE deterministic winner so every device
  // converges on the same surviving row.
  function logKey(e) {
    return ['log', e.date, e.type, e.role, e.venue,
            e.topSetLoadKg, e.topSetRPE, e.sets, e.hangDurationSeconds,
            e.notes].join('|');
  }
  function wmKey(w) {
    return ['wm', w.date, w.durationSeconds, w.valueKg].join('|');
  }
  function cycleKey(c) {
    return ['cycle', c.name, c.startDate].join('|');
  }
  function benchKey(b) {
    // re-saving/editing a Test logs a fresh benchmark; collapse identical ones
    return ['bench', b.date, b.durationSeconds, b.maxLoadKg, b.rpe].join('|');
  }
  function statusRank(x) {
    return (x && x.status === 'active') ? 0 : (x && x.status === 'draft') ? 1 : 2;
  }
  function preferred(a, b) {
    // Deterministic winner so every device converges on the same row.
    // For records that carry a status (cycles), an active copy must beat an
    // archived/draft copy — otherwise collapsing duplicate cycles could drop
    // the active one and leave Today with "No active cycle".
    if (a.status !== undefined && b.status !== undefined) {
      const ra = statusRank(a), rb = statusRank(b);
      if (ra !== rb) return ra < rb ? a : b;
    }
    // Stable 'seed_*' ids beat random ones; otherwise smallest id wins.
    const aSeed = String(a.id).startsWith('seed_');
    const bSeed = String(b.id).startsWith('seed_');
    if (aSeed !== bSeed) return aSeed ? a : b;
    return String(a.id) < String(b.id) ? a : b;
  }
  function dedupeByKey(arr, keyFn) {
    const winners = new Map();
    (arr || []).forEach(item => {
      const k = keyFn(item);
      const cur = winners.get(k);
      winners.set(k, cur ? preferred(cur, item) : item);
    });
    return Array.from(winners.values());
  }
  // Pure helper used by the sync merge before data is written/uploaded.
  function dedupeDatabase(data) {
    return {
      logEntries: dedupeByKey(data.logEntries || [], logKey),
      workingMaxes: dedupeByKey(data.workingMaxes || [], wmKey),
      cycles: dedupeByKey(data.cycles || [], cycleKey),
      benchmarks: dedupeByKey(data.benchmarks || [], benchKey),
      tombstones: data.tombstones || [], // passed through, applied separately
      meta: data.meta || []
    };
  }
  // Collapse duplicates already sitting in the local IndexedDB.
  function dedupe() {
    return Promise.all([
      getAll('logEntries'), getAll('workingMaxes'), getAll('cycles'), getAll('benchmarks')
    ]).then(([logs, wms, cycles, benchmarks]) => {
      const ops = [];
      [['logEntries', logs, logKey],
       ['workingMaxes', wms, wmKey],
       ['cycles', cycles, cycleKey],
       ['benchmarks', benchmarks, benchKey]].forEach(([store, arr, keyFn]) => {
        const keep = new Set(dedupeByKey(arr, keyFn).map(x => x.id));
        arr.forEach(x => { if (!keep.has(x.id)) ops.push(del(store, x.id)); });
      });
      return Promise.all(ops).then(() => ops.length);
    });
  }

  function exportBackup() {
    return Promise.all([
      getAll('logEntries'),
      getAll('workingMaxes'),
      getAll('cycles'),
      getAll('benchmarks'),
      getAll('tombstones'),
      getAll('meta')
    ]).then(([logs, wms, cycles, benchmarks, tombstones, meta]) => {
      const cleanMeta = meta.filter(m => m.key !== 'githubToken' && m.key !== 'githubGistId');
      return { logEntries: logs, workingMaxes: wms, cycles, benchmarks, tombstones, meta: cleanMeta };
    });
  }

  function importBackup(data) {
    if (!data) return Promise.resolve();
    const ops = [];
    if (data.logEntries) {
      data.logEntries.forEach(x => ops.push(put('logEntries', x)));
    }
    if (data.workingMaxes) {
      data.workingMaxes.forEach(x => ops.push(put('workingMaxes', x)));
    }
    if (data.cycles) {
      data.cycles.forEach(x => ops.push(put('cycles', x)));
    }
    if (data.benchmarks) {
      data.benchmarks.forEach(x => ops.push(put('benchmarks', x)));
    }
    if (data.meta) {
      data.meta.forEach(x => {
        if (x.key !== 'githubToken' && x.key !== 'githubGistId') {
          ops.push(put('meta', x));
        }
      });
    }
    if (data.tombstones) {
      data.tombstones.forEach(t => ops.push(put('tombstones', t)));
    }
    return Promise.all(ops).then(() => {
      // Second phase (after all puts settle): honour incoming deletions by
      // removing any locally-present record that a peer has tombstoned.
      const dels = (data.tombstones || []).map(t => del(t.store, t.id));
      return Promise.all(dels);
    });
  }

  function resetAll() {
    return Promise.all([
      clear('workingMaxes'), clear('cycles'), clear('logEntries'),
      clear('benchmarks'), clear('tombstones'), clear('meta')
    ]);
  }

  root.DB = {
    open, put, del, getAll, get, clear, getMeta, setMeta,
    currentWM, wmDurationsOnFile, activeCycle, logsNewestFirst, addLog,
    seedIfEmpty, resetAll, exportBackup, importBackup,
    dedupe, dedupeDatabase, softDelete, applyTombstones
  };
})(typeof self !== 'undefined' ? self : this);

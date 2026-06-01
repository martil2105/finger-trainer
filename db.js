/* db.js — self-contained Promise-based IndexedDB layer.
 * No CDN dependency so the app works fully offline. Stores:
 * workingMaxes, cycles, logEntries, benchmarks, meta (kv). */
(function (root) {
  'use strict';

  const DB_NAME = 'fingerTrainer';
  const DB_VERSION = 1;
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
    return getAll('cycles').then(all => all.find(c => c.status === 'active') || null);
  }
  function logsNewestFirst() {
    return getAll('logEntries').then(all => {
      all.sort((a, b) => (a.date < b.date ? 1 : (a.date > b.date ? -1 : 0)));
      return all;
    });
  }

  function addLog(entry) {
    if (!entry.id) entry.id = Templates.uid();
    // recompute E1RM for Yielding roles
    const yielding = entry.type === 'Yielding';
    entry.e1rmKg = yielding ? Calc.e1rm(entry.topSetLoadKg, entry.topSetRPE) : null;
    return put('logEntries', entry).then(() => entry);
  }

  // ---- first-run seed (§7 + §5 + imported history) ----------------------
  function seedIfEmpty() {
    return getMeta('seeded').then(done => {
      if (done) return false;
      const cycle = Templates.templateA();
      const wm = {
        id: Templates.uid(), durationSeconds: 5, valueKg: 25,
        date: '2026-05-26', source: 'estimated',
        notes: 'Reset from +25kg given Thu @10 ceiling — recheck on rested day'
      };
      const ops = [ put('cycles', cycle), put('workingMaxes', wm) ];
      // seed historical log with E1RM computed
      Templates.SEED_LOG.forEach(e => {
        const entry = Object.assign({}, e);
        entry.e1rmKg = entry.type === 'Yielding'
          ? Calc.e1rm(entry.topSetLoadKg, entry.topSetRPE) : null;
        ops.push(put('logEntries', entry));
      });
      return Promise.all(ops).then(() => setMeta('seeded', true)).then(() => true);
    });
  }

  function resetAll() {
    return Promise.all([
      clear('workingMaxes'), clear('cycles'), clear('logEntries'),
      clear('benchmarks'), clear('meta')
    ]);
  }

  root.DB = {
    open, put, del, getAll, get, clear, getMeta, setMeta,
    currentWM, wmDurationsOnFile, activeCycle, logsNewestFirst, addLog,
    seedIfEmpty, resetAll
  };
})(typeof self !== 'undefined' ? self : this);

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

  const nowIso = () => new Date().toISOString();

  // User-driven write: stamps updatedAt so the sync merge can pick the newest
  // copy of a record instead of blindly letting the remote win. Sync/import
  // paths keep using the raw put() so incoming timestamps are preserved.
  function save(store, val) { val.updatedAt = nowIso(); return put(store, val); }

  // Batch write in ONE transaction (importBackup used to open a transaction
  // per record — slow on large merges, and a crash left more partial state).
  function putAll(store, items) {
    if (!items || !items.length) return Promise.resolve();
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      const s = t.objectStore(store);
      items.forEach(x => s.put(x));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  // Device-local meta keys: never uploaded to the Gist and never overwritten
  // by a peer (secrets, per-device prompts, per-device sync bookkeeping).
  const LOCAL_META = ['githubToken', 'githubGistId', 'lastSyncAt', 'pendingNextDayFeel'];

  // ---- meta key/value ---------------------------------------------------
  function getMeta(key) { return get('meta', key).then(r => r ? r.value : undefined); }
  function setMeta(key, value) { return put('meta', { key, value, updatedAt: nowIso() }); }

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
  // Tombstones expire after 90 days: every device that syncs within that
  // window learns the deletion, and the payload stops growing forever.
  const TOMBSTONE_TTL_DAYS = 90;
  function liveTombstones(tombs) {
    const cutoff = new Date(Date.now() - TOMBSTONE_TTL_DAYS * 86400000).toISOString();
    return (tombs || []).filter(t => (t.deletedAt || '') >= cutoff);
  }
  // Drop expired tombstone rows from the local store (run after each sync).
  function gcTombstones() {
    return getAll('tombstones').then(all => {
      const live = new Set(liveTombstones(all).map(t => t.id));
      const dead = all.filter(t => !live.has(t.id));
      return Promise.all(dead.map(t => del('tombstones', t.id))).then(() => dead.length);
    });
  }

  // Strip tombstoned records out of an in-memory backup object (keeps live
  // tombstones so peers still learn about the deletion). A record edited
  // AFTER its deletion survives — resurrect-on-edit beats delete.
  function applyTombstones(data) {
    const tombs = liveTombstones(data.tombstones);
    const byStore = {};
    tombs.forEach(t => { (byStore[t.store] = byStore[t.store] || new Map()).set(t.id, t.deletedAt || ''); });
    const strip = (arr, store) => {
      const dead = byStore[store];
      if (!dead) return arr || [];
      return (arr || []).filter(x => !dead.has(x.id) || ((x.updatedAt || '') > dead.get(x.id)));
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
    entry.updatedAt = nowIso();
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
    // A record with a newer updatedAt is a newer user intent — it wins
    // outright (both devices see the same pair, so this stays convergent).
    const ta = a.updatedAt || '', tb = b.updatedAt || '';
    if (ta !== tb) return ta > tb ? a : b;
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
      const cleanMeta = meta.filter(m => !LOCAL_META.includes(m.key));
      return { logEntries: logs, workingMaxes: wms, cycles, benchmarks,
               tombstones: liveTombstones(tombstones), meta: cleanMeta };
    });
  }

  function importBackup(data) {
    if (!data) return Promise.resolve();
    const cleanMeta = (data.meta || []).filter(m => !LOCAL_META.includes(m.key));
    const tombs = liveTombstones(data.tombstones);
    // One transaction per store (not per record).
    return Promise.all([
      putAll('logEntries', data.logEntries || []),
      putAll('workingMaxes', data.workingMaxes || []),
      putAll('cycles', data.cycles || []),
      putAll('benchmarks', data.benchmarks || []),
      putAll('meta', cleanMeta),
      putAll('tombstones', tombs)
    ]).then(() => {
      // Second phase: honour incoming deletions — unless the local copy was
      // edited AFTER the deletion, in which case the edit wins and the
      // record survives (it will resurrect on peers via the merge).
      return Promise.all(tombs.map(t =>
        get(t.store, t.id).then(rec => {
          if (rec && ((rec.updatedAt || '') > (t.deletedAt || ''))) return;
          return del(t.store, t.id);
        })
      ));
    });
  }

  function resetAll() {
    return Promise.all([
      clear('workingMaxes'), clear('cycles'), clear('logEntries'),
      clear('benchmarks'), clear('tombstones'), clear('meta')
    ]);
  }

  root.DB = {
    open, put, save, putAll, del, getAll, get, clear, getMeta, setMeta,
    currentWM, wmDurationsOnFile, activeCycle, logsNewestFirst, addLog,
    seedIfEmpty, resetAll, exportBackup, importBackup,
    dedupe, dedupeDatabase, softDelete, applyTombstones, gcTombstones
  };
})(typeof self !== 'undefined' ? self : this);

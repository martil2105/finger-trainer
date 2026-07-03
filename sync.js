/* sync.js — GitHub Gist synchronization module.
 * Exposes window.Sync with run, saveToken, and disconnect methods. */
(function (root) {
  'use strict';

  const Sync = {};

  async function saveToken(token) {
    if (!token) return;
    await DB.setMeta('githubToken', token.trim());
  }

  async function disconnect() {
    await DB.setMeta('githubToken', null);
    await DB.setMeta('githubGistId', null);
  }

  function mergeDatabases(local, remote) {
    return {
      logEntries: mergeByUID(local.logEntries || [], remote.logEntries || []),
      workingMaxes: mergeByUID(local.workingMaxes || [], remote.workingMaxes || []),
      cycles: mergeByUID(local.cycles || [], remote.cycles || []),
      benchmarks: mergeByUID(local.benchmarks || [], remote.benchmarks || []),
      tombstones: mergeByUID(local.tombstones || [], remote.tombstones || []),
      meta: mergeMeta(local.meta || [], remote.meta || [])
    };
  }

  // Newest edit wins on an id collision. Records without updatedAt (legacy)
  // compare as oldest; a tie keeps the old behavior (second/remote wins),
  // which is convergent because both devices merge the same pair.
  function newer(a, b) {
    const ta = a.updatedAt || '', tb = b.updatedAt || '';
    if (ta === tb) return b;
    return ta > tb ? a : b;
  }

  function mergeByUID(arr1, arr2) {
    const map = new Map();
    arr1.forEach(item => map.set(item.id, item));
    arr2.forEach(item => map.set(item.id, map.has(item.id) ? newer(map.get(item.id), item) : item));
    return Array.from(map.values());
  }

  function mergeMeta(arr1, arr2) {
    // metadata keys are unique; newest write wins (legacy entries -> remote)
    const map = new Map();
    arr1.forEach(item => map.set(item.key, item));
    arr2.forEach(item => map.set(item.key, map.has(item.key) ? newer(map.get(item.key), item) : item));
    return Array.from(map.values());
  }

  // Read + parse the sync file from a fetched gist object.
  // · Gists truncate inline content over ~1MB — when file.truncated is set,
  //   the full body must come from raw_url (the old code would have parsed
  //   half a JSON file, hit the "corrupt" branch, and overwritten history).
  // · On a parse failure we ABORT the sync instead of overwriting the remote:
  //   gist revision history makes a stuck sync recoverable, an overwrite not.
  async function readGistFile(gist, headers, status) {
    const file = gist.files && gist.files['finger-trainer-sync.json'];
    if (!file) return null;
    let content = file.content;
    if (file.truncated && file.raw_url) {
      status('Backup is large — fetching full file...');
      const r = await fetch(file.raw_url, { headers: { 'Authorization': headers.Authorization } });
      if (!r.ok) throw new Error(`Raw file fetch failed (${r.status})`);
      content = await r.text();
    }
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch (e) {
      throw new Error('Remote backup could not be parsed — aborting sync to protect it. (' + e.message + ')');
    }
  }

  let _inFlight = false;
  async function run(onStatus) {
    const status = (msg) => { console.log('[Sync]', msg); onStatus && onStatus(msg); };
    if (_inFlight) {
      status('A sync is already in progress…');
      return { success: false, error: 'Sync already running' };
    }
    _inFlight = true;
    try {
      const token = await DB.getMeta('githubToken');
      if (!token) {
        status('No GitHub token configured.');
        return { success: false, error: 'No token' };
      }

      let gistId = await DB.getMeta('githubGistId');
      const localData = await DB.exportBackup();

      const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      };

      // 1. Search for existing Gist on GitHub if not linked locally
      let remoteData = null;
      if (!gistId) {
        status('Searching GitHub for existing sync Gist...');
        const listRes = await fetch('https://api.github.com/gists', { headers });
        if (listRes.ok) {
          const gists = await listRes.json();
          const existingGist = gists.find(g => g.files && g.files['finger-trainer-sync.json']);
          if (existingGist) {
            gistId = existingGist.id;
            await DB.setMeta('githubGistId', gistId);
            status('Found existing sync Gist on GitHub. Linking...');
          }
        }
      }

      // 2. Fetch remote gist if linked
      let remoteStamp = null; // gist.updated_at at fetch time (race detection)
      if (gistId) {
        status('Fetching remote Gist backup...');
        const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers });
        if (res.status === 404) {
          status('Remote Gist was not found. Resetting link...');
          gistId = null;
          await DB.setMeta('githubGistId', null);
        } else if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Fetch failed (${res.status}): ${errText}`);
        } else {
          const gist = await res.json();
          remoteStamp = gist.updated_at || null;
          remoteData = await readGistFile(gist, headers, status);
          if (remoteData) status('Remote data fetched successfully.');
        }
      }

      // 2. Merge local and remote data
      let mergedData;
      if (remoteData) {
        status('Merging local and remote entries...');
        mergedData = mergeDatabases(localData, remoteData);
      } else {
        status('Using local database as source...');
        mergedData = localData;
      }

      // 2b. Collapse logically-identical rows that carry different ids
      // (old seed history, cross-device copies) so they don't accumulate.
      mergedData = DB.dedupeDatabase(mergedData);
      // 2c. Apply tombstones: drop records anyone has deleted so they don't
      // resurrect, while keeping the tombstones in the payload for peers.
      mergedData = DB.applyTombstones(mergedData);

      if (remoteData) {
        status('Applying merged database locally...');
        await DB.importBackup(mergedData);
        // importBackup only writes — drop any stale duplicate rows still
        // sitting in the local store so the UI matches the merged result.
        await DB.dedupe();
      }

      // 2d. Race guard: if another device uploaded while we merged, our PATCH
      // would silently clobber its changes. Re-check the gist's updated_at
      // and fold in the fresh copy once before uploading.
      if (gistId && remoteStamp) {
        const chk = await fetch(`https://api.github.com/gists/${gistId}`, { headers });
        if (chk.ok) {
          const fresh = await chk.json();
          if (fresh.updated_at && fresh.updated_at !== remoteStamp) {
            status('Remote changed during merge — re-merging...');
            const freshData = await readGistFile(fresh, headers, status);
            if (freshData) {
              mergedData = DB.applyTombstones(DB.dedupeDatabase(mergeDatabases(mergedData, freshData)));
              await DB.importBackup(mergedData);
              await DB.dedupe();
            }
          }
        }
      }

      const fileContent = JSON.stringify(mergedData, null, 2);

      // 3. Save database back to Gist
      if (!gistId) {
        status('Creating a new private Gist for sync...');
        const body = JSON.stringify({
          description: 'Finger Trainer backup data',
          public: false,
          files: {
            'finger-trainer-sync.json': {
              content: fileContent
            }
          }
        });
        const res = await fetch('https://api.github.com/gists', {
          method: 'POST',
          headers,
          body
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Create failed (${res.status}): ${errText}`);
        }
        const gist = await res.json();
        gistId = gist.id;
        await DB.setMeta('githubGistId', gistId);
        status('New private Gist created and linked.');
      } else {
        status('Uploading merged database to Gist...');
        const body = JSON.stringify({
          files: {
            'finger-trainer-sync.json': {
              content: fileContent
            }
          }
        });
        const res = await fetch(`https://api.github.com/gists/${gistId}`, {
          method: 'PATCH',
          headers,
          body
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Update failed (${res.status}): ${errText}`);
        }
        status('Gist backup updated successfully.');
      }

      await DB.gcTombstones();                                  // expire old deletion markers
      await DB.setMeta('lastSyncAt', new Date().toISOString()); // device-local (LOCAL_META)
      status('Sync completed successfully!');
      return { success: true };
    } catch (err) {
      console.error(err);
      status(`Sync failed: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      _inFlight = false;
    }
  }

  // Background sync: silent, online-gated, debounced. Called on app launch,
  // on return to foreground, and (with force) right after a save.
  let _lastAuto = 0;
  const AUTO_MIN_GAP_MS = 60000;
  async function auto(opts) {
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return { success: false, error: 'offline' };
      }
      if (!(opts && opts.force) && Date.now() - _lastAuto < AUTO_MIN_GAP_MS) {
        return { success: false, error: 'debounced' };
      }
      const token = await DB.getMeta('githubToken');
      if (!token) return { success: false, error: 'No token' };
      _lastAuto = Date.now();
      return await run();
    } catch (e) {
      return { success: false, error: String(e && e.message) };
    }
  }

  Sync.saveToken = saveToken;
  Sync.disconnect = disconnect;
  Sync.run = run;
  Sync.auto = auto;

  root.Sync = Sync;
  if (typeof module !== 'undefined' && module.exports) module.exports = Sync;
})(typeof self !== 'undefined' ? self : this);

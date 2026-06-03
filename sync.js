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
      meta: mergeMeta(local.meta || [], remote.meta || [])
    };
  }

  function mergeByUID(arr1, arr2) {
    const map = new Map();
    arr1.forEach(item => map.set(item.id, item));
    arr2.forEach(item => map.set(item.id, item));
    return Array.from(map.values());
  }

  function mergeMeta(arr1, arr2) {
    // metadata keys are unique; merge and resolve conflicts using remote value
    const map = new Map();
    arr1.forEach(item => map.set(item.key, item));
    arr2.forEach(item => map.set(item.key, item));
    return Array.from(map.values());
  }

  async function run(onStatus) {
    const status = (msg) => { console.log('[Sync]', msg); onStatus && onStatus(msg); };
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
          const file = gist.files && gist.files['finger-trainer-sync.json'];
          if (file && file.content) {
            try {
              remoteData = JSON.parse(file.content);
              status('Remote data fetched successfully.');
            } catch (e) {
              console.error('Gist parse error:', e);
              status('Gist JSON was corrupt. Overwriting.');
            }
          }
        }
      }

      // 2. Merge local and remote data
      let mergedData;
      if (remoteData) {
        status('Merging local and remote entries...');
        mergedData = mergeDatabases(localData, remoteData);
        status('Applying merged database locally...');
        await DB.importBackup(mergedData);
      } else {
        status('Using local database as source...');
        mergedData = localData;
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

      status('Sync completed successfully!');
      return { success: true };
    } catch (err) {
      console.error(err);
      status(`Sync failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  Sync.saveToken = saveToken;
  Sync.disconnect = disconnect;
  Sync.run = run;

  root.Sync = Sync;
  if (typeof module !== 'undefined' && module.exports) module.exports = Sync;
})(typeof self !== 'undefined' ? self : this);

/* qa/fuzz_run.js — parent orchestrator: spawns fuzz_drive.js batches with a
 * per-batch watchdog; a hung batch is killed and the offending seed (last
 * "SEED n start" line) recorded as a `hang` finding. Node-only test infra.
 *   node fuzz_run.js <startSeed> <totalCount> <batchSize> <findingsFile>   */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const start = parseInt(process.argv[2] || '0', 10);
const total = parseInt(process.argv[3] || '300', 10);
const batch = parseInt(process.argv[4] || '50', 10);
const out = process.argv[5] || path.join(__dirname, 'findings.jsonl');
const BATCH_TIMEOUT = 120000;

function runBatch(s, n) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fuzz_drive.js'), String(s), String(n), out],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastSeed = null, log = '';
    child.stdout.on('data', (d) => {
      log += d;
      const m = String(d).match(/SEED (\d+) start(?![\s\S]*SEED)/);
      const all = log.match(/SEED (\d+) start/g);
      if (all) lastSeed = parseInt(all[all.length - 1].match(/\d+/)[0], 10);
    });
    child.stderr.on('data', (d) => { log += d; });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      fs.appendFileSync(out, JSON.stringify({ seed: lastSeed, kind: 'hang', step: 'watchdog',
        detail: 'batch killed after ' + BATCH_TIMEOUT + 'ms at seed ' + lastSeed }) + '\n');
      // resume AFTER the hung seed
      resolve({ resumeAt: lastSeed != null ? lastSeed + 1 : s + n });
    }, BATCH_TIMEOUT);
    child.on('exit', () => { clearTimeout(killer); resolve({ resumeAt: null }); });
  });
}

(async () => {
  let s = start;
  const end = start + total;
  while (s < end) {
    const n = Math.min(batch, end - s);
    process.stdout.write('batch ' + s + '..' + (s + n - 1) + ' ');
    const r = await runBatch(s, n);
    if (r.resumeAt != null) { console.log('HUNG -> resume at', r.resumeAt); s = r.resumeAt; }
    else { console.log('ok'); s += n; }
  }
  console.log('ALL DONE');
})();

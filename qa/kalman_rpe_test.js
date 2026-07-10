/* Unit + regression tests for RPE-weighted R in kalman_data.js.
   OLD = git HEAD version (scalar R), NEW = working tree. */
'use strict';
const fs = require('fs');
const cp = require('child_process');

const REPO = require('path').resolve(__dirname, '..');

function loadModule(src) {
  const w = {};
  const fn = new Function('window', 'module', src);
  fn(w, undefined);
  return w.buildKalmanTrack;
}
const newSrc = fs.readFileSync(REPO + '/kalman_data.js', 'utf8');
const oldSrc = cp.execSync('git -C ' + REPO + ' show HEAD:kalman_data.js', { encoding: 'utf8' });
const NEW = loadModule(newSrc);
const OLD = loadModule(oldSrc);

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; } else { fail++; console.log('FAIL: ' + name); }
}

// deterministic PRNG
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mkHist(seed, n, withRpe) {
  const rnd = mulberry32(seed);
  const out = [];
  let ms = Date.UTC(2026, 0, 1);
  let L = 30 + rnd() * 10;
  for (let i = 0; i < n; i++) {
    ms += (2 + Math.floor(rnd() * 5)) * 86400000;
    L += 0.15 + (rnd() - 0.5) * 0.2;
    const p = { x: new Date(ms).toISOString().slice(0, 10), y: Math.round((L + (rnd() - 0.5) * 2.4) * 10) / 10 };
    if (withRpe) p.rpe = [8, 8.5, 9, 9.5, 10][Math.floor(rnd() * 5)];
    out.push(p);
  }
  return out;
}
const strip = h => h.map(p => ({ x: p.x, y: p.y }));

// T1: no-rpe input -> NEW identical to OLD (30 random histories, incl. n=3,4 edge)
for (let s = 1; s <= 30; s++) {
  const h = mkHist(s, s < 4 ? 3 + s : 5 + (s % 20), false);
  const a = OLD(h, { horizonWeeks: 6 });
  const b = NEW(h, { horizonWeeks: 6 });
  const bb = b && JSON.parse(JSON.stringify(b));
  if (bb) { delete bb.rObs; delete bb.rpeWeighted; }
  ok(JSON.stringify(a) === JSON.stringify(bb), 'T1 regression seed ' + s);
}

// T2: uniform rpe (all @9) -> weights normalize to exactly 1 -> equals no-rpe run
for (let s = 1; s <= 10; s++) {
  const h = mkHist(100 + s, 12, false);
  const hr = h.map(p => Object.assign({}, p, { rpe: 9 }));
  const a = NEW(strip(h), {});
  const b = NEW(hr, {});
  ok(JSON.stringify(a.filtered) === JSON.stringify(b.filtered) &&
     JSON.stringify(a.forecast) === JSON.stringify(b.forecast), 'T2 uniform-rpe seed ' + s);
}

// T3: mixed rpe -> mean(rObs) == R (all valid), and R monotone decreasing in rpe
{
  const h = mkHist(7, 16, true);
  const m = NEW(h, { rpeK: 0.066 });
  const mean = m.rObs.reduce((a, b) => a + b, 0) / m.rObs.length;
  ok(Math.abs(mean - m.R) < 0.02, 'T3 mean preservation (mean ' + mean.toFixed(3) + ' vs R ' + m.R + ')');
  // group rObs by rpe of deduped history: rebuild dedupe like the module
  const by = {};
  h.forEach(p => { if (by[p.x] == null || p.y > by[p.x].y) by[p.x] = p; });
  const hh = Object.keys(by).sort().map(x => by[x]);
  const pairs = hh.map((p, i) => ({ rpe: p.rpe, r: m.rObs[i] }));
  const lo = pairs.filter(p => p.rpe <= 8.5), hi = pairs.filter(p => p.rpe >= 9.5);
  const avg = a => a.reduce((s, p) => s + p.r, 0) / a.length;
  ok(lo.length && hi.length && avg(lo) > avg(hi), 'T3 ordering: R(@<=8.5) > R(@>=9.5)');
  ok(m.rpeWeighted === true, 'T3 rpeWeighted flag');
}

// T4: junk rpe values -> no throw, finite outputs, junk treated as missing
{
  const h = mkHist(9, 10, false);
  h[0].rpe = 0; h[1].rpe = 15; h[2].rpe = NaN; h[3].rpe = '9'; h[4].rpe = null; h[5].rpe = -3;
  let m = null, threw = false;
  try { m = NEW(h, { rpeK: 0.2 }); } catch (e) { threw = true; }
  ok(!threw && m && m.filtered.every(p => isFinite(p.y)), 'T4 junk rpe no-throw/finite');
  ok(m.rObs.every(r => isFinite(r) && r > 0), 'T4 rObs finite');
  // only '9' (coerced) is valid -> weighted; w normalizes vs itself -> == R
  ok(Math.abs(m.rObs[0] - m.R) < 1e-9 && Math.abs(m.rObs[2] - m.R) < 1e-9, 'T4 junk -> base R');
}

// T5: caps — extreme mix can't exceed 2.5x / fall under 0.5x of base R
{
  const h = mkHist(11, 14, false).map((p, i) => Object.assign(p, { rpe: i % 2 ? 10 : 5 }));
  const m = NEW(h, { rpeK: 0.10 });
  // rObs and R are rounded to 0.01 for display, so allow 0.01 slack
  ok(m.rObs.every(r => r <= m.R * 2.5 + 0.011 && r >= m.R * 0.5 - 0.011), 'T5 caps enforced');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

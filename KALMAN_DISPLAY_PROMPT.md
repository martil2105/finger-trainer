# Implementation prompt — Kalman "true-strength" display (Finger Trainer / "Signal")

> **STATUS: IMPLEMENTED 2026-07-06** (kalman_data.js + kalman.js + app.js section, sw ft-v46).
> One deliberate deviation from §5: the forward fan is **asymmetric** per Martin's request —
> slope-persistence scenarios (upper = rate persists, median = gentle decay ×0.985/day,
> lower = gains stall ×0.90/day) plus a downside cap of z·σ(now) + 0.03 kg/day, because
> losing true strength while training continues is far less likely than gaining. Do not re-run
> this prompt; edit the shipped files instead.

> Paste this whole file into a fresh Fable 5 session with the `finger-trainer` repo attached.
> It is self-contained, but **read the real files before editing** — this repo changes between
> sessions, so treat every line/function reference below as "approximately here, confirm first."

---

## 1. Who you are / what the app is

You're extending **Finger Trainer** (internal name **"Signal"**), an **offline-first, zero-dependency,
vanilla-JS PWA** for hangboard finger-strength training. Flat file layout in repo root. No build step,
no framework, no npm packages ship to the client. Everything is plain ES5-ish IIFE modules that attach
to `window`.

Files you must read first, in this order:

- `cone_data.js` — the existing **display-only** projection math (`buildConeProjection`, `coneHistory`,
  `estimateDurationFactor`). **This is the pattern you will mirror.** Note its header comment: it reads
  the arrays it's handed and returns new arrays; it never touches `calc.js`, Working Maxes,
  periodization, logs, or the DB.
- `cone.js` — the existing SVG renderer (`drawStochasticCone`). Study its palette (`DEFAULT_COLORS`),
  its `ensureStyles()` injected CSS, its responsive `<svg class="cone-chart">` conventions, and its
  pointer/touch **scrubber**. You will reuse these conventions.
- `app.js` → `renderAnalytics()` (search for the comment `// ---- 3s E1RM projection cone`, currently
  ~line 894). This is where the existing cone section is built and where you'll add the new section
  **immediately after it**. Also read how `hist3`, `s5all`, `s3raw`, and `durFactor` are constructed
  just above it (search `const s5all`, ~line 734).
- `calc.js` — **read-only reference.** Do **not** modify. `Calc.e1rm`, `Calc.roundTo` etc.
- `db.js` — to understand the `logEntries` shape. **Do not touch the DB from your new code.**
- `index.html` and `sw.js` — the two wiring points.

### Data model (a Yielding `logEntry`, from a real backup)
```
{ date:'2026-07-02', type:'Yielding', hangDurationSeconds:3,
  topSetLoadKg:35, topSetRPE:9.5, e1rmKg:32.8, nextDayFeel:null, grip, sets, ... }
```
Real data volume today: **~13 Yielding sessions with `e1rmKg`** across ~3 months, irregular 2–9 day
gaps, visibly noisy (e.g. 25 → 20 → 25 → 26.6 kg) around a gentle upward trend. Design for this
regime: **sparse, noisy, irregularly sampled.**

---

## 2. What to build (one sentence)

A **new** Analytics display that runs a **local-linear-trend Kalman filter** over the same E1RM history
the cone uses, drawing (a) the **filtered "true strength" line through the noisy session dots**,
(b) a **calibrated forward forecast band**, and (c) a factual **readiness readout** ("last session vs.
your filtered trend") — added as a **sibling section directly below the existing cone, which stays
exactly as-is.**

### Non-negotiable: this does NOT replace the cone
`cone.js`, `cone_data.js`, and the existing `"E1RM projection · 3s"` section must be left **untouched
and fully working**. The two displays coexist: the cone is the simple inspectable OLS sketch; your
Kalman track is the statistical "signal-through-noise" view. Do not delete, rename, or edit them.

---

## 3. Method decision (already made — implement Kalman, not Banister)

Do **not** re-litigate this; it's settled for this data:

- **Banister fitness–fatigue** needs ~5 nonlinear params (`p*, k1, k2, τ1, τ2`) **and** a per-session
  training *dose*. With ~13 homogeneous heavy-hang sessions and no dose metric, it's unidentifiable and
  overfits. Its only real advantage — simulating a *planned* future block — is a future feature (#3),
  not a display.
- **Local-linear-trend Kalman** models one latent strength with 2 states and 1–3 noise params, is
  robust to sparse/noisy/irregular data, handles uneven gaps via `dt`, yields a **calibrated** band
  from the state covariance, and gives a **readiness residual** for free. This is the honest upgrade of
  the current heuristic cone bands and fits the app's name ("Signal").

If you later build closed-loop planning with a real dose metric, revisit Banister then. Not now.

---

## 4. Hard constraints (violating any of these fails the task)

1. **Display-only, fully isolated.** Your model is a sibling of `cone_data.js`: it takes point arrays
   in, returns arrays out. It must **never** import, read, or mutate `calc.js`, Working Maxes, load
   anchors, periodization, `logEntries`, `benchmarks`, `meta`, IndexedDB, or `sync.js`. Nothing in the
   app may consume its output except your renderer. Put this in the file header comment, like
   `cone_data.js` does.
2. **Zero dependencies.** Implement the Kalman filter **by hand** in plain JS (2×2 matrices, a few
   dozen lines). Do **not** add any library, CDN script, npm package, or WASM. Must work fully offline.
3. **No gamification, ever.** The readiness readout is a **clinical, factual** line (a number and a
   plain-language band). No score, streak, badge, gem, mascot, "level", or motivational copy.
4. **No webfonts. No emoji. No new icons.** Reuse the existing system font stack and the cone palette.
5. **Match the codebase style.** Pure IIFE module, `window`-exported, **Node-compatible export**
   (`if (typeof module !== 'undefined' && module.exports) ...`) so the test harness can require it,
   just like `calc.js`/`cone_data.js`. Inspectable, heavily commented, explain the method in a header
   block. ES5-flavoured (`var`, no optional chaining) to match surrounding files.

---

## 5. The model — local linear trend Kalman filter

State (per session, time axis = **days**):

```
x = [ L ]   L = filtered "true" E1RM level (kg)
    [ S ]   S = slope / rate of change (kg per day)
```

For a step with real gap `dt` days since the previous observation:

**Transition** `F(dt) = [[1, dt], [0, 1]]`

**Process noise** (integrated random walk driven by slope noise, spectral density `q` in kg²/day³):
```
Q(dt) = q * [[ dt^3/3, dt^2/2 ],
             [ dt^2/2, dt     ]]
```
(Optionally add a tiny level-noise term `qL * [[dt,0],[0,0]]`, default `qL = 0`. Keep it simple.)

**Observation**: measured E1RM `z`, with `H = [1, 0]` and scalar observation-noise variance `R` (kg²).

**Predict**  `x⁻ = F x`,  `P⁻ = F P Fᵀ + Q(dt)`
**Update**   innovation `y = z − L⁻`; innovation var `s = P⁻[0][0] + R`;
             gain `K = [P⁻[0][0], P⁻[1][0]]ᵀ / s`;
             `x = x⁻ + K·y`;  `P = (I − K·H) P⁻`.

Accumulate the Gaussian innovation log-likelihood `ℓ += −0.5·(log(2π·s) + y²/s)` each update — you'll use
it to fit `q`.

### Inputs / preprocessing
- Dedupe by date (**max per day**, exactly like `coneHistory`) and sort ascending. Require **≥ 3**
  points or return `null`.
- Time axis in days from the first point.

### Initialization
- Fit OLS through the first `min(5, n)` points to seed `L₀` (level at first date) and `S₀` (slope).
- Diffuse initial covariance, e.g. `P₀ = [[ 4·R, 0 ], [ 0, 0.05² ]]`.

### Parameter estimation (robust, adaptive)
- **`R` (session noise):** estimate from residual spread around a local OLS fit of the raw series —
  reuse the cone's idea: `R = max(0.4², var of OLS residuals)`. This is "how noisy is one session."
- **`q` (smoothness):** fit by a **1-D maximum-likelihood search** over a log grid
  (`q ∈ [1e-5 … 1e-1]` kg²/day³, ~25 steps), holding `R` fixed at the residual estimate; pick the `q`
  that maximizes total `ℓ`. Fall back to `q = 1e-3` if `n < 5` or the likelihood is flat.
  Result: noisy/flat data → smoother track; clear trend → more responsive. (A 2-D search that also
  tunes `R` is optional; the 1-D version with `R` from residuals is enough and more stable.)

### Outputs
Run the filter once with the chosen `(q, R)` and produce:

1. **Filtered track** — for each historical point: `{ x:iso, y: L_k, sd: sqrt(P_k[0][0]) }`. This is the
   smooth "true strength" line through the noisy dots (the distinctive new visual).
2. **Forecast** — from the final `(x_N, P_N)`, roll **predict-only** steps forward in **7-day
   increments to `horizonWeeks` (default 6 = 42 days)**, matching the cone's horizon/step. At each
   horizon `h`: propagate `P` with `F(h)`/`Q(h)`; band half-width uses **state uncertainty**
   `sqrt(P⁻[0][0])` (the *true-strength* interval). Emit the same shape the cone renderer already
   understands so it reads apples-to-apples:
   ```
   forecast = {
     median: [{x,y}],                       // y = L_N + S_N·h
     bands: [ {level:0.9, upper:[…], lower:[…]},   // z = 1.645
              {level:0.5, upper:[…], lower:[…]} ], // z = 0.674
     targets: [{x,y,hi,lo,label}]           // upcoming test dates, 90% interval
   }
   ```
   (If you want a *session* prediction interval instead of a true-strength interval, add `R` under the
   sqrt — but default to the true-strength band and say so in a comment.)
3. **Readiness** — at the last observation: standardized innovation `rz = y_N / sqrt(s_N)`:
   ```
   readiness = { last:z_N, filtered:L_N, deltaKg:z_N−L_N, sigma:rz,
                 band: |rz|<1 ? 'within normal session-to-session noise'
                       : |rz|<2 ? (rz>0?'a notably strong session':'a notably low session')
                       :          (rz>0?'an unusually strong session':'an unusually low session') }
   ```
4. Also return `{ q, R, slopePerWeek: S_N*7, n }` for the caption/notes and tests.

---

## 6. New file — `kalman_data.js` (the model)

Mirror `cone_data.js` exactly in structure and tone. Public API:

```js
window.buildKalmanTrack(histPts, opts)
// histPts: [{x:'YYYY-MM-DD', y:kg}]  (same array the cone gets — 3s-native E1RM)
// opts:    { horizonWeeks:6, tests:[{date,label}], q:<override>, R:<override> }
// returns: { filtered, forecast:{median,bands,targets}, readiness, q, R, slopePerWeek, n }  | null
```

Header comment must state, like `cone_data.js`: *display-only; reads arrays, returns arrays; never
touches calc.js / WMs / periodization / logs / DB; nothing consumes it but the renderer.* Add the
Node/`module.exports` tail so the harness can require it.

---

## 7. New file — `kalman.js` (the renderer)

A read-only SVG layer in the **same visual language as `cone.js`** (reuse its palette keys, its
`ensureStyles`-style single injected `<style>`, `svg.cone-chart` responsive sizing, tabular-nums, and
the pointer/touch scrubber pattern). Public API:

```js
window.drawKalmanTrack(histPts, model, container, options)  // -> <svg> or null
```

Draw, back to front:
- gridlines + y ticks (same "nice step" logic as the cone);
- the **raw session dots** (blue, hollow-outlined like the cone's nodes);
- the **filtered "true strength" line** running *through* the dots — solid, confident, `C.blueDeep`,
  with a thin translucent **±1σ ribbon** (`model.filtered[i].sd`) around it. This line through history
  is the point of the display and is what visually distinguishes it from the forward-only cone;
- a **NOW divider** (reuse the cone's NOW pill) where history ends;
- the **forward forecast fan** — render it as a **neutral blue confidence fan** (widest band most
  transparent), *not* the cone's green/red adaptation-vs-fatigue split, so the two displays read as
  different things (Kalman = symmetric statistical CI; cone = asymmetric narrative);
- optional benchmark **target rings** (reuse the cone's amber ring) if `model.forecast.targets` present;
- the **scrubber** (optional but preferred — lift it from `cone.js`): tooltip shows, for history,
  `logged z / filtered L / ±σ`, and for the forecast, `projected median + 90% band`.

Keep the caller's arrays immutable (copy + sort inside, like the cone). Repeated calls replace the
previous SVG in the container.

---

## 8. Integration — `app.js` `renderAnalytics()`

Add a **new section right after** the existing cone block (after `view.appendChild(coneCard)` /
its closing braces). **Reuse the exact same `hist3` array the cone built** — do not recompute the
duration conversion; if `hist3` is scoped tightly, hoist it minimally or recompute identically. Guard
it the same way the cone is guarded:

```js
// ---- Filtered strength (Kalman) — sibling of the cone, display-only ----
view.appendChild(el('h2', null, ['Filtered strength · 3s']));
if (typeof drawKalmanTrack !== 'function' || typeof buildKalmanTrack !== 'function') {
  view.appendChild(el('div', { class: 'card' }, ['Filtered-strength layer not loaded.']));
} else if (hist3.length < 3) {
  view.appendChild(el('div', { class: 'card' }, ['Log at least three Yielding sessions to filter a trend.']));
} else {
  var kmodel = buildKalmanTrack(hist3, { horizonWeeks: 6, tests: tests });   // reuse `tests` from the cone block
  if (!kmodel) {
    view.appendChild(el('div', { class: 'card' }, ['Not enough signal to filter yet.']));
  } else {
    var kCard = el('div', { class: 'card' });
    drawKalmanTrack(hist3, kmodel, kCard, { unit: 'kg', todayX: todayISO() });
    var r = kmodel.readiness;
    var trend = (kmodel.slopePerWeek >= 0 ? '+' : '−') + Math.abs(Math.round(kmodel.slopePerWeek * 10) / 10);
    kCard.appendChild(el('p', { class: 'card-title', style: 'margin:10px 0 0;font-size:13px' },
      ['Filtered ' + Math.round(kmodel.filtered[kmodel.filtered.length-1].y*10)/10 + ' kg · trend ' + trend +
       ' kg/wk. Last session ' + (r.deltaKg>=0?'+':'−') + Math.abs(Math.round(r.deltaKg*10)/10) +
       ' kg (' + (Math.round(r.sigma*10)/10) + 'σ) — ' + r.band + '.']));
    kCard.appendChild(el('p', { class: 'card-note' },
      ['Kalman-filtered true strength (signal separated from session noise). ' +
       'Blue line = filtered strength · ribbon = ±1σ · fan = forward 50/90% confidence. ' +
       'Display only — does not affect anchors or WMs.']));
    view.appendChild(kCard);
  }
}
```

Adjust variable names to match what's actually in scope (`hist3`, `tests`, `el`, `todayISO`). **Do not
change the cone code above it.** Keep the readiness copy factual — no motivational language.

---

## 9. Wiring

- **`index.html`** — add two `<script>` tags next to the cone scripts, **before** `app.js`:
  ```html
  <script src="cone_data.js"></script>
  <script src="cone.js"></script>
  <script src="kalman_data.js"></script>   <!-- new -->
  <script src="kalman.js"></script>        <!-- new -->
  <script src="app.js"></script>
  ```
- **`sw.js`** — bump the cache constant **`ft-v45` → `ft-v46`** and add `'./kalman_data.js'` and
  `'./kalman.js'` to the `ASSETS` array. (Missing this = the new files won't cache and offline breaks.)

---

## 10. Testing (required before you call it done)

The repo verifies UI/data via a **jsdom + fake-indexeddb harness** (see `outputs/render_test.js`; deps
live in `/tmp/harness`). Do the same:

1. **Unit — model correctness** (`require('../kalman_data.js')` style, headless): on a **synthetic
   noisy linear ramp** (known slope + Gaussian noise), assert:
   - filtered final slope ≈ true slope (within tolerance);
   - filtered series variance **< raw series variance** (it actually smooths);
   - forecast bands widen monotonically with horizon and 50% ⊂ 90%;
   - `readiness.sigma` ≈ 0 when the last point sits on the trend, large when it's an injected outlier;
   - degenerate inputs (`<3` pts, all same day, all identical y) return `null` or a safe object, no throw.
2. **Real data**: load the attached backup's 13 Yielding E1RM points (build `hist3` the same way the app
   does — 3s raw via `Calc.e1rm(load,rpe,5)`, 5s ×`durFactor`), run `buildKalmanTrack`, and sanity-check
   the filtered endpoint (~32–33 kg) and a small positive `slopePerWeek`.
3. **Render smoke**: in jsdom, `drawKalmanTrack` appends one `<svg class="cone-chart">` to a container,
   no exceptions, replaces cleanly on a second call.
4. **Isolation check**: grep your two new files — they must contain **no** reference to `Calc.` (beyond
   nothing, ideally), `DB`, `Sync`, `WorkingMax`, anchors, or `localStorage`. Confirm the existing cone
   section still renders unchanged.

---

## 11. Acceptance criteria (checklist)

- [ ] `kalman_data.js` + `kalman.js` added; hand-rolled filter, **zero new dependencies**.
- [ ] Existing cone (`cone.js`, `cone_data.js`, `"E1RM projection · 3s"` section) **unchanged and still
      rendering**.
- [ ] New **"Filtered strength · 3s"** section renders directly below the cone, consuming the **same
      `hist3`**, with: filtered line through the dots, ±1σ ribbon, neutral-blue forward fan, factual
      readiness line.
- [ ] Model is **display-only** and provably isolated (isolation grep passes).
- [ ] `q` fit by MLE with `R` from residuals; sensible fallbacks; no throws on sparse/degenerate data.
- [ ] `index.html` script tags added; `sw.js` bumped to `ft-v46` with both files cached.
- [ ] Constraints honored: no gamification, no webfonts, no emoji/new icons, ES5-style vanilla JS.
- [ ] jsdom tests above pass; app still works offline.

---

## 12. Notes / gotchas

- The repo has a strong "**display-only, inspectable, commented**" culture — match it. `cone_data.js`
  is your template for header tone and isolation discipline.
- Martin trains **3s hangs** now; the cone (and therefore your display) works in **native 3s E1RM
  units**, with historical 5s sessions converted up by `durFactor` (`estimateDurationFactor`). You
  inherit this for free by reusing `hist3` — **do not re-derive it.**
- Keep the forecast horizon/step **identical to the cone** (6 weeks, 7-day steps) so the two charts
  line up visually.
- If in doubt on a visual choice, make the Kalman display *quieter and more clinical* than the cone —
  its job is to show the signal, not to sell a story.
```

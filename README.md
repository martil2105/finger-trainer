# Finger Trainer

An offline-first, progressive web app (PWA) hangboard finger-strength training coach and logger. Designed for rock climbers looking to systematically monitor and develop their contact strength using advanced autoregulated training cycles.

![Finger Trainer Logo](icons/icon-192.png)

## Key Features

- **🏆 Autoregulated Training Cycles**: Seeds pre-built cycles such as `Trans I–II + Peak (5s→3s)` and `Acc → Trans → Peak (7s→5s→3s)` detailing weeks of Accumulation, Transmutation, Peak Intensity, Deload, and Realization.
- **⏱️ Hands-Free Timer Runner**: Voice-assisted and tone-guided interactive workout runner. Equipped with Wake Lock to keep your screen awake while hangs and rest countdowns execute.
- **🧠 Interactive Training Rules**:
  - **Heavy Session Fatigue Stops**: Reminds and monitors the 4 main triggers to end back-offs (unable to hold full 5s, load drop >5% to stay @8, early grip break, or joint discomfort).
  - **Volume Session RPE Creep**: If RPE creeps to `@8.5+` on the 3rd set, the runner prompts you to drop your load by 5% and automatically scales the weight for remaining sets.
- **📊 Premium SVG Analytics**: Built-in visual charts rendering E1RM trends (5s-normalized), weekly volume sets, next-day recovery status, and detailed benchmark test history.
- **📋 Direct Cycle Logging**: Browse upcoming or historical week workouts in the **Program** tab and launch/log any session instantly.
- **💾 Full Data Control**: Supports manual logging, history filtering, full database resetting, CSV exports, and offline spreadsheet import integration.

## Technical Architecture

Built purely as a lightweight, zero-dependency, vanilla frontend application utilizing standard web APIs:

- **HTML5**: Structured semantic layout (`index.html`).
- **CSS3 (Vanilla)**: Glassmorphism cards, dark neon color variables, and fluid responsive layouts (`style.css`).
- **JavaScript (ES6+)**: Core client-side modules:
  - `app.js`: Client-side tab router, UI rendering shell, and settings managers.
  - `timer.js`: Session runner state-machine (PREP → HANG → LOG_SET → REST → END) with Web Speech & Web Audio synthesis.
  - `calc.js`: Training math (E1RM estimation, anchor loads, recovery index, and cycle periodization guardrails). Exposes Node-compatible exports for easy test integration.
  - `db.js`: Local IndexedDB client wrapper.
  - `builder.js`: Dynamic cycle constructor and template editor.
  - `templates.js`: Structured template definitions and seeded spreadsheet history imports.
- **Service Worker (`sw.js`)**: Configures caching policies to enable 100% offline standalone usage on mobile and desktop devices.

## How to Run

Because the application is built entirely on vanilla web standards, it has zero compilation or build dependencies.

### Local Development
To view the app, serve the directory using any basic HTTP server:

```bash
# Using Python
python3 -m http.server 8000

# Using Node.js
npx serve .
```

Then visit `http://localhost:8000` (or the port specified) in your browser.

### Mobile Installation (PWA)
1. Serve the app over HTTPS (or access via localhost/local IP on your local network).
2. Open the page in **Safari (iOS)** or **Chrome (Android)**.
3. Tap **Share** (iOS) or the menu icon (Android) and select **Add to Home Screen**.
4. The app will launch as a standalone, fullscreen utility that works completely offline.

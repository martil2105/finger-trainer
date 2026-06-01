// Finger Trainer PWA - Core Application Logic

// Seed Program Data
const PROGRAM_WEEKS = [
  { week: 1, block: "Trans I", blockKey: "trans1", heavyRpe: "8.5", heavyDur: 5, protocol: "topSetPlusBackoffs", volPct: 0.82, volSets: "4-5", volDur: 5, isTest: false, isDeload: false },
  { week: 2, block: "Trans I", blockKey: "trans1", heavyRpe: "8.5-9", heavyDur: 5, protocol: "topSetPlusBackoffs", volPct: 0.83, volSets: "4-5", volDur: 5, isTest: false, isDeload: false },
  { week: 3, block: "Trans I", blockKey: "trans1", heavyRpe: "9.0", heavyDur: 5, protocol: "topSetPlusBackoffs", volPct: 0.84, volSets: "4-5", volDur: 5, isTest: false, isDeload: false },
  { week: 4, block: "Trans I", blockKey: "trans1", heavyRpe: "9.0", heavyDur: 5, protocol: "topSetPlusBackoffs", volPct: 0.85, volSets: "4-5", volDur: 5, isTest: false, isDeload: false },
  
  { week: 5, block: "Deload + Test", blockKey: "test", heavyRpe: "test", heavyDur: 5, protocol: "testProtocol", volPct: 0, volSets: "0", volDur: 0, isTest: true, isDeload: true },
  
  { week: 6, block: "Trans II", blockKey: "trans2", heavyRpe: "9.0-9.5", heavyDur: 5, protocol: "topSetPlusBackoffs", volPct: 0.86, volSets: "4-5", volDur: 5, isTest: false, isDeload: false },
  { week: 7, block: "Trans II", blockKey: "trans2", heavyRpe: "9.0-9.5", heavyDur: 5, protocol: "topSetPlusBackoffs", volPct: 0.87, volSets: "4-5", volDur: 5, isTest: false, isDeload: false },
  { week: 8, block: "Trans II", blockKey: "trans2", heavyRpe: "9.0-9.5", heavyDur: 5, protocol: "topSetPlusBackoffs", volPct: 0.87, volSets: "4-5", volDur: 5, isTest: false, isDeload: false },
  { week: 9, block: "Trans II", blockKey: "trans2", heavyRpe: "9.0-9.5", heavyDur: 5, protocol: "topSetPlusBackoffs", volPct: 0.88, volSets: "4-5", volDur: 5, isTest: false, isDeload: false },
  
  { week: 10, block: "Deload + Test", blockKey: "test", heavyRpe: "test", heavyDur: "5+3", protocol: "testProtocol", volPct: 0, volSets: "0", volDur: 0, isTest: true, isDeload: true },
  
  { week: 11, block: "Peak", blockKey: "peak", heavyRpe: "9.5", heavyDur: 3, protocol: "maxSingles", volPct: 0.80, volSets: "3-4", volDur: 5, isTest: false, isDeload: false },
  { week: 12, block: "Peak", blockKey: "peak", heavyRpe: "9.5", heavyDur: 3, protocol: "maxSingles", volPct: 0.80, volSets: "3-4", volDur: 5, isTest: false, isDeload: false },
  { week: 13, block: "Peak", blockKey: "peak", heavyRpe: "9.5", heavyDur: 3, protocol: "maxSingles", volPct: 0.81, volSets: "3-4", volDur: 5, isTest: false, isDeload: false },
  { week: 14, block: "Peak", blockKey: "peak", heavyRpe: "9.5", heavyDur: 3, protocol: "maxSingles", volPct: 0.82, volSets: "3-4", volDur: 5, isTest: false, isDeload: false },
  
  { week: 15, block: "Deload + Final", blockKey: "test", heavyRpe: "test", heavyDur: "5+3", protocol: "testProtocol", volPct: 0, volSets: "0", volDur: 0, isTest: true, isDeload: true },
  { week: 16, block: "Realization", blockKey: "real", heavyRpe: "9.0", heavyDur: "3/5", protocol: "fixedVolume", volPct: 0.80, volSets: "2", volDur: 5, isTest: false, isDeload: false }
];

// Database Manager (LocalStorage wrapper)
const db = {
  get: (key, fallback) => {
    const val = localStorage.getItem(`ft_${key}`);
    return val ? JSON.parse(val) : fallback;
  },
  set: (key, val) => {
    localStorage.setItem(`ft_${key}`, JSON.stringify(val));
  }
};

// Global App State
const state = {
  currentTab: "today",
  cycleStartDate: null,
  bodyweightTrack: false,
  bodyweightDefault: 75.0,
  restDuration: 300,
  audioSpeech: true,
  hapticFeedback: true,
  wmHistory: [], // Working Max Entries: {id, duration, valueKg, date, source, notes}
  logs: [], // Log Entries: {id, date, weekNumber, block, type, role, hangDurationSeconds, grip, edgeMm, sets: [{loadKg, rpe, durationSeconds, completed}], taxing, feltStrong, nextDayFeel, notes, e1rmKg}
  benchmarks: [], // Benchmark Entries: {id, date, durationSeconds, maxLoadKg, rpe, resultingWMid}
  activeChart: "e1rm"
};

// Math Utilities
function roundToNearestHalf(val) {
  return Math.round(val * 2) / 2;
}

function calculateE1RM(loadKg, rpe) {
  if (rpe < 6) return null;
  return Math.round((loadKg * 100 / (40 + 6 * rpe)) * 10) / 10;
}

function calculateHeavyTopAnchor(wm, targetRPE) {
  return roundToNearestHalf( wm * (40 + 6 * targetRPE) / 97 );
}

function calculateVolumeAnchor(heavyTopAnchor, volumePct) {
  return roundToNearestHalf( heavyTopAnchor * volumePct );
}

function calculateBackoffAnchor(heavyTopAnchor) {
  return roundToNearestHalf( heavyTopAnchor * 0.82 );
}

function calculateDeloadAnchor(wm) {
  return roundToNearestHalf( wm * 0.75 );
}

// Get Working Max for duration on a specific date (default is current)
function getWorkingMaxAt(duration, dateStr = null) {
  const targetDate = dateStr ? new Date(dateStr) : new Date();
  
  // Filter for matching duration
  const matches = state.wmHistory
    .filter(wm => Number(wm.durationSeconds) === Number(duration))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  
  if (matches.length === 0) {
    return duration === 5 ? 50 : 60; // Seed defaults if none exists
  }
  
  // Find the latest one that is <= targetDate
  let activeWM = matches[0].valueKg;
  for (let wm of matches) {
    if (new Date(wm.date) <= targetDate) {
      activeWM = wm.valueKg;
    } else {
      break;
    }
  }
  return activeWM;
}

// Add new Working Max entry
function addWorkingMax(duration, valueKg, source = "manualEdit", date = null, notes = "") {
  const newWM = {
    id: "wm_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
    durationSeconds: Number(duration),
    valueKg: Number(valueKg),
    date: date || new Date().toISOString().split("T")[0],
    source: source,
    notes: notes
  };
  state.wmHistory.push(newWM);
  db.set("wmHistory", state.wmHistory);
  return newWM;
}

// Check Recovery Signal
function checkRecoveryStatus() {
  const nextDayFeels = state.logs
    .filter(log => log.nextDayFeel !== undefined && log.nextDayFeel !== null)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(log => log.nextDayFeel);
    
  if (nextDayFeels.length === 0) return false;
  
  const latest = nextDayFeels[nextDayFeels.length - 1];
  if (latest <= 2) return true;
  
  if (nextDayFeels.length >= 3) {
    const rollingAverages = [];
    for (let i = 2; i < nextDayFeels.length; i++) {
      const avg = (nextDayFeels[i] + nextDayFeels[i-1] + nextDayFeels[i-2]) / 3;
      rollingAverages.push(avg);
    }
    
    if (rollingAverages.length > 0) {
      const currentAvg = rollingAverages[rollingAverages.length - 1];
      const pastAverages = rollingAverages.slice(-10);
      const maxAvg = Math.max(...pastAverages);
      if (maxAvg - currentAvg >= 1.0) {
        return true;
      }
    }
  }
  return false;
}

// Date helper: get week index (1-16) and day (0-6) from cycle start date
function getTrainingPosition(date = new Date()) {
  if (!state.cycleStartDate) return { week: 1, dayOfWeek: 1, daysToNextTest: 0 };
  
  const start = new Date(state.cycleStartDate);
  const current = new Date(date);
  
  // Reset hours to align days
  start.setHours(0,0,0,0);
  current.setHours(0,0,0,0);
  
  const diffTime = current - start;
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  
  // Calculate current week (1-indexed)
  let week = Math.floor(diffDays / 7) + 1;
  if (week < 1) week = 1;
  if (week > 16) week = 16;
  
  const dayOfWeek = current.getDay(); // 0 = Sunday, 1 = Monday, 2 = Tuesday, etc.
  
  // Calculate days to next test week (Weeks 5, 10, 15 are test weeks)
  let nextTestWeek = 5;
  if (week > 5 && week <= 10) nextTestWeek = 10;
  if (week > 10) nextTestWeek = 15;
  
  let daysToNextTest = 0;
  if (week < nextTestWeek) {
    const testWeekStart = new Date(start);
    testWeekStart.setDate(start.getDate() + (nextTestWeek - 1) * 7);
    const testDiff = testWeekStart - current;
    daysToNextTest = Math.ceil(testDiff / (1000 * 60 * 60 * 24));
  } else if (week === nextTestWeek) {
    // It is test week! Find Saturday (day 6) of this week
    const satOffset = 6 - dayOfWeek;
    daysToNextTest = satOffset >= 0 ? satOffset : 0;
  }
  
  return { week, dayOfWeek, daysToNextTest };
}

// Seed Initial Data
function initDatabase() {
  // 1. Settings
  state.cycleStartDate = db.get("cycleStartDate", "2026-05-11");
  state.bodyweightTrack = db.get("bodyweightTrack", false);
  state.bodyweightDefault = db.get("bodyweightDefault", 75.0);
  state.restDuration = db.get("restDuration", 300);
  state.audioSpeech = db.get("audioSpeech", true);
  state.hapticFeedback = db.get("hapticFeedback", true);
  
  // 2. Working Maxes
  state.wmHistory = db.get("wmHistory", []);
  if (state.wmHistory.length === 0) {
    // Seed default WM history starting W1
    addWorkingMax(5, 50.0, "manualEdit", "2026-05-11", "Initial seed");
    addWorkingMax(3, 60.0, "manualEdit", "2026-05-11", "Initial seed");
  }
  
  // 3. Logs
  state.logs = db.get("logs", []);
  
  // 4. Benchmarks
  state.benchmarks = db.get("benchmarks", []);
}

// UI Controllers
function switchTab(tabId) {
  state.currentTab = tabId;
  
  // Toggle Active Panel
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.getElementById(`tab-${tabId}`).classList.add("active");
  
  // Toggle Tab Bar Button
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelector(`.tab-btn[data-tab="${tabId}"]`).classList.add("active");
  
  // Refresh content
  if (tabId === "today") renderTodayTab();
  if (tabId === "program") renderProgramTab();
  if (tabId === "analytics") renderAnalyticsTab();
  if (tabId === "history") renderHistoryTab();
  if (tabId === "settings") renderSettingsTab();
}

// Today Tab Controller
function renderTodayTab() {
  const { week, dayOfWeek, daysToNextTest } = getTrainingPosition();
  const currentWeekData = PROGRAM_WEEKS.find(w => w.week === week) || PROGRAM_WEEKS[0];
  
  // Set global header pill
  const headerPill = document.getElementById("header-cycle-pill");
  headerPill.querySelector(".pill-week").textContent = `W${week}`;
  headerPill.querySelector(".pill-block").textContent = currentWeekData.block;
  
  // Display Mini Widgets
  document.getElementById("mini-wm-5").textContent = `${getWorkingMaxAt(5)} kg`;
  document.getElementById("mini-wm-3").textContent = `${getWorkingMaxAt(3)} kg`;
  
  // Handle test week phrasing
  if (currentWeekData.isTest && dayOfWeek === 6) {
    document.getElementById("mini-days-test").textContent = `TODAY!`;
  } else {
    document.getElementById("mini-days-test").textContent = `${daysToNextTest}d`;
  }

  // Recovery Alert banner display
  const recoveryBanner = document.getElementById("recovery-banner");
  if (checkRecoveryStatus()) {
    recoveryBanner.classList.remove("hidden");
  } else {
    recoveryBanner.classList.add("hidden");
  }

  // Determine Daily Prescription
  // Tue = OI Primer (2)
  // Thu = Volume Yielding (4)
  // Sat = Heavy Hang / Test (6)
  // Others = Rest
  
  let roleTitle = "Rest / Easy Climbing";
  let roleDesc = "Recovery & transfer to climbing movement";
  let setsText = "--";
  let durText = "--";
  let rpeText = "--";
  let showAnchors = false;
  let topSetAnchor = 0;
  let backoffAnchor = 0;
  let hasBackoffs = false;

  const wm5 = getWorkingMaxAt(5);
  const wm3 = getWorkingMaxAt(3);

  if (dayOfWeek === 2) {
    // Tuesday: OI Primer
    roleTitle = "OI Primer + Board Climbing";
    roleDesc = "3-4 max isometric squeezes (~5s), full rest, then Board Limit Climbing. (No weighted hangs)";
    setsText = "3-4";
    durText = "5s";
    rpeText = "@Max";
  } else if (dayOfWeek === 4) {
    // Thursday: Volume Day
    roleTitle = "Volume Day";
    roleDesc = "5s hangs, fixed sets, no extensions. Autoregulated around target RPE.";
    setsText = currentWeekData.volSets;
    durText = `${currentWeekData.volDur}s`;
    rpeText = "@7-8";
    showAnchors = true;
    
    // Anchor math
    const heavyTop = calculateHeavyTopAnchor(wm5, currentWeekData.isTest ? 9 : parseFloat(currentWeekData.heavyRpe) || 9);
    topSetAnchor = calculateVolumeAnchor(heavyTop, currentWeekData.volPct);
  } else if (dayOfWeek === 6) {
    // Saturday: Heavy Hang / Test Day
    if (currentWeekData.isTest) {
      roleTitle = "Benchmark Test Day";
      if (week === 5) {
        roleDesc = "Guided 5s Max-Hang Benchmark Test to calibrate Working Max.";
        setsText = "Test";
        durText = "5s";
        rpeText = "@9-9.5";
      } else {
        roleDesc = "Dual Benchmark: Perform 5s Test first, then 3s Test.";
        setsText = "Dual";
        durText = "5s + 3s";
        rpeText = "@9-9.5";
      }
    } else {
      roleTitle = "Heavy Hang Day";
      if (currentWeekData.blockKey === "peak") {
        roleDesc = "3s Max Singles. Low fatigue, pure neural recruitment.";
        setsText = "3-5";
        durText = "3s";
        rpeText = `@${currentWeekData.heavyRpe}`;
        showAnchors = true;
        topSetAnchor = calculateHeavyTopAnchor(wm3, parseFloat(currentWeekData.heavyRpe));
      } else {
        roleDesc = "5s Top Set + Back-off sets.";
        setsText = currentWeekData.volSets === "2" ? "2-3" : "1 + 2-3";
        durText = "5s";
        rpeText = `@${currentWeekData.heavyRpe}`;
        showAnchors = true;
        
        const rpeVal = parseFloat(currentWeekData.heavyRpe.split("-")[0]) || 9.0;
        topSetAnchor = calculateHeavyTopAnchor(wm5, rpeVal);
        backoffAnchor = calculateBackoffAnchor(topSetAnchor);
        hasBackoffs = true;
      }
    }
  }

  // Populate Today view
  document.getElementById("today-workout-title").textContent = roleTitle;
  document.getElementById("today-workout-description").textContent = roleDesc;
  
  document.getElementById("today-prescribe-sets").textContent = setsText;
  document.getElementById("today-prescribe-dur").textContent = durText;
  document.getElementById("today-prescribe-rpe").textContent = rpeText;
  
  const card = document.getElementById("today-card");
  const backoffRow = document.getElementById("today-backoff-row");
  const topAnchorEl = document.getElementById("today-anchor-top");
  const backoffAnchorEl = document.getElementById("today-anchor-backoff");
  
  if (showAnchors) {
    card.classList.remove("hidden");
    topAnchorEl.textContent = `${topSetAnchor} kg`;
    if (hasBackoffs) {
      backoffRow.classList.remove("hidden");
      backoffAnchorEl.textContent = `${backoffAnchor} kg`;
    } else {
      backoffRow.classList.add("hidden");
    }
  } else {
    // Show cards even for rest/OI to let them log manually or run the timer
    // but without specific anchor load section.
    if (dayOfWeek === 2 || currentWeekData.isTest) {
      card.classList.remove("hidden");
      topAnchorEl.closest(".card-section").classList.add("hidden");
    } else {
      card.classList.remove("hidden"); // Let them start rest/easy logs
      topAnchorEl.closest(".card-section").classList.add("hidden");
      // Add custom rest text
      roleDesc = "Rest Day. Go easy, let the tendons recover.";
      document.getElementById("today-workout-description").textContent = roleDesc;
    }
  }
  
  if (!showAnchors) {
    const section = topAnchorEl.closest(".card-section");
    if (section) section.classList.add("hidden");
  } else {
    const section = topAnchorEl.closest(".card-section");
    if (section) section.classList.remove("hidden");
  }
}

// Program Tab Controller
function renderProgramTab() {
  const { week } = getTrainingPosition();
  const grid = document.getElementById("program-weeks-grid");
  grid.innerHTML = "";
  
  PROGRAM_WEEKS.forEach(w => {
    const isCurrent = w.week === week;
    
    // Check if logged in this week
    const isCompleted = state.logs.some(log => Number(log.weekNumber) === w.week);
    
    const card = document.createElement("div");
    card.className = `week-card glass ${isCurrent ? 'current' : ''} ${isCompleted ? 'completed' : ''}`;
    
    let protocolDesc = "";
    if (w.isTest) {
      protocolDesc = w.week === 5 ? "5s Test" : "5s & 3s Test";
    } else {
      protocolDesc = `${w.heavyDur}s @${w.heavyRpe} • Vol ${w.volSets} sets`;
    }

    let badgeClass = `badge-${w.blockKey}`;
    
    card.innerHTML = `
      <div class="week-left">
        <div class="week-badge">${w.week}</div>
        <div class="week-details">
          <h4>${w.isTest ? 'Deload & Calibrate' : w.block + ' Phase'}</h4>
          <p>${protocolDesc}</p>
        </div>
      </div>
      <div class="week-info">
        <span class="week-block-badge ${badgeClass}">${w.block}</span>
        <div class="week-target-load">${w.isTest ? 'TEST WEEK' : 'Vol %: ' + Math.round(w.volPct * 100) + '%'}</div>
      </div>
    `;
    grid.appendChild(card);
  });
}

// History Tab Controller
function renderHistoryTab() {
  const container = document.getElementById("history-logs-list");
  container.innerHTML = "";
  
  const searchVal = document.getElementById("history-search").value.toLowerCase();
  const filterRole = document.getElementById("history-filter-role").value;
  
  const filtered = state.logs
    .filter(log => {
      const matchSearch = (log.notes || "").toLowerCase().includes(searchVal);
      const matchRole = filterRole === "all" || log.role === filterRole;
      return matchSearch && matchRole;
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date)); // newest first
    
  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No workouts found matching filters.</p>
      </div>
    `;
    return;
  }
  
  filtered.forEach(log => {
    const card = document.createElement("div");
    card.className = "log-card glass";
    
    // Formatting metrics
    const setsCompleted = log.sets ? log.sets.length : 0;
    const maxSet = log.sets && log.sets.length > 0 
      ? log.sets.reduce((max, s) => s.loadKg > max.loadKg ? s : max, log.sets[0])
      : { loadKg: 0, rpe: 0 };
      
    const e1rmVal = log.e1rmKg ? `${log.e1rmKg} kg` : "--";
    
    card.innerHTML = `
      <div class="log-card-header">
        <div>
          <h4>W${log.weekNumber} - ${log.role === 'OIprimer' ? 'OI Primer' : log.role + ' Session'}</h4>
          <span class="log-date">${log.date}</span>
          <div class="log-badge-row">
            <span class="log-pill ${log.role.toLowerCase()}">${log.role}</span>
            <span class="log-pill deload">${log.hangDurationSeconds || 5}s hangs</span>
          </div>
        </div>
        <div class="log-actions">
          <button class="log-action-btn edit-log-btn" data-id="${log.id}">Edit</button>
          <button class="log-action-btn delete delete-log-btn" data-id="${log.id}">Delete</button>
        </div>
      </div>
      
      ${log.role !== 'OIprimer' && log.role !== 'Climb' ? `
        <div class="log-metrics-grid">
          <div class="log-metric-item">
            <span class="log-metric-val">${maxSet.loadKg} kg</span>
            <span class="log-metric-lbl">Max Load</span>
          </div>
          <div class="log-metric-item">
            <span class="log-metric-val">@${maxSet.rpe}</span>
            <span class="log-metric-lbl">Felt RPE</span>
          </div>
          <div class="log-metric-item">
            <span class="log-metric-val">${e1rmVal}</span>
            <span class="log-metric-lbl">Est. 1RM</span>
          </div>
        </div>
      ` : ''}

      ${log.sets && log.sets.length > 0 ? `
        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">
          <strong>Sets:</strong> ${log.sets.map((s, idx) => `S${idx+1}: ${s.loadKg}kg @${s.rpe} (${s.completed ? '✓' : '✗'})`).join(', ')}
        </div>
      ` : ''}
      
      ${log.notes ? `<p class="log-notes">"${log.notes}"</p>` : ''}
      
      <div style="display: flex; gap: 12px; font-size: 11px; color: var(--text-tertiary); margin-top: 4px;">
        <span>Taxing: ${log.taxing || '--'}/5</span>
        <span>Strength: ${log.feltStrong || '--'}/10</span>
        ${log.nextDayFeel ? `<span>Recovery Feel: ${log.nextDayFeel}/5</span>` : ''}
      </div>
    `;
    container.appendChild(card);
  });
  
  // Wire up action buttons
  container.querySelectorAll(".delete-log-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const id = e.target.dataset.id;
      if (confirm("Are you sure you want to delete this log?")) {
        state.logs = state.logs.filter(l => l.id !== id);
        db.set("logs", state.logs);
        renderHistoryTab();
      }
    });
  });

  container.querySelectorAll(".edit-log-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const id = e.target.dataset.id;
      openManualLogModal(id);
    });
  });
}

// Analytics Tab Controller
function renderAnalyticsTab() {
  const segmentBtns = document.querySelectorAll(".segment-btn");
  segmentBtns.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.chart === state.activeChart);
  });
  
  // Draw Chart
  drawCustomSVGChart();
  
  // Fill Benchmark History
  const tbody = document.getElementById("benchmark-table-body");
  tbody.innerHTML = "";
  
  const sortedBenchmarks = state.benchmarks
    .sort((a, b) => new Date(b.date) - new Date(a.date));
    
  if (sortedBenchmarks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state-row">No benchmarks logged yet. Run a test!</td></tr>`;
    return;
  }
  
  sortedBenchmarks.forEach(b => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${b.date}</td>
      <td>${b.durationSeconds}s Hang</td>
      <td><strong>${b.maxLoadKg} kg</strong></td>
      <td>@${b.rpe}</td>
      <td>${getWorkingMaxAt(b.durationSeconds, b.date)} kg</td>
    `;
    tbody.appendChild(tr);
  });
}

// Custom Offline SVG Chart Renderer
function drawCustomSVGChart() {
  const svg = document.getElementById("custom-svg-chart");
  const legend = document.getElementById("chart-legend");
  svg.innerHTML = "";
  legend.innerHTML = "";
  
  // Prepare data based on selected activeChart
  let series = [];
  let chartTitleText = "";
  let chartSubtitleText = "";
  
  if (state.activeChart === "e1rm") {
    chartTitleText = "Estimated 1RM Over Time";
    chartSubtitleText = "Shows E1RM progression in kg (5s vs 3s series)";
    
    // Series 1: 5s E1RM
    const e1rm5 = state.logs
      .filter(l => l.hangDurationSeconds === 5 && l.e1rmKg)
      .map(l => ({ date: new Date(l.date), val: l.e1rmKg }))
      .sort((a, b) => a.date - b.date);
      
    // Series 2: 3s E1RM
    const e1rm3 = state.logs
      .filter(l => l.hangDurationSeconds === 3 && l.e1rmKg)
      .map(l => ({ date: new Date(l.date), val: l.e1rmKg }))
      .sort((a, b) => a.date - b.date);
      
    series = [
      { name: "5s E1RM", data: e1rm5, color: "#3b82f6" },
      { name: "3s E1RM", data: e1rm3, color: "#a78bfa" }
    ];
  } else if (state.activeChart === "volume") {
    chartTitleText = "Weekly Training Volume";
    chartSubtitleText = "Sum of completed (Load * Sets) per week";
    
    // Group logs by weekNumber
    const weeks = {};
    for (let i = 1; i <= 16; i++) weeks[i] = 0;
    
    state.logs.forEach(l => {
      if (l.role === "Heavy" || l.role === "Volume") {
        const setSum = (l.sets || []).reduce((acc, s) => acc + (s.completed ? s.loadKg : 0), 0);
        weeks[l.weekNumber] = (weeks[l.weekNumber] || 0) + setSum;
      }
    });
    
    const volData = Object.keys(weeks).map(wk => ({
      label: `W${wk}`,
      val: weeks[wk]
    }));
    
    series = [{ name: "Weekly Volume (kg·sets)", data: volData, color: "#10b981", isBar: true }];
  } else if (state.activeChart === "recovery") {
    chartTitleText = "Recovery Signals (Next Morning Feel)";
    chartSubtitleText = "Subjective daily rating (1-5)";
    
    const recoveryData = state.logs
      .filter(l => l.nextDayFeel !== undefined && l.nextDayFeel !== null)
      .map(l => ({ date: new Date(l.date), val: l.nextDayFeel }))
      .sort((a, b) => a.date - b.date);
      
    series = [
      { name: "Next Day Feel", data: recoveryData, color: "#fbbf24" }
    ];
  }
  
  // Set headers
  document.getElementById("chart-title").textContent = chartTitleText;
  document.getElementById("chart-description").textContent = chartSubtitleText;
  
  // Render Legend
  series.forEach(s => {
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `
      <span class="legend-color" style="background-color: ${s.color};"></span>
      <span>${s.name}</span>
    `;
    legend.appendChild(item);
  });
  
  // Draw Chart elements on SVG
  const width = svg.clientWidth || 500;
  const height = 220;
  const paddingLeft = 40;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 30;
  
  const graphWidth = width - paddingLeft - paddingRight;
  const graphHeight = height - paddingTop - paddingBottom;
  
  // Render empty state if no data
  const hasData = series.some(s => s.data && s.data.length > 0);
  if (!hasData) {
    svg.innerHTML = `
      <text x="${width/2}" y="${height/2}" fill="var(--text-secondary)" text-anchor="middle" font-size="14">
        Log workouts to populate analytics.
      </text>
    `;
    return;
  }
  
  // Find limits
  let minVal = Infinity;
  let maxVal = -Infinity;
  
  if (state.activeChart === "volume") {
    minVal = 0;
    maxVal = Math.max(100, ...series[0].data.map(d => d.val));
  } else {
    series.forEach(s => {
      s.data.forEach(d => {
        if (d.val < minVal) minVal = d.val;
        if (d.val > maxVal) maxVal = d.val;
      });
    });
    // Add small buffer to limits
    if (minVal === maxVal) {
      minVal -= 5;
      maxVal += 5;
    } else {
      const buffer = (maxVal - minVal) * 0.1;
      minVal = Math.max(0, minVal - buffer);
      maxVal += buffer;
    }
  }
  
  // Draw horizontal grid lines
  const gridLinesCount = 4;
  for (let i = 0; i <= gridLinesCount; i++) {
    const val = minVal + (maxVal - minVal) * (i / gridLinesCount);
    const y = paddingTop + graphHeight - (graphHeight * (i / gridLinesCount));
    
    // Line
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", paddingLeft);
    line.setAttribute("y1", y);
    line.setAttribute("x2", width - paddingRight);
    line.setAttribute("y2", y);
    line.setAttribute("stroke", "rgba(255,255,255,0.05)");
    line.setAttribute("stroke-dasharray", "3,3");
    svg.appendChild(line);
    
    // Label
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", paddingLeft - 8);
    text.setAttribute("y", y + 4);
    text.setAttribute("fill", "var(--text-tertiary)");
    text.setAttribute("font-size", "10");
    text.setAttribute("text-anchor", "end");
    text.textContent = Math.round(val);
    svg.appendChild(text);
  }
  
  // Render Bar chart for volume
  if (state.activeChart === "volume") {
    const data = series[0].data;
    const barWidth = (graphWidth / data.length) * 0.7;
    const spacing = (graphWidth / data.length);
    
    data.forEach((d, idx) => {
      const x = paddingLeft + (idx * spacing) + (spacing - barWidth) / 2;
      const pct = d.val / maxVal;
      const barHeight = graphHeight * pct;
      const y = paddingTop + graphHeight - barHeight;
      
      // Draw Bar Rect
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", y);
      rect.setAttribute("width", barWidth);
      rect.setAttribute("height", Math.max(2, barHeight));
      rect.setAttribute("fill", "url(#volume-gradient)");
      rect.setAttribute("rx", "3");
      svg.appendChild(rect);
      
      // X Label
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", x + barWidth/2);
      text.setAttribute("y", paddingTop + graphHeight + 15);
      text.setAttribute("fill", "var(--text-secondary)");
      text.setAttribute("font-size", "9");
      text.setAttribute("text-anchor", "middle");
      text.textContent = d.label;
      svg.appendChild(text);
    });
    
    // Define Bar gradient
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `
      <linearGradient id="volume-gradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#10b981" stop-opacity="1"/>
        <stop offset="100%" stop-color="#10b981" stop-opacity="0.2"/>
      </linearGradient>
    `;
    svg.appendChild(defs);
  } else {
    // Render Line Charts
    series.forEach(s => {
      if (s.data.length === 0) return;
      
      // Time calculations
      const dates = s.data.map(d => d.date.getTime());
      const minTime = Math.min(...dates);
      const maxTime = Math.max(...dates);
      const timeSpan = maxTime - minTime || 1; // avoid division by zero
      
      // Points mapping
      const points = s.data.map(d => {
        const timeRatio = timeSpan === 1 ? 0.5 : (d.date.getTime() - minTime) / timeSpan;
        const valRatio = (d.val - minVal) / (maxVal - minVal);
        return {
          x: paddingLeft + (timeRatio * graphWidth),
          y: paddingTop + graphHeight - (valRatio * graphHeight),
          val: d.val,
          dateStr: d.date.toISOString().split("T")[0]
        };
      });
      
      // Draw Path
      let pathD = `M ${points[0].x} ${points[0].y}`;
      for (let idx = 1; idx < points.length; idx++) {
        pathD += ` L ${points[idx].x} ${points[idx].y}`;
      }
      
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathD);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", s.color);
      path.setAttribute("stroke-width", "2");
      svg.appendChild(path);
      
      // Draw Area Fill (optional gradient)
      let areaD = `${pathD} L ${points[points.length-1].x} ${paddingTop + graphHeight} L ${points[0].x} ${paddingTop + graphHeight} Z`;
      const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
      area.setAttribute("d", areaD);
      area.setAttribute("fill", `url(#area-gradient-${s.color.replace("#", "")})`);
      svg.appendChild(area);
      
      // Define Area Gradient
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      defs.innerHTML = `
        <linearGradient id="area-gradient-${s.color.replace("#", "")}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${s.color}" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/>
        </linearGradient>
      `;
      svg.appendChild(defs);
      
      // Draw Dots
      points.forEach(pt => {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", pt.x);
        circle.setAttribute("cy", pt.y);
        circle.setAttribute("r", "4");
        circle.setAttribute("fill", s.color);
        circle.setAttribute("stroke", "var(--bg-color)");
        circle.setAttribute("stroke-width", "1.5");
        
        // Add Simple Title for Hover Tooltip
        const titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
        titleEl.textContent = `${pt.dateStr}: ${pt.val} kg`;
        circle.appendChild(titleEl);
        
        svg.appendChild(circle);
      });
      
      // Label first and last date on x-axis
      if (points.length > 0) {
        const first = points[0];
        const last = points[points.length-1];
        
        // Start date
        const txtStart = document.createElementNS("http://www.w3.org/2000/svg", "text");
        txtStart.setAttribute("x", first.x);
        txtStart.setAttribute("y", paddingTop + graphHeight + 15);
        txtStart.setAttribute("fill", "var(--text-tertiary)");
        txtStart.setAttribute("font-size", "9");
        txtStart.setAttribute("text-anchor", "start");
        txtStart.textContent = first.dateStr.substr(5); // Show MM-DD
        svg.appendChild(txtStart);
        
        // End date
        if (points.length > 1) {
          const txtEnd = document.createElementNS("http://www.w3.org/2000/svg", "text");
          txtEnd.setAttribute("x", last.x);
          txtEnd.setAttribute("y", paddingTop + graphHeight + 15);
          txtEnd.setAttribute("fill", "var(--text-tertiary)");
          txtEnd.setAttribute("font-size", "9");
          txtEnd.setAttribute("text-anchor", "end");
          txtEnd.textContent = last.dateStr.substr(5);
          svg.appendChild(txtEnd);
        }
      }
    });
  }
}

// Settings Tab Controller
function renderSettingsTab() {
  document.getElementById("settings-start-date").value = state.cycleStartDate;
  document.getElementById("settings-bodyweight-toggle").checked = state.bodyweightTrack;
  document.getElementById("settings-bodyweight").value = state.bodyweightDefault;
  
  if (state.bodyweightTrack) {
    document.getElementById("settings-bodyweight-row").classList.remove("hidden");
  } else {
    document.getElementById("settings-bodyweight-row").classList.add("hidden");
  }
  
  // Working max values
  document.getElementById("settings-wm5").value = getWorkingMaxAt(5);
  document.getElementById("settings-wm3").value = getWorkingMaxAt(3);
  
  // Preferences
  document.getElementById("settings-rest-duration").value = state.restDuration;
  document.getElementById("settings-sound-toggle").checked = state.audioSpeech;
  document.getElementById("settings-haptic-toggle").checked = state.hapticFeedback;
}

// Manual Session Modal Add/Edit
function openManualLogModal(editId = null) {
  const modal = document.getElementById("manual-modal");
  const form = document.getElementById("manual-log-form");
  form.reset();
  
  if (editId) {
    document.getElementById("manual-modal-title").textContent = "Edit Log Entry";
    const log = state.logs.find(l => l.id === editId);
    if (!log) return;
    
    document.getElementById("manual-edit-id").value = log.id;
    document.getElementById("manual-date").value = log.date;
    document.getElementById("manual-role").value = log.role;
    document.getElementById("manual-duration").value = log.hangDurationSeconds || 5;
    
    const sets = log.sets || [];
    const maxSet = sets.reduce((max, s) => s.loadKg > max.loadKg ? s : max, { loadKg: 0, rpe: 0 });
    document.getElementById("manual-load").value = maxSet.loadKg || "";
    document.getElementById("manual-rpe").value = maxSet.rpe || "";
    document.getElementById("manual-sets-count").value = sets.length || "";
    
    document.getElementById("manual-taxing").value = log.taxing || "";
    document.getElementById("manual-strong").value = log.feltStrong || "";
    document.getElementById("manual-notes").value = log.notes || "";
  } else {
    document.getElementById("manual-modal-title").textContent = "Log Past Workout";
    document.getElementById("manual-edit-id").value = "";
    document.getElementById("manual-date").value = new Date().toISOString().split("T")[0];
    document.getElementById("manual-sets-count").value = 4;
  }
  
  modal.classList.remove("hidden");
}

function handleManualLogSubmit() {
  const editId = document.getElementById("manual-edit-id").value;
  const dateVal = document.getElementById("manual-date").value;
  const roleVal = document.getElementById("manual-role").value;
  const durVal = Number(document.getElementById("manual-duration").value);
  const loadVal = parseFloat(document.getElementById("manual-load").value) || 0;
  const rpeVal = parseFloat(document.getElementById("manual-rpe").value) || 0;
  const setsCount = parseInt(document.getElementById("manual-sets-count").value) || 1;
  const taxing = parseInt(document.getElementById("manual-taxing").value) || null;
  const strong = parseInt(document.getElementById("manual-strong").value) || null;
  const notes = document.getElementById("manual-notes").value;
  
  if (!dateVal) {
    alert("Please select a date.");
    return;
  }
  
  // Calculate training week from date
  const { week } = getTrainingPosition(new Date(dateVal));
  const weekData = PROGRAM_WEEKS.find(w => w.week === week) || PROGRAM_WEEKS[0];
  
  // Generate Set entries
  const sets = [];
  for (let i = 0; i < setsCount; i++) {
    sets.push({
      setIndex: i,
      loadKg: loadVal,
      rpe: rpeVal,
      durationSeconds: durVal,
      completed: true
    });
  }
  
  const e1rm = calculateE1RM(loadVal, rpeVal);
  
  if (editId) {
    // Edit existing
    const logIdx = state.logs.findIndex(l => l.id === editId);
    if (logIdx !== -1) {
      state.logs[logIdx] = {
        ...state.logs[logIdx],
        date: dateVal,
        weekNumber: week,
        block: weekData.block,
        role: roleVal,
        hangDurationSeconds: durVal,
        sets: sets,
        topSetLoadKg: loadVal,
        topSetRPE: rpeVal,
        e1rmKg: e1rm,
        taxing: taxing,
        feltStrong: strong,
        notes: notes
      };
    }
  } else {
    // Create new
    const newLog = {
      id: "log_" + Date.now(),
      date: dateVal,
      weekNumber: week,
      block: weekData.block,
      role: roleVal,
      type: "Yielding", // Default
      hangDurationSeconds: durVal,
      grip: "HalfCrimp",
      edgeMm: 20,
      sets: sets,
      topSetLoadKg: loadVal,
      topSetRPE: rpeVal,
      e1rmKg: e1rm,
      taxing: taxing,
      feltStrong: strong,
      notes: notes
    };
    state.logs.push(newLog);
  }
  
  db.set("logs", state.logs);
  document.getElementById("manual-modal").classList.add("hidden");
  
  // Refresh UI
  if (state.currentTab === "history") renderHistoryTab();
  else switchTab("history");
}

// Guided Benchmark Test Flow Controllers
function openBenchmarkTestFlowModal() {
  const modal = document.getElementById("test-flow-modal");
  document.getElementById("test-flow-step-intro").classList.remove("hidden");
  document.getElementById("test-flow-step-record").classList.add("hidden");
  document.getElementById("guard-rail-warning").classList.add("hidden");
  modal.classList.remove("hidden");
}

function handleBenchmarkTestStart() {
  document.getElementById("test-flow-step-intro").classList.add("hidden");
  document.getElementById("test-flow-step-record").classList.remove("hidden");
  
  // Pre-fill fields
  const duration = Number(document.getElementById("test-flow-duration").value);
  const currentWM = getWorkingMaxAt(duration);
  document.getElementById("test-load-input").value = currentWM;
}

function handleBenchmarkTestSubmit() {
  const duration = Number(document.getElementById("test-flow-duration").value);
  const newLoad = parseFloat(document.getElementById("test-load-input").value);
  const rpe = parseFloat(document.getElementById("test-rpe-input").value);
  
  if (isNaN(newLoad) || newLoad <= 0) {
    alert("Please enter a valid max load.");
    return;
  }
  
  const currentWM = getWorkingMaxAt(duration);
  const percentIncrease = ((newLoad - currentWM) / currentWM) * 100;
  
  // Guard Rail: > 15% increase warning
  const warningBanner = document.getElementById("guard-rail-warning");
  if (percentIncrease > 15 && warningBanner.classList.contains("hidden")) {
    warningBanner.classList.remove("hidden");
    return; // Stop and display warning, next click saves it.
  }
  
  // Add Working Max
  const wm = addWorkingMax(duration, newLoad, "test");
  
  // Log a benchmark entry
  const newBench = {
    id: "bench_" + Date.now(),
    date: new Date().toISOString().split("T")[0],
    durationSeconds: duration,
    maxLoadKg: newLoad,
    rpe: rpe,
    resultingWMid: wm.id
  };
  state.benchmarks.push(newBench);
  db.set("benchmarks", state.benchmarks);
  
  // Also create a training log entry representing the test day!
  const { week } = getTrainingPosition();
  const weekData = PROGRAM_WEEKS.find(w => w.week === week) || PROGRAM_WEEKS[0];
  
  const sets = [{
    setIndex: 0,
    loadKg: newLoad,
    rpe: rpe,
    durationSeconds: duration,
    completed: true
  }];
  
  const e1rm = calculateE1RM(newLoad, rpe);
  
  const newLog = {
    id: "log_" + Date.now(),
    date: new Date().toISOString().split("T")[0],
    weekNumber: week,
    block: weekData.block,
    role: "Test",
    type: "Yielding",
    hangDurationSeconds: duration,
    grip: "HalfCrimp",
    edgeMm: 20,
    sets: sets,
    topSetLoadKg: newLoad,
    topSetRPE: rpe,
    e1rmKg: e1rm,
    taxing: 4, // Seed reasonable values
    feltStrong: 8,
    notes: `Guided Benchmark Test established new ${duration}s Working Max: ${newLoad}kg`
  };
  state.logs.push(newLog);
  db.set("logs", state.logs);
  
  // Close modal and refresh today tab
  document.getElementById("test-flow-modal").classList.add("hidden");
  renderTodayTab();
  alert(`Success! Set new ${duration}s Working Max to ${newLoad} kg.`);
}

// CSV Export Handler
function exportToCSV() {
  if (state.logs.length === 0) {
    alert("No training logs to export.");
    return;
  }
  
  let csvContent = "data:text/csv;charset=utf-8,";
  // CSV Headers
  csvContent += "id,date,weekNumber,block,role,type,durationSeconds,grip,edgeMm,topSetLoadKg,topSetRPE,setsCount,e1rmKg,taxing,feltStrong,nextDayFeel,notes\n";
  
  state.logs.forEach(l => {
    const setsCount = l.sets ? l.sets.length : 0;
    const row = [
      l.id,
      l.date,
      l.weekNumber,
      `"${l.block}"`,
      l.role,
      l.type,
      l.hangDurationSeconds || 5,
      l.grip || "HalfCrimp",
      l.edgeMm || 20,
      l.topSetLoadKg || "",
      l.topSetRPE || "",
      setsCount,
      l.e1rmKg || "",
      l.taxing || "",
      l.feltStrong || "",
      l.nextDayFeel || "",
      `"${(l.notes || "").replace(/"/g, '""')}"`
    ];
    csvContent += row.join(",") + "\n";
  });
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `finger_trainer_history_${new Date().toISOString().split("T")[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// CSV Import Handler
function importFromCSV(file) {
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const text = e.target.result;
      const lines = text.split("\n");
      if (lines.length <= 1) throw new Error("Empty CSV file.");
      
      const headers = lines[0].split(",");
      const importedLogs = [];
      const wmEntries = [];
      
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        
        // Custom parser to handle quotes
        const row = [];
        let inQuotes = false;
        let currentField = "";
        
        for (let char of lines[i]) {
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            row.push(currentField.trim());
            currentField = "";
          } else {
            currentField += char;
          }
        }
        row.push(currentField.trim());
        
        // Map fields
        // Headers: id,date,weekNumber,block,role,type,durationSeconds,grip,edgeMm,topSetLoadKg,topSetRPE,setsCount,e1rmKg,taxing,feltStrong,nextDayFeel,notes
        const logId = row[0] || `log_imported_${Date.now()}_${i}`;
        const logDate = row[1];
        const weekNum = parseInt(row[2]) || 1;
        const block = row[3] ? row[3].replace(/"/g, "") : "Trans I";
        const role = row[4] || "Heavy";
        const type = row[5] || "Yielding";
        const dur = parseInt(row[6]) || 5;
        const grip = row[7] || "HalfCrimp";
        const edge = parseInt(row[8]) || 20;
        const topLoad = parseFloat(row[9]) || 0;
        const topRpe = parseFloat(row[10]) || 0;
        const setsCount = parseInt(row[11]) || 1;
        const e1rm = parseFloat(row[12]) || calculateE1RM(topLoad, topRpe);
        const taxing = row[13] ? parseInt(row[13]) : null;
        const strong = row[14] ? parseInt(row[14]) : null;
        const nextDay = row[15] ? parseInt(row[15]) : null;
        const notes = row[16] ? row[16].replace(/"/g, "") : "";
        
        // Rebuild sets structure
        const sets = [];
        for (let s = 0; s < setsCount; s++) {
          sets.push({
            setIndex: s,
            loadKg: topLoad,
            rpe: topRpe,
            durationSeconds: dur,
            completed: true
          });
        }
        
        importedLogs.push({
          id: logId,
          date: logDate,
          weekNumber: weekNum,
          block: block,
          role: role,
          type: type,
          hangDurationSeconds: dur,
          grip: grip,
          edgeMm: edge,
          sets: sets,
          topSetLoadKg: topLoad,
          topSetRPE: topRpe,
          e1rmKg: e1rm,
          taxing: taxing,
          feltStrong: strong,
          nextDayFeel: nextDay,
          notes: notes
        });
        
        // If it's a test day, also recreate a WorkingMax entry
        if (role === "Test" && topLoad > 0) {
          wmEntries.push({
            id: `wm_imported_${Date.now()}_${i}`,
            durationSeconds: dur,
            valueKg: topLoad,
            date: logDate,
            source: "test",
            notes: "Imported from historical test log"
          });
        }
      }
      
      // Update state
      if (importedLogs.length > 0) {
        state.logs = [...state.logs, ...importedLogs];
        // Deduplicate logs by ID
        const uniqueLogs = {};
        state.logs.forEach(l => uniqueLogs[l.id] = l);
        state.logs = Object.values(uniqueLogs);
        db.set("logs", state.logs);
        
        if (wmEntries.length > 0) {
          state.wmHistory = [...state.wmHistory, ...wmEntries];
          const uniqueWMs = {};
          state.wmHistory.forEach(w => uniqueWMs[w.date + "_" + w.durationSeconds] = w);
          state.wmHistory = Object.values(uniqueWMs);
          db.set("wmHistory", state.wmHistory);
        }
        
        alert(`Successfully imported ${importedLogs.length} workouts!`);
        renderHistoryTab();
      }
    } catch(err) {
      alert("Error importing CSV: " + err.message);
    }
  };
  reader.readAsText(file);
}

// Settings Saving
function saveSettings() {
  const startDate = document.getElementById("settings-start-date").value;
  const trackingToggle = document.getElementById("settings-bodyweight-toggle").checked;
  const defaultBW = parseFloat(document.getElementById("settings-bodyweight").value) || 75.0;
  
  const wm5 = parseFloat(document.getElementById("settings-wm5").value);
  const wm3 = parseFloat(document.getElementById("settings-wm3").value);
  
  const rest = parseInt(document.getElementById("settings-rest-duration").value);
  const sound = document.getElementById("settings-sound-toggle").checked;
  const haptic = document.getElementById("settings-haptic-toggle").checked;
  
  if (!startDate) {
    alert("Please enter a cycle start date.");
    return;
  }
  
  // Detect Working Max changes manually
  const cur5 = getWorkingMaxAt(5);
  const cur3 = getWorkingMaxAt(3);
  
  if (wm5 !== cur5) {
    addWorkingMax(5, wm5, "manualEdit", new Date().toISOString().split("T")[0], "Manual update via Settings");
  }
  if (wm3 !== cur3) {
    addWorkingMax(3, wm3, "manualEdit", new Date().toISOString().split("T")[0], "Manual update via Settings");
  }
  
  state.cycleStartDate = startDate;
  state.bodyweightTrack = trackingToggle;
  state.bodyweightDefault = defaultBW;
  state.restDuration = rest;
  state.audioSpeech = sound;
  state.hapticFeedback = haptic;
  
  db.set("cycleStartDate", state.cycleStartDate);
  db.set("bodyweightTrack", state.bodyweightTrack);
  db.set("bodyweightDefault", state.bodyweightDefault);
  db.set("restDuration", state.restDuration);
  db.set("audioSpeech", state.audioSpeech);
  db.set("hapticFeedback", state.hapticFeedback);
  
  alert("Settings saved successfully.");
  renderTodayTab();
}

// Reset Data
function resetData() {
  if (confirm("🚨 WARNING: This will permanently delete all training logs, benchmarks, and custom settings. Continue?")) {
    // Clear localStorage
    localStorage.clear();
    location.reload();
  }
}

// Bind Event Listeners
function bindEvents() {
  // Navigation Tabs
  document.querySelectorAll(".app-tabbar .tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
    });
  });
  
  // History Filters
  document.getElementById("history-search").addEventListener("input", renderHistoryTab);
  document.getElementById("history-filter-role").addEventListener("change", renderHistoryTab);
  
  // Segment Controllers
  document.querySelectorAll(".segment-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.activeChart = btn.dataset.chart;
      renderAnalyticsTab();
    });
  });
  
  // Settings Changes
  document.getElementById("settings-bodyweight-toggle").addEventListener("change", (e) => {
    if (e.target.checked) {
      document.getElementById("settings-bodyweight-row").classList.remove("hidden");
    } else {
      document.getElementById("settings-bodyweight-row").classList.add("hidden");
    }
  });
  
  document.getElementById("btn-manual-wm-save").addEventListener("click", saveSettings);
  document.getElementById("settings-export-btn").addEventListener("click", exportToCSV);
  
  document.getElementById("settings-trigger-import-btn").addEventListener("click", () => {
    document.getElementById("settings-import-file").click();
  });
  
  document.getElementById("settings-import-file").addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      importFromCSV(e.target.files[0]);
    }
  });
  
  document.getElementById("settings-reset-data-btn").addEventListener("click", resetData);
  
  // Manual Log Modals
  document.getElementById("manual-log-btn").addEventListener("click", () => openManualLogModal(null));
  document.getElementById("manual-modal-close").addEventListener("click", () => {
    document.getElementById("manual-modal").classList.add("hidden");
  });
  document.getElementById("btn-manual-cancel").addEventListener("click", () => {
    document.getElementById("manual-modal").classList.add("hidden");
  });
  document.getElementById("btn-manual-submit").addEventListener("click", handleManualLogSubmit);
  
  // Guided Benchmark modals
  document.getElementById("btn-start-test-flow").addEventListener("click", openBenchmarkTestFlowModal);
  document.getElementById("test-flow-close").addEventListener("click", () => {
    document.getElementById("test-flow-modal").classList.add("hidden");
  });
  document.getElementById("btn-test-flow-start-test").addEventListener("click", handleBenchmarkTestStart);
  document.getElementById("btn-test-flow-submit").addEventListener("click", handleBenchmarkTestSubmit);

  // Redraw SVG charts on window resize to ensure full mobile scaling
  window.addEventListener("resize", () => {
    if (state.currentTab === "analytics") {
      drawCustomSVGChart();
    }
  });
}

// Initializer
document.addEventListener("DOMContentLoaded", () => {
  initDatabase();
  bindEvents();
  switchTab("today");
  
  // Register Service Worker for offline PWA
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js")
      .then(reg => console.log("Service Worker registered successfully.", reg.scope))
      .catch(err => console.log("Service Worker registration failed.", err));
  }
});

// Finger Trainer PWA - Timer and Hands-Free Cue Engine

const TimerState = {
  INACTIVE: "INACTIVE",
  PREP: "PREP",
  HANG: "HANG",
  REST: "REST",
  LOGGING: "LOGGING"
};

const sessionState = {
  currentState: TimerState.INACTIVE,
  currentWeek: 1,
  currentWeekData: null,
  dayOfWeek: 1,
  
  // Sets sequence
  setsList: [], // Array of {type: "top"|"backoff"|"volume"|"oi", loadKg, rpe, duration, index}
  currentSetIndex: 0,
  
  // Timer tracking
  duration: 0, // current countdown duration in seconds
  timeLeft: 0,
  timerInterval: null,
  endTime: 0, // timestamp when the current timer state should end
  isPaused: false,
  pausedTimeLeft: 0,
  
  // Temp session logs
  completedSets: []
};

// Text-to-speech engine wrapper
function speak(text) {
  if (!state.audioSpeech) return;
  
  // Check if SpeechSynthesis is supported
  if ('speechSynthesis' in window) {
    // Cancel any active speech to avoid queuing delays
    window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05; // Slightly faster to feel punchy
    utterance.pitch = 1.0;
    
    // Choose an English voice if available
    const voices = window.speechSynthesis.getVoices();
    const englishVoice = voices.find(voice => voice.lang.startsWith('en'));
    if (englishVoice) {
      utterance.voice = englishVoice;
    }
    
    window.speechSynthesis.speak(utterance);
  }
}

// Haptic trigger
function vibrate(pattern) {
  if (!state.hapticFeedback) return;
  if ('vibrate' in navigator) {
    navigator.vibrate(pattern);
  }
}

// Generate the workout profile based on current day
function buildSessionSets() {
  const { week, dayOfWeek } = getTrainingPosition();
  const weekData = PROGRAM_WEEKS.find(w => w.week === week) || PROGRAM_WEEKS[0];
  
  sessionState.currentWeek = week;
  sessionState.currentWeekData = weekData;
  sessionState.dayOfWeek = dayOfWeek;
  sessionState.completedSets = [];
  sessionState.currentSetIndex = 0;
  
  const wm5 = getWorkingMaxAt(5);
  const wm3 = getWorkingMaxAt(3);
  
  const list = [];
  
  if (dayOfWeek === 2) {
    // Tuesday: OI Primer. 4 squeezes
    for (let i = 0; i < 4; i++) {
      list.push({
        type: "oi",
        name: `OI squeeze ${i+1}`,
        loadKg: 0,
        rpe: 10,
        duration: 5,
        rest: 60 // 1 min rest between primer squeezes
      });
    }
  } else if (dayOfWeek === 4) {
    // Thursday: Volume yielding
    const heavyTop = calculateHeavyTopAnchor(wm5, parseFloat(weekData.heavyRpe) || 9);
    const volLoad = calculateVolumeAnchor(heavyTop, weekData.volPct);
    const numSets = weekData.volSets === "4-5" ? 5 : parseInt(weekData.volSets) || 4;
    
    for (let i = 0; i < numSets; i++) {
      list.push({
        type: "volume",
        name: `Volume Set ${i+1}`,
        loadKg: volLoad,
        rpe: 7.5, // Target range @7-8, default anchor 7.5
        duration: weekData.volDur || 5,
        rest: state.restDuration
      });
    }
  } else if (dayOfWeek === 6) {
    // Saturday: Heavy hangs / max singles
    if (weekData.isTest) {
      // Test protocols
      if (week === 5) {
        // 5s test
        list.push({
          type: "test",
          name: "5s Benchmark Test Set",
          loadKg: wm5,
          rpe: 9,
          duration: 5,
          rest: 180
        });
      } else {
        // Dual 5s and 3s test
        list.push({
          type: "test",
          name: "5s Benchmark Test Set",
          loadKg: wm5,
          rpe: 9,
          duration: 5,
          rest: 180
        });
        list.push({
          type: "test",
          name: "3s Benchmark Test Set",
          loadKg: wm3,
          rpe: 9.5,
          duration: 3,
          rest: 180
        });
      }
    } else if (weekData.blockKey === "peak") {
      // Peak 3s singles. 5 sets, no back-offs, long rest
      const topLoad = calculateHeavyTopAnchor(wm3, parseFloat(weekData.heavyRpe) || 9.5);
      const rest = 240; // 4 mins default for peak
      
      for (let i = 0; i < 5; i++) {
        list.push({
          type: "peak",
          name: `Max Single Set ${i+1}`,
          loadKg: topLoad,
          rpe: 9.5,
          duration: 3,
          rest: rest
        });
      }
    } else {
      // Trans I/II 5s: 1 top set + 2-3 back-offs
      const topRpe = parseFloat(weekData.heavyRpe.split("-")[0]) || 9.0;
      const topLoad = calculateHeavyTopAnchor(wm5, topRpe);
      const backoffLoad = calculateBackoffAnchor(topLoad);
      
      // Top Set
      list.push({
        type: "top",
        name: "Heavy Top Set",
        loadKg: topLoad,
        rpe: topRpe,
        duration: 5,
        rest: state.restDuration
      });
      
      // Backoffs (2 to 3 sets)
      const numBackoffs = 3;
      for (let i = 0; i < numBackoffs; i++) {
        list.push({
          type: "backoff",
          name: `Back-off Set ${i+1}`,
          loadKg: backoffLoad,
          rpe: 7.5, // Target @7-8
          duration: 5,
          rest: state.restDuration
        });
      }
    }
  } else {
    // Allow a general default workout if started on a rest day
    list.push({
      type: "volume",
      name: "Custom Hang Set 1",
      loadKg: wm5,
      rpe: 8,
      duration: 5,
      rest: 120
    });
  }
  
  sessionState.setsList = list;
}

// Start Session flow
function startSession() {
  buildSessionSets();
  
  if (sessionState.setsList.length === 0) {
    alert("No prescription for today, but you can log manually or run custom sets.");
    return;
  }
  
  // Show modal
  const modal = document.getElementById("runner-modal");
  modal.classList.remove("hidden");
  
  // Start the state machine
  sessionState.currentSetIndex = 0;
  speak(`Starting workout. Get ready.`);
  enterPrepState();
}

// Timer Controller loop
function startTimer(seconds, onTick, onComplete) {
  clearInterval(sessionState.timerInterval);
  
  sessionState.duration = seconds;
  sessionState.timeLeft = seconds;
  sessionState.endTime = Date.now() + (seconds * 1000);
  sessionState.isPaused = false;
  
  // Immediately render first tick
  onTick(sessionState.timeLeft);
  
  sessionState.timerInterval = setInterval(() => {
    if (sessionState.isPaused) return;
    
    // Background safe drift check
    const diff = Math.round((sessionState.endTime - Date.now()) / 1000);
    sessionState.timeLeft = Math.max(0, diff);
    
    onTick(sessionState.timeLeft);
    
    if (sessionState.timeLeft <= 0) {
      clearInterval(sessionState.timerInterval);
      onComplete();
    }
  }, 1000);
}

// Pause/Resume timer
function togglePauseTimer() {
  const playIcon = document.getElementById("runner-play-icon");
  const pauseIcon = document.getElementById("runner-pause-icon");
  
  if (sessionState.isPaused) {
    // Resume
    sessionState.isPaused = false;
    sessionState.endTime = Date.now() + (sessionState.timeLeft * 1000);
    
    // Restart interval loop based on current state
    const currentTick = (time) => {
      document.getElementById("runner-timer-display").textContent = time;
      
      // Speech countdown warning during prep/hang
      if (sessionState.currentState === TimerState.PREP && time <= 3 && time > 0) {
        speak(time.toString());
      }
    };
    
    const currentComplete = () => {
      if (sessionState.currentState === TimerState.PREP) enterHangState();
      else if (sessionState.currentState === TimerState.HANG) enterLoggingState();
      else if (sessionState.currentState === TimerState.REST) enterPrepState();
    };
    
    startTimer(sessionState.timeLeft, currentTick, currentComplete);
    
    playIcon.classList.add("hidden");
    pauseIcon.classList.remove("hidden");
    speak("Resumed");
  } else {
    // Pause
    sessionState.isPaused = true;
    clearInterval(sessionState.timerInterval);
    
    playIcon.classList.remove("hidden");
    pauseIcon.classList.add("hidden");
    speak("Paused");
  }
}

// Skip Rest timer
function skipRest() {
  if (sessionState.currentState === TimerState.REST) {
    clearInterval(sessionState.timerInterval);
    enterPrepState();
  }
}

// State Machine transitions
function updateProgressBar() {
  const pct = ((sessionState.currentSetIndex) / sessionState.setsList.length) * 100;
  document.getElementById("runner-progress-fill").style.width = `${pct}%`;
  document.getElementById("runner-set-counter").textContent = `Set ${sessionState.currentSetIndex + 1} of ${sessionState.setsList.length}`;
}

function updateStateLabel(text, typeClass) {
  const lbl = document.getElementById("runner-state-title");
  lbl.textContent = text;
  lbl.className = "runner-state-lbl";
  if (typeClass) lbl.classList.add(typeClass);
}

// Prep State (3-5s countdown before hang)
function enterPrepState() {
  sessionState.currentState = TimerState.PREP;
  updateProgressBar();
  
  const currentSet = sessionState.setsList[sessionState.currentSetIndex];
  
  // UI Details
  document.getElementById("runner-prescribed-load").textContent = `${currentSet.loadKg} kg`;
  document.getElementById("runner-target-rpe").textContent = `@${currentSet.rpe}`;
  document.getElementById("runner-prescribed-duration").textContent = `${currentSet.duration} seconds`;
  document.getElementById("runner-protocol-lbl").textContent = currentSet.name;
  
  updateStateLabel("GET READY", "prep");
  document.getElementById("runner-timer-subtitle").textContent = `Prepare to hang on 20mm edge...`;
  
  // Show Controls, Hide Log Form
  document.getElementById("runner-controls-panel").classList.remove("hidden");
  document.getElementById("runner-logging-panel").classList.add("hidden");
  
  // Start Play state UI icons
  document.getElementById("runner-play-icon").classList.add("hidden");
  document.getElementById("runner-pause-icon").classList.remove("hidden");
  
  // Start 5-second countdown
  startTimer(5, 
    (time) => {
      document.getElementById("runner-timer-display").textContent = time;
      if (time <= 3 && time > 0) {
        speak(time.toString());
      }
    },
    () => {
      enterHangState();
    }
  );
}

// Hang State (timer counts down hang duration)
function enterHangState() {
  sessionState.currentState = TimerState.HANG;
  
  const currentSet = sessionState.setsList[sessionState.currentSetIndex];
  updateStateLabel("HANG", "hang");
  document.getElementById("runner-timer-subtitle").textContent = `Hold full duration!`;
  
  speak("Hang!");
  vibrate([400]); // Short vibration
  
  startTimer(currentSet.duration,
    (time) => {
      document.getElementById("runner-timer-display").textContent = time;
    },
    () => {
      enterLoggingState();
    }
  );
}

// Enter Logging State (prompt quick-log form)
function enterLoggingState() {
  sessionState.currentState = TimerState.LOGGING;
  clearInterval(sessionState.timerInterval);
  
  speak("Resting");
  vibrate([150, 100, 150]); // Triple pulse vibration
  
  const currentSet = sessionState.setsList[sessionState.currentSetIndex];
  
  // Fill quick-log form
  document.getElementById("log-load-input").value = currentSet.loadKg;
  
  // Select default RPE button
  const rpeVal = currentSet.rpe;
  document.querySelectorAll(".rpe-quick-buttons .rpe-btn").forEach(btn => {
    btn.classList.toggle("active", parseFloat(btn.dataset.rpe) === rpeVal);
  });
  
  // Hide Timer Controls, Show Quick-Log form
  document.getElementById("runner-controls-panel").classList.add("hidden");
  document.getElementById("runner-logging-panel").classList.remove("hidden");
  
  document.getElementById("runner-timer-display").textContent = "✓";
  updateStateLabel("LOG SET", "rest");
  document.getElementById("runner-timer-subtitle").textContent = `Confirm completed load and RPE`;
}

// Log confirmation handler
function confirmSetLog(completed = true) {
  const currentSet = sessionState.setsList[sessionState.currentSetIndex];
  
  const actualLoad = parseFloat(document.getElementById("log-load-input").value) || 0;
  
  let actualRpe = currentSet.rpe;
  const activeRpeBtn = document.querySelector(".rpe-quick-buttons .rpe-btn.active");
  if (activeRpeBtn) {
    actualRpe = parseFloat(activeRpeBtn.dataset.rpe);
  }
  
  // Save log entry to sessionState list
  sessionState.completedSets.push({
    setIndex: sessionState.currentSetIndex,
    loadKg: actualLoad,
    rpe: actualRpe,
    durationSeconds: currentSet.duration,
    completed: completed
  });
  
  // Advance Set Index
  sessionState.currentSetIndex++;
  
  if (sessionState.currentSetIndex >= sessionState.setsList.length) {
    // Session fully complete
    closeRunnerModal();
    openSessionSummaryModal();
  } else {
    // Go to Rest State
    enterRestState();
  }
}

// Rest State (auto starts countdown, showing timer controls)
function enterRestState() {
  sessionState.currentState = TimerState.REST;
  
  const prevSet = sessionState.setsList[sessionState.currentSetIndex - 1];
  const restTime = prevSet.rest || state.restDuration;
  
  updateStateLabel("REST", "rest");
  document.getElementById("runner-timer-subtitle").textContent = `Resting before next set...`;
  
  // Show timer controls, Hide Log form
  document.getElementById("runner-controls-panel").classList.remove("hidden");
  document.getElementById("runner-logging-panel").classList.add("hidden");
  
  // Set play icons
  document.getElementById("runner-play-icon").classList.add("hidden");
  document.getElementById("runner-pause-icon").classList.remove("hidden");
  
  startTimer(restTime,
    (time) => {
      // Format MM:SS for readability on rest screen
      const mins = Math.floor(time / 60);
      const secs = time % 60;
      document.getElementById("runner-timer-display").textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
      
      // Speech Warnings
      if (time === 10) {
        speak("Ten seconds to prepare.");
        vibrate([200]);
      }
    },
    () => {
      enterPrepState();
    }
  );
}

// Close runner modal and cleanup
function closeRunnerModal() {
  clearInterval(sessionState.timerInterval);
  sessionState.currentState = TimerState.INACTIVE;
  document.getElementById("runner-modal").classList.add("hidden");
}

// Open Subjective Rating modal
function openSessionSummaryModal() {
  document.getElementById("session-notes").value = "";
  document.getElementById("summary-modal").classList.remove("hidden");
  speak("Workout complete. Rate your session.");
}

// Save all accumulated workout logs to DB
function saveSessionSummary() {
  const taxing = parseInt(document.querySelector("#taxing-scale .rating-btn.active").dataset.val) || 4;
  const feelStrong = parseInt(document.querySelector("#strong-scale .rating-btn.active").dataset.val) || 7;
  const notes = document.getElementById("session-notes").value;
  
  // Collect details from sessionState
  const firstSet = sessionState.setsList[0];
  const role = sessionState.dayOfWeek === 2 ? "OIprimer" : 
               sessionState.dayOfWeek === 4 ? "Volume" :
               sessionState.dayOfWeek === 6 ? (sessionState.currentWeekData.isTest ? "Test" : "Heavy") : "Volume";
               
  // Find top set load/RPE
  const completedYieldingSets = sessionState.completedSets.filter(s => s.completed);
  const maxSet = completedYieldingSets.length > 0
    ? completedYieldingSets.reduce((max, s) => s.loadKg > max.loadKg ? s : max, completedYieldingSets[0])
    : { loadKg: 0, rpe: 0 };
    
  const hangDuration = firstSet.duration || 5;
  const e1rm = calculateE1RM(maxSet.loadKg, maxSet.rpe);
  
  const newLog = {
    id: "log_" + Date.now(),
    date: new Date().toISOString().split("T")[0],
    weekNumber: sessionState.currentWeek,
    block: sessionState.currentWeekData.block,
    role: role,
    type: role === "OIprimer" ? "OI" : "Yielding",
    hangDurationSeconds: hangDuration,
    grip: "HalfCrimp",
    edgeMm: 20,
    sets: sessionState.completedSets,
    topSetLoadKg: maxSet.loadKg,
    topSetRPE: maxSet.rpe,
    e1rmKg: e1rm,
    taxing: taxing,
    feltStrong: feelStrong,
    notes: notes
  };
  
  state.logs.push(newLog);
  db.set("logs", state.logs);
  
  document.getElementById("summary-modal").classList.add("hidden");
  
  // Switch to History view to show progress
  switchTab("history");
  
  // Prompt for Recovery next morning (Simulated/Ready for next day prompt)
  scheduleNextMorningFeelNotification();
}

// Local notifications simulation
function scheduleNextMorningFeelNotification() {
  console.log("Scheduling recovery feedback alert for tomorrow morning.");
  
  // We simulate by setting a flag in state that recovery feel is pending.
  // When app starts next time on a different calendar day, it will pop open the recovery feel input banner or prompt.
  db.set("pendingRecoveryPrompt", true);
}

// Check if a recovery prompt is due on app load
function checkPendingRecoveryPrompt() {
  const pending = db.get("pendingRecoveryPrompt", false);
  if (!pending) return;
  
  // Check if we have logs without nextDayFeel
  const logsWithoutFeel = state.logs
    .filter(log => log.role !== "OIprimer" && (log.nextDayFeel === undefined || log.nextDayFeel === null))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
    
  if (logsWithoutFeel.length === 0) {
    db.set("pendingRecoveryPrompt", false);
    return;
  }
  
  const targetLog = logsWithoutFeel[logsWithoutFeel.length - 1]; // get latest
  
  // Prompt using a beautiful custom modal or alert overlay
  const feel = prompt(`🌅 Good morning! How do your fingers feel today after your ${targetLog.role} workout? \nRate from 1 (Sluggish/tender) to 5 (Full recovery, fresh):`, "4");
  
  if (feel) {
    const val = parseInt(feel);
    if (val >= 1 && val <= 5) {
      targetLog.nextDayFeel = val;
      // Update log
      const idx = state.logs.findIndex(l => l.id === targetLog.id);
      if (idx !== -1) {
        state.logs[idx] = targetLog;
        db.set("logs", state.logs);
      }
      db.set("pendingRecoveryPrompt", false);
      alert("Recovery feel logged. Thank you!");
      renderTodayTab(); // Refresh recovery banners if any
    }
  }
}

// Bind Timer-specific listeners
document.addEventListener("DOMContentLoaded", () => {
  // Today's Big CTA button
  document.getElementById("start-session-btn").addEventListener("click", startSession);
  
  // Timer buttons
  document.getElementById("runner-close-btn").addEventListener("click", () => {
    if (confirm("Are you sure you want to quit this training session? Progress on current set will be lost.")) {
      closeRunnerModal();
    }
  });
  
  document.getElementById("runner-play-pause-btn").addEventListener("click", togglePauseTimer);
  document.getElementById("runner-skip-btn").addEventListener("click", () => confirmSetLog(false)); // Skip logs as failed/empty
  document.getElementById("runner-skip-rest-btn").addEventListener("click", skipRest);
  
  // Quick-Log Confirmations
  document.getElementById("runner-log-confirm-btn").addEventListener("click", () => confirmSetLog(true));
  document.getElementById("runner-fail-btn").addEventListener("click", () => confirmSetLog(false));
  
  // Stepper adjustments for Chalky Hands
  document.getElementById("log-load-minus").addEventListener("click", () => {
    const input = document.getElementById("log-load-input");
    input.value = Math.max(0, parseFloat(input.value) - 2.5);
  });
  
  document.getElementById("log-load-minus-one").addEventListener("click", () => {
    const input = document.getElementById("log-load-input");
    input.value = Math.max(0, parseFloat(input.value) - 0.5);
  });
  
  document.getElementById("log-load-plus-one").addEventListener("click", () => {
    const input = document.getElementById("log-load-input");
    input.value = parseFloat(input.value) + 0.5;
  });
  
  document.getElementById("log-load-plus").addEventListener("click", () => {
    const input = document.getElementById("log-load-input");
    input.value = parseFloat(input.value) + 2.5;
  });
  
  // RPE quick buttons selector
  document.querySelectorAll(".rpe-quick-buttons .rpe-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".rpe-quick-buttons .rpe-btn").forEach(b => b.classList.remove("active"));
      e.target.classList.add("active");
    });
  });
  
  // Summary Rating Scale buttons
  const setupRatingScale = (containerId) => {
    document.querySelectorAll(`#${containerId} .rating-btn`).forEach(btn => {
      btn.addEventListener("click", (e) => {
        document.querySelectorAll(`#${containerId} .rating-btn`).forEach(b => b.classList.remove("active"));
        e.target.classList.add("active");
      });
    });
  };
  setupRatingScale("taxing-scale");
  setupRatingScale("strong-scale");
  
  document.getElementById("btn-save-session-summary").addEventListener("click", saveSessionSummary);
  
  // Check for recovery notifications on startup after DOM loads
  setTimeout(checkPendingRecoveryPrompt, 1000);
});

// Calculations tests for Finger Trainer application

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

function shouldFlagRecovery(nextDayFeels) {
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
      // Compare to maximum rolling average in history (up to the last 10 elements)
      const pastAverages = rollingAverages.slice(-10);
      const maxAvg = Math.max(...pastAverages);
      if (maxAvg - currentAvg >= 1.0) {
        return true;
      }
    }
  }
  return false;
}

// Simple test runner
function runTests() {
  console.log("Running calculation tests...");
  
  // Test E1RM
  const e1rm1 = calculateE1RM(20, 9); // 20 * 100 / (40 + 54) = 2000 / 94 = 21.27 -> 21.3
  console.assert(e1rm1 === 21.3, `E1RM 20kg @9 failed: expected 21.3, got ${e1rm1}`);
  
  const e1rm2 = calculateE1RM(15, 7.5); // 15 * 100 / (40 + 45) = 1500 / 85 = 17.64 -> 17.6
  console.assert(e1rm2 === 17.6, `E1RM 15kg @7.5 failed: expected 17.6, got ${e1rm2}`);
  
  const e1rmLow = calculateE1RM(15, 5.5); // < 6 should be null
  console.assert(e1rmLow === null, `E1RM with RPE < 6 should be null, got ${e1rmLow}`);

  // Test Anchors
  const topAnchor = calculateHeavyTopAnchor(50, 9);
  console.assert(topAnchor === 48.5, `Heavy Top Anchor failed: expected 48.5, got ${topAnchor}`);
  
  const volAnchor = calculateVolumeAnchor(topAnchor, 0.82);
  console.assert(volAnchor === 40.0, `Volume Anchor failed: expected 40.0, got ${volAnchor}`);

  const backAnchor = calculateBackoffAnchor(topAnchor);
  console.assert(backAnchor === 40.0, `Backoff Anchor failed: expected 40.0, got ${backAnchor}`);
  
  const deloadAnchor = calculateDeloadAnchor(50);
  console.assert(deloadAnchor === 37.5, `Deload Anchor failed: expected 37.5, got ${deloadAnchor}`);

  // Test Recovery Signal
  console.assert(shouldFlagRecovery([4, 4, 2]) === true, "Recovery should flag when latest is <= 2");
  console.assert(shouldFlagRecovery([4, 4, 4]) === false, "Recovery should not flag on [4, 4, 4]");
  
  // Test rolling average drop
  console.assert(shouldFlagRecovery([5, 5, 5, 4, 4, 3]) === true, "Recovery should flag when rolling average drops by >= 1.0");
  
  console.log("All tests passed successfully!");
}

runTests();

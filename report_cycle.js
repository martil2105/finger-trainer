/* report_cycle.js
 * Programmatically generates current_cycle_report.md from active template.
 */
const fs = require('fs');
const path = require('path');

// Load templates and calc modules using CommonJS require
const Templates = require('./templates.js');
const Calc = require('./calc.js');

if (!Templates || !Calc) {
  console.error('Failed to load templates or calc modules.');
  process.exit(1);
}

// Helper to format values
function kg(v) { return v == null ? '—' : v + ' kg'; }

function generateReport() {
  const cycle = Templates.templateA();
  const weeks = Calc.expandCycle(cycle);

  let md = `# Current Training Cycle Report: ${cycle.name}\n\n`;
  md += `**Start Date**: ${cycle.startDate}  \n`;
  md += `**Status**: Active  \n`;
  md += `**Weekly Structure**:  \n`;
  md += `- **Monday**: Rest\n`;
  md += `- **Tuesday**: OI Primer + Board\n`;
  md += `- **Wednesday**: Rest\n`;
  md += `- **Thursday**: Volume Hangs\n`;
  md += `- **Friday**: Rest\n`;
  md += `- **Saturday**: Heavy Hangs\n`;
  md += `- **Sunday**: Rest\n\n`;
  md += `**Notes**: ${cycle.notes || 'None'}\n\n`;

  md += `## Cycle Overview (Week-by-Week)\n\n`;
  md += `| Wk | Start Date | Block | Role / Workout Type | Prescription | Notes / Details |\n`;
  md += `|---|---|---|---|---|---|\n`;

  weeks.forEach(w => {
    const dateStr = w.startDate;
    const blockName = w.blockName;
    const wkNum = w.weekNumber;

    if (w.isDeloadTest) {
      const tests = w.testDurations.map(d => `${d}s`).join('/');
      md += `| ${wkNum} | ${dateStr} | ${blockName} | **Deload + Test** | Deload @75% WM, Test ${tests} | Rest and test maximum working max |\n`;
    } else {
      // Tuesday: OI Primer
      const oiSets = w.oiSets === 3 ? '3-5' : w.oiSets;
      md += `| ${wkNum} | ${dateStr} | ${blockName} | **Tuesday**: OI Primer | ${oiSets} sets OI + limit board | Overcoming isometrics (max-intent press/pull, ~5s) |\n`;

      // Thursday: Volume
      const volAnchorText = w.volumeAnchorKg != null ? `~${w.volumeAnchorKg} kg` : 'anchor';
      md += `| | | | **Thursday**: Volume Hangs | ${w.volumeSets} sets · ${w.volumeDuration}s @${Math.round((w.volumePct || 0) * 100)}% | RPE creep rule: drop load 5% if RPE >= 8.5 by set 3 |\n`;

      // Saturday: Heavy
      const heavyAnchorText = w.heavyAnchorKg != null ? `~${w.heavyAnchorKg} kg` : 'anchor';
      const backoffText = w.backoffPctOfTop ? `Back-offs: ${w.heavySets} sets @${Math.round(w.backoffPctOfTop * 100)}%` : 'No back-offs';
      md += `| | | | **Saturday**: Heavy Hangs | ${w.heavyDuration}s @${w.heavyRPE} (top set) \| ${backoffText} | Fatigue stop: halt back-offs on full-5s fail, load drop >5% to stay @8, or discomfort |\n`;
    }
  });

  md += `\n\n## Block Summaries\n\n`;

  cycle.blocks.forEach(b => {
    md += `### Block: ${b.name} (${b.type})\n`;
    md += `- **Duration**: ${b.durationWeeks} weeks\n`;
    if (b.isDeloadTest) {
      md += `- **Deload Factor**: ${Math.round(b.testConfig.deloadPctOfWM * 100)}% of WM\n`;
      md += `- **Test Durations**: ${b.testConfig.testDurations.map(d => `${d}s`).join(', ')}\n`;
    } else {
      md += `- **Heavy Hangs**:\n`;
      md += `  - Hang Duration: ${b.heavy.hangDurationSeconds}s\n`;
      md += `  - Protocol: \`${b.heavy.protocol}\`\n`;
      md += `  - RPE Targets: @${b.heavy.rpeStart} to @${b.heavy.rpeEnd}\n`;
      md += `  - Back-off Sets: ${b.heavy.setsStart} to ${b.heavy.setsEnd} sets\n`;
      md += `  - Back-off Percentage: ${Math.round(b.heavy.backoffPctOfTop * 100)}%`;
      if (b.heavy.backoffPctOfTopEnd !== b.heavy.backoffPctOfTop) {
        md += ` to ${Math.round(b.heavy.backoffPctOfTopEnd * 100)}%`;
      }
      md += `\n`;
      md += `- **Volume Hangs**:\n`;
      md += `  - Hang Duration: ${b.volume.hangDurationSeconds}s\n`;
      md += `  - Target Intensity: ${Math.round(b.volume.pctStart * 100)}% to ${Math.round(b.volume.pctEnd * 100)}% of Heavy anchor\n`;
      md += `  - Sets: ${b.volume.sets} sets (fixed volume)\n`;
      md += `- **OI Primer Sets**: ${b.oi.sets} sets\n`;
    }
    md += `\n`;
  });

  fs.writeFileSync(path.join(__dirname, 'current_cycle_report.md'), md, 'utf8');
  console.log('Successfully wrote current_cycle_report.md');
}

generateReport();

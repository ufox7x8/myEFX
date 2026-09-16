const fs = require('fs');

const path = 'WebTester/app.js';
let s = fs.readFileSync(path, 'utf8');

const oldStart = s.indexOf('  function createStage(c) {');
const oldEnd = s.indexOf('\n\n  async function ensureGraph()', oldStart);
if (oldStart < 0 || oldEnd < 0) throw new Error('createStage block not found');

const replacement = `  function createStage(c) {
    const eq = c.createBiquadFilter(); eq.type = 'peaking';
    const split = c.createBiquadFilter(); split.type = 'bandpass';
    // Exact Section-band extraction used by DELTA on both dry and wet sides.
    const dryBand = c.createBiquadFilter(); dryBand.type = 'bandpass';
    const wetBand = c.createBiquadFilter(); wetBand.type = 'bandpass';

    const dryFull = c.createGain();
    const dnIn = c.createGain(), dnSum = c.createGain();
    const trDry = c.createGain(), trWet = c.createGain(), trSum = c.createGain();

    // Normal-output spectral difference remains separate from the DELTA monitor.
    const spectralDelta = c.createGain();
    const spectralInvert = c.createGain(); spectralInvert.gain.value = -1;

    // Dedicated DELTA chain:
    //   DryBand = BandPass(original Section input)
    //   WetBand = BandPass(effective Section wet band)
    //   DELTA   = WetBand - DryBand
    const wetBandSum = c.createGain();
    const deltaDryInvert = c.createGain(); deltaDryInvert.gain.value = -1;
    const delta = c.createGain();
    const out = c.createGain();

    // Normal Section path.
    // Full-band EQ is preserved.
    eq.connect(out);

    // Original Section band: this is the exact dry reference for DELTA.
    split.connect(dryBand);
    dryBand.connect(spectralInvert);
    spectralInvert.connect(spectralDelta);

    // Spectral processing path.
    split.connect(dnIn);
    dnIn.connect(dnSum);
    dnSum.connect(trDry);
    dnSum.connect(trWet);
    trDry.connect(trSum);
    trWet.connect(trSum);
    trSum.connect(spectralDelta);
    spectralDelta.connect(out);

    // Build the effective Section wet band first, then do ONE subtraction.
    // EQ output is band-limited with the same Section FREQ/Q.
    eq.connect(wetBand);
    wetBand.connect(wetBandSum);

    // spectralDelta is exactly (processed band - dry band), so adding it to
    // EQ's band gives the effective processed Section band.
    spectralDelta.connect(wetBandSum);
    wetBandSum.connect(delta);

    // Final DELTA subtraction: effective WetBand - original DryBand.
    dryBand.connect(deltaDryInvert);
    deltaDryInvert.connect(delta);

    return {
      eq, split, dryBand, wetBand, dryFull,
      dnIn, dnSum, trDry, trWet, trSum,
      spectralDelta, spectralInvert,
      wetBandSum, deltaDryInvert, delta, out,
      denoise: null, transient: null
    };
  }`;

s = s.slice(0, oldStart) + replacement + s.slice(oldEnd);

// Keep processing and BOTH DELTA isolation bands locked to the Section FREQ/Q.
s = s.replace(
  "s.split.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);",
  "s.split.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);\n      s.dryBand.frequency.setTargetAtTime(b.freq, now, .004);\n      s.dryBand.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);\n      s.wetBand.frequency.setTargetAtTime(b.freq, now, .004);\n      s.wetBand.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);"
);

// DELTA is an isolated monitor. Clear all previous direct monitor feeds first
// so switching Sections cannot leave an old DELTA signal connected to master.
const deltaCleanup = `    // Clear all direct DELTA-monitor feeds first.\n    for (const s of graph.stages) {\n      try { s.delta.disconnect(graph.master); } catch (_) {}\n    }\n\n`;
s = s.replace("    if (deltaBand) {", deltaCleanup + "    if (deltaBand) {", 1);

const oldDelta = `    if (deltaBand) {
      // Feed prior sections normally, then solo only the selected section's true delta.
      let node = source;
      for (let i = 0; i < deltaBand - 1; i++) {
        const s = graph.stages[i];
        node.connect(s.dryFull);
        node.connect(s.eq);
        node.connect(s.split);
        node = s.out;
      }
      const selected = graph.stages[deltaBand - 1];
      node.connect(selected.dryFull);
      node.connect(selected.eq);
      node.connect(selected.split);
      selected.delta.connect(graph.master);
      return;
    }`;
const newDelta = `    if (deltaBand) {
      // DELTA is a true one-Section monitor:
      // original source -> selected Section -> WetBand - DryBand.
      // No other Section is allowed into this monitoring path.
      const selected = graph.stages[deltaBand - 1];
      source.connect(selected.dryFull);
      source.connect(selected.eq);
      source.connect(selected.split);
      selected.delta.connect(graph.master);
      return;
    }`;
if (!s.includes(oldDelta)) throw new Error('old DELTA routing block not found');
s = s.replace(oldDelta, newDelta);

s = s.replace("denoise-processor.js?v=rxgate3", "denoise-processor.js?v=rxgate4");

fs.writeFileSync('/tmp/app-v5.js', s);
fs.copyFileSync('/tmp/app-v5.js', 'WebTester/app.js');

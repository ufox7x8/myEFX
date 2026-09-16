const fs = require('fs');

const path = 'WebTester/app.js';
let s = fs.readFileSync(path, 'utf8');

const oldStart = s.indexOf('  function createStage(c) {');
const oldEnd = s.indexOf('\n\n  async function ensureGraph()', oldStart);
if (oldStart < 0 || oldEnd < 0) throw new Error('createStage block not found');

const replacement = `  function createStage(c) {
    const eq = c.createBiquadFilter(); eq.type = 'peaking';
    const split = c.createBiquadFilter(); split.type = 'bandpass';
    // Dedicated bandpass for the EQ part of DELTA.
    const eqBand = c.createBiquadFilter(); eqBand.type = 'bandpass';
    const dryFull = c.createGain();
    const eqBandInvert = c.createGain(); eqBandInvert.gain.value = -1;
    const eqBandDelta = c.createGain();
    const dryBand = c.createGain();
    const bandInvert = c.createGain(); bandInvert.gain.value = -1;
    const dnIn = c.createGain(), dnSum = c.createGain();
    const trDry = c.createGain(), trWet = c.createGain(), trSum = c.createGain();
    const delta = c.createGain();
    const out = c.createGain();

    eq.connect(out);

    // EQ DELTA = band(EQ output) - band(original Section input).
    // Both sides use the exact Section FREQ/Q band, so unrelated frequencies
    // cannot enter the EQ delta.
    eq.connect(eqBand);
    eqBand.connect(eqBandDelta);
    split.connect(eqBandInvert);
    eqBandInvert.connect(eqBandDelta);
    eqBandDelta.connect(delta);

    // Spectral DELTA = processed Section band - exact dry Section band.
    split.connect(dryBand);
    split.connect(dnIn);
    dnIn.connect(dnSum);
    dnSum.connect(trDry);
    dnSum.connect(trWet);
    trDry.connect(trSum);
    trWet.connect(trSum);
    dryBand.connect(bandInvert);
    bandInvert.connect(delta);
    trSum.connect(delta);

    // Normal serial output = full-band EQ + spectral processing difference.
    delta.connect(out);

    return {
      eq, split, eqBand, dryFull, eqBandInvert, eqBandDelta, dryBand, bandInvert,
      dnIn, dnSum, trDry, trWet, trSum, delta, out,
      denoise: null, transient: null
    };
  }`;

s = s.slice(0, oldStart) + replacement + s.slice(oldEnd);

// Keep both processing and DELTA isolation bands locked to the Section FREQ/Q.
s = s.replace(
  "s.split.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);",
  "s.split.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);\n      s.eqBand.frequency.setTargetAtTime(b.freq, now, .004);\n      s.eqBand.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);"
);

// DELTA is an isolated monitoring mode: it must never include prior Sections.
// Also remove any previous Section DELTA monitor feed before selecting a new one,
// otherwise an old DELTA connection can leak into normal playback or a new DELTA.
const deltaCleanup = `    // Clear all direct DELTA-monitor feeds first.
    for (const s of graph.stages) {
      try { s.delta.disconnect(graph.master); } catch (_) {}
    }

`;
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
      // DELTA = ONLY this Section's Wet - Dry change, monitored in isolation.
      // Start from the original source so Sections 1..N-1 can never leak into it.
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

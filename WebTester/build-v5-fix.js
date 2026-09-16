const fs = require('fs');

const path = 'WebTester/app.js';
let s = fs.readFileSync(path, 'utf8');

const oldStart = s.indexOf('  function createStage(c) {');
const oldEnd = s.indexOf('\n\n  async function ensureGraph()', oldStart);
if (oldStart < 0 || oldEnd < 0) throw new Error('createStage block not found');

const replacement = `  function createStage(c) {
    const eq = c.createBiquadFilter(); eq.type = 'peaking';
    const split = c.createBiquadFilter(); split.type = 'bandpass';
    // DELTA has its own bandpass so EQ changes are isolated to this Section.
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

    // Strictly band-limited EQ delta: band(EQ output) - band(original input).
    eq.connect(eqBand);
    eqBand.connect(eqBandDelta);
    split.connect(eqBandInvert);
    eqBandInvert.connect(eqBandDelta);
    eqBandDelta.connect(delta);

    // Strictly band-limited spectral delta: processed band - exact dry band.
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

    // Normal output = full-band EQ + spectral processing difference.
    delta.connect(out);

    return {
      eq, split, eqBand, dryFull, eqBandInvert, eqBandDelta, dryBand, bandInvert,
      dnIn, dnSum, trDry, trWet, trSum, delta, out,
      denoise: null, transient: null
    };
  }`;

s = s.slice(0, oldStart) + replacement + s.slice(oldEnd);

// Keep the DELTA bandpass locked to exactly the same FREQ/Q as the Section.
s = s.replace(
  "s.split.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);",
  "s.split.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);\n      s.eqBand.frequency.setTargetAtTime(b.freq, now, .004);\n      s.eqBand.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);"
);

s = s.replace("denoise-processor.js?v=rxgate3", "denoise-processor.js?v=rxgate4");
fs.writeFileSync('/tmp/app-v5.js', s);
fs.copyFileSync('/tmp/app-v5.js', 'WebTester/app.js');

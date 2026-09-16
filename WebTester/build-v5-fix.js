const fs = require('fs');

const path = 'WebTester/app.js';
let s = fs.readFileSync(path, 'utf8');

const oldStart = s.indexOf('  function createStage(c) {');
const oldEnd = s.indexOf('\n\n  async function ensureGraph()', oldStart);
if (oldStart < 0 || oldEnd < 0) throw new Error('createStage block not found');

const replacement = `  function createStage(c) {
    const eq = c.createBiquadFilter(); eq.type = 'peaking';
    const split = c.createBiquadFilter(); split.type = 'bandpass';
    // A second bandpass is used only for DELTA. This is critical: EQ delta must be
    // restricted to the selected Section's frequency region, never full-band.
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

    // Normal output keeps the full-band EQ result.
    eq.connect(out);

    // EQ DELTA is now strictly: band(EQ output) - band(original input).
    // It can therefore never leak unrelated frequencies into DELTA.
    eq.connect(eqBand);
    eqBand.connect(eqBandDelta);
    split.connect(eqBandInvert);
    eqBandInvert.connect(eqBandDelta);
    eqBandDelta.connect(delta);

    // Spectral-section DELTA: processed band - exact dry band.
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

    // Normal stage output = full-band EQ + spectral processing difference.
    delta.connect(out);

    return {
      eq, split, eqBand, dryFull, eqBandInvert, eqBandDelta, dryBand, bandInvert,
      dnIn, dnSum, trDry, trWet, trSum, delta, out,
      denoise: null, transient: null
    };
  }`;

s = s.slice(0, oldStart) + replacement + s.slice(oldEnd);
s = s.replace("denoise-processor.js?v=rxgate3", "denoise-processor.js?v=rxgate4");
s = s.replace("app.js?v=4", "app.js?v=5");
fs.writeFileSync('/tmp/app-v5.js', s);

// The deployment workflow copies the canonical source first, then installs this
// deterministic build result. Keep the source file itself untouched by this step.
fs.copyFileSync('/tmp/app-v5.js', 'WebTester/app.js');

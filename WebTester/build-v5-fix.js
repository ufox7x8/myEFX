const fs = require('fs');

const path = 'WebTester/app.js';
let s = fs.readFileSync(path, 'utf8');

// ---------------------------------------------------------------------------
// DELTA ARCHITECTURE
// ---------------------------------------------------------------------------
// DELTA is intentionally NOT a tap from the normal serial processing chain.
// For each Section we build an independent four-band-isolated monitor path:
//
//   input
//     -> Section frequency-isolation band (LR4-style HP/LP pair)
//        -> same isolated samples split to:
//             DRY reference
//             WET Section processing (EQ -> De-noise -> Transient)
//        -> DELTA = WET - DRY
//
// In DELTA mode, ONLY the selected Section's delta node is connected to master.
// Sections 1/3/4 have no route to the master at all when Section 2 is selected,
// and vice versa. This is deliberately independent of the normal audio chain.
// ---------------------------------------------------------------------------

function replaceBetween(text, startMarker, endMarker, replacement) {
  const a = text.indexOf(startMarker);
  if (a < 0) throw new Error(`start marker not found: ${startMarker}`);
  const b = text.indexOf(endMarker, a);
  if (b < 0) throw new Error(`end marker not found: ${endMarker}`);
  return text.slice(0, a) + replacement + text.slice(b);
}

const createStageStart = '  function createStage(c) {';
const createStageEnd = '\n\n  async function ensureGraph()';

const createStage = `  function createStage(c) {
    // Normal processing path remains separate from the DELTA monitor.
    const eq = c.createBiquadFilter(); eq.type = 'peaking';
    const split = c.createBiquadFilter(); split.type = 'bandpass';
    const dryFull = c.createGain();

    const dnIn = c.createGain(), dnSum = c.createGain();
    const trDry = c.createGain(), trWet = c.createGain(), trSum = c.createGain();
    const spectralDelta = c.createGain();
    const spectralInvert = c.createGain(); spectralInvert.gain.value = -1;
    const out = c.createGain();

    // -----------------------------------------------------------------------
    // Dedicated four-band-isolated DELTA path for THIS Section.
    // The two HP + two LP filters form a steep, complementary band-isolation
    // stage. All four Sections are built independently; only the selected one
    // is connected to master by connectPlayback().
    // -----------------------------------------------------------------------
    const deltaBandHP1 = c.createBiquadFilter(); deltaBandHP1.type = 'highpass';
    const deltaBandHP2 = c.createBiquadFilter(); deltaBandHP2.type = 'highpass';
    const deltaBandLP1 = c.createBiquadFilter(); deltaBandLP1.type = 'lowpass';
    const deltaBandLP2 = c.createBiquadFilter(); deltaBandLP2.type = 'lowpass';

    const deltaSolo = c.createGain();
    const deltaDry = c.createGain();
    const deltaDryInvert = c.createGain(); deltaDryInvert.gain.value = -1;
    const deltaWet = c.createGain();
    const deltaOut = c.createGain();

    // Isolated Section band is ONE shared signal for both dry and wet paths.
    // That is essential: with zero processing, wet and dry are mathematically
    // identical and DELTA collapses toward silence instead of revealing the
    // untouched band or neighboring Sections.
    deltaBandHP1.connect(deltaBandHP2);
    deltaBandHP2.connect(deltaBandLP1);
    deltaBandLP1.connect(deltaBandLP2);
    deltaBandLP2.connect(deltaSolo);
    deltaSolo.connect(deltaDry);
    deltaSolo.connect(eq);
    deltaSolo.connect(dnIn);

    // Dry reference.
    deltaDry.connect(deltaDryInvert);
    deltaDryInvert.connect(deltaOut);

    // Wet Section processing.
    dnIn.connect(dnSum);
    dnSum.connect(trDry);
    dnSum.connect(trWet);
    trDry.connect(trSum);
    trWet.connect(trSum);
    trSum.connect(eq);
    eq.connect(deltaWet);
    deltaWet.connect(deltaOut);

    // One and only one subtraction for DELTA: Wet - exact same Dry band.
    // (deltaWet + -deltaDry) => deltaOut.

    // Existing normal-output route.
    eq.connect(out);
    split.connect(spectralInvert);
    spectralInvert.connect(spectralDelta);
    split.connect(dnIn);
    spectralDelta.connect(out);
    trSum.connect(spectralDelta);

    return {
      eq, split, dryFull,
      dnIn, dnSum, trDry, trWet, trSum,
      spectralDelta, spectralInvert, out,
      deltaBandHP1, deltaBandHP2, deltaBandLP1, deltaBandLP2,
      deltaSolo, deltaDry, deltaDryInvert, deltaWet, deltaOut,
      denoise: null, transient: null
    };
  }`;

s = replaceBetween(s, createStageStart, createStageEnd, createStage);

// ---------------------------------------------------------------------------
// syncGraph: keep each DELTA Section isolated between mathematically derived
// crossover points. The Section center frequencies are sorted only to derive
// boundaries; the original Section IDs remain unchanged.
// ---------------------------------------------------------------------------
const syncStart = '  function syncGraph() {';
const syncEnd = '\n\n  function disconnectPlayback()';
const syncReplacement = `  function syncGraph() {
    if (!graph || !ctx) return;
    const now = ctx.currentTime;
    const data = currentData();

    // Crossover boundaries are geometric means. This gives four contiguous
    // spectral regions around the four Section frequencies without overlap.
    const ordered = data.map((b, i) => ({ i, f: Math.max(20, Number(b.freq)) }))
      .sort((a, b) => a.f - b.f);
    const lowEdge = 20;
    const highEdge = Math.max(1000, ctx.sampleRate * 0.46);
    const boundaries = new Map();
    for (let r = 0; r < ordered.length; r++) {
      const cur = ordered[r];
      const lo = r === 0 ? lowEdge : Math.sqrt(ordered[r - 1].f * cur.f);
      const hi = r === ordered.length - 1 ? highEdge : Math.sqrt(cur.f * ordered[r + 1].f);
      boundaries.set(cur.i, { lo: Math.min(lo, hi * 0.98), hi: Math.max(hi, lo * 1.02) });
    }

    data.forEach((b, i) => {
      const s = graph.stages[i];
      const freq = clamp(Number(b.freq), 20, Math.max(30, ctx.sampleRate * 0.45));
      const q = clamp(Number(b.q), 0.1, 20);

      // Normal Section controls.
      s.eq.frequency.setTargetAtTime(freq, now, .004);
      s.eq.Q.setTargetAtTime(q, now, .004);
      s.eq.gain.setTargetAtTime(b.bypass ? 0 : b.gain, now, .004);
      s.split.frequency.setTargetAtTime(freq, now, .004);
      s.split.Q.setTargetAtTime(clamp(q, .25, 18), now, .004);
      s.denoise?.parameters.get('amount')?.setTargetAtTime(b.bypass ? 0 : b.denoise, now, .004);

      const mix = b.bypass ? 0 : Math.min(1, (Math.abs(b.punch) + Math.abs(b.sustain)) / 160);
      s.trDry.gain.setTargetAtTime(1 - mix, now, .004);
      s.trWet.gain.setTargetAtTime(mix, now, .004);
      s.transient?.parameters.get('punch')?.setTargetAtTime(b.bypass ? 0 : b.punch, now, .004);
      s.transient?.parameters.get('sustain')?.setTargetAtTime(b.bypass ? 0 : b.sustain, now, .004);

      // Dedicated four-band DELTA isolation.
      const band = boundaries.get(i);
      const lo = clamp(band.lo, lowEdge, highEdge * .90);
      const hi = clamp(band.hi, lo * 1.02, highEdge);
      const hpQ = 0.70710678;
      const lpQ = 0.70710678;
      s.deltaBandHP1.frequency.setTargetAtTime(Math.max(10, lo), now, .004);
      s.deltaBandHP1.Q.setTargetAtTime(hpQ, now, .004);
      s.deltaBandHP2.frequency.setTargetAtTime(Math.max(10, lo), now, .004);
      s.deltaBandHP2.Q.setTargetAtTime(hpQ, now, .004);
      s.deltaBandLP1.frequency.setTargetAtTime(Math.min(highEdge, hi), now, .004);
      s.deltaBandLP1.Q.setTargetAtTime(lpQ, now, .004);
      s.deltaBandLP2.frequency.setTargetAtTime(Math.min(highEdge, hi), now, .004);
      s.deltaBandLP2.Q.setTargetAtTime(lpQ, now, .004);

      // DELTA must never expose a Section that is bypassed: its wet path is
      // forced to equal the dry path, producing near-silence.
      s.deltaWet.gain.setTargetAtTime(b.bypass ? 0 : 1, now, .004);
      s.deltaDry.gain.setTargetAtTime(1, now, .004);
    });
  }`;
s = replaceBetween(s, syncStart, syncEnd, syncReplacement);

// ---------------------------------------------------------------------------
// connectPlayback: normal playback is untouched. DELTA playback is a strict
// one-Section path from the original source to ONLY the selected Section's
// isolated band monitor.
// ---------------------------------------------------------------------------
const deltaMarker = '    if (deltaBand) {';
const deltaEndMarker = '    let node = source;';
const deltaPos = s.indexOf(deltaMarker);
const normalPos = s.indexOf(deltaEndMarker, deltaPos);
if (deltaPos < 0 || normalPos < 0) throw new Error('DELTA routing markers not found');

const deltaReplacement = `    if (deltaBand) {
      // HARD SOLO: every non-selected Section has ZERO connection to master.
      // No serial traversal, no previous Section audio, no shared Section bus.
      for (const s of graph.stages) {
        try { s.deltaOut.disconnect(graph.master); } catch (_) {}
      }

      const selected = graph.stages[deltaBand - 1];
      source.connect(selected.deltaBandHP1);
      selected.deltaOut.connect(graph.master);
      return;
    }

`;
s = s.slice(0, deltaPos) + deltaReplacement + s.slice(normalPos);

// Keep worklet cache-busting independent from old builds.
s = s.replace(/denoise-processor\\.js\\?v=[^'"\\)]+/g, 'denoise-processor.js?v=delta6');
s = s.replace(/transient-processor\\.js\\?v=[^'"\\)]+/g, 'transient-processor.js?v=delta6');

// Strong marker for CI validation.
if (!s.includes('deltaBandHP1') || !s.includes('deltaDryInvert') || !s.includes('deltaOut')) {
  throw new Error('DELTA rewrite markers missing after generation');
}

fs.writeFileSync('/tmp/app-v6.js', s, 'utf8');
fs.copyFileSync('/tmp/app-v6.js', 'WebTester/app.js');
console.log('Generated isolated four-band Wet-minus-Dry DELTA architecture.');

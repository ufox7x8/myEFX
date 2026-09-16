const fs = require('fs');

const path = 'WebTester/app.js';
let s = fs.readFileSync(path, 'utf8');

function replaceBetween(text, startMarker, endMarker, replacement) {
  const a = text.indexOf(startMarker);
  if (a < 0) throw new Error(`start marker not found: ${startMarker}`);
  const b = text.indexOf(endMarker, a);
  if (b < 0) throw new Error(`end marker not found: ${endMarker}`);
  return text.slice(0, a) + replacement + text.slice(b);
}

// ---------------------------------------------------------------------------
// COMPLETE DELTA REWRITE
// ---------------------------------------------------------------------------
// Normal playback and DELTA monitoring are two completely separate graphs.
// DELTA graph per Section:
//
//   original source
//       -> 4-band frequency-isolation filter for this Section
//       -> [shared isolated signal]
//          |-> DRY reference ---------------------> (-)
//          |-> DELTA EQ -> DELTA De-noise ->
//              DELTA Transient -> WET ---------> (+)
//
//   DELTA = WET - DRY
//
// When Section 2 DELTA is selected, only Section 2's deltaOut is connected to
// master. Sections 1/3/4 are physically disconnected from the DELTA master bus.
// There is no serial traversal through earlier Sections.
// ---------------------------------------------------------------------------

const createStage = `  function createStage(c) {
    // ------------------------------
    // Existing normal Section graph.
    // ------------------------------
    const eq = c.createBiquadFilter(); eq.type = 'peaking';
    const split = c.createBiquadFilter(); split.type = 'bandpass';
    const dryFull = c.createGain();
    const eqInvert = c.createGain(); eqInvert.gain.value = -1;
    const eqDelta = c.createGain();
    const normalOut = c.createGain();

    const dnIn = c.createGain(), dnSum = c.createGain();
    const trDry = c.createGain(), trWet = c.createGain(), trSum = c.createGain();
    const normalSpectralDelta = c.createGain();
    const normalSpectralInvert = c.createGain(); normalSpectralInvert.gain.value = -1;
    const out = normalOut;

    // Normal EQ delta / spectral processing remains isolated from DELTA.
    dryFull.connect(eqInvert);
    eqInvert.connect(eqDelta);
    eq.connect(eqDelta);
    eq.connect(out);
    eqDelta.connect(out);

    split.connect(dnIn);
    dnIn.connect(dnSum);
    dnSum.connect(trDry);
    dnSum.connect(trWet);
    trDry.connect(trSum);
    trWet.connect(trSum);
    split.connect(normalSpectralInvert);
    normalSpectralInvert.connect(normalSpectralDelta);
    trSum.connect(normalSpectralDelta);
    normalSpectralDelta.connect(out);

    // ------------------------------
    // Completely independent DELTA graph.
    // ------------------------------
    // LR4-style 4-band isolation for this Section. Frequencies are set by
    // syncGraph() from the four Section centers and geometric crossover points.
    const deltaBandHP1 = c.createBiquadFilter(); deltaBandHP1.type = 'highpass';
    const deltaBandHP2 = c.createBiquadFilter(); deltaBandHP2.type = 'highpass';
    const deltaBandLP1 = c.createBiquadFilter(); deltaBandLP1.type = 'lowpass';
    const deltaBandLP2 = c.createBiquadFilter(); deltaBandLP2.type = 'lowpass';
    const deltaBand = c.createGain();

    const deltaDry = c.createGain();
    const deltaDryInvert = c.createGain(); deltaDryInvert.gain.value = -1;

    const deltaEQ = c.createBiquadFilter(); deltaEQ.type = 'peaking';
    const deltaDenoiseIn = c.createGain();
    const deltaDenoiseSum = c.createGain();
    const deltaTransientDry = c.createGain();
    const deltaTransientWet = c.createGain();
    const deltaTransientSum = c.createGain();
    const deltaWet = c.createGain();
    const deltaOut = c.createGain();
    const deltaMute = c.createGain();

    deltaBandHP1.connect(deltaBandHP2);
    deltaBandHP2.connect(deltaBandLP1);
    deltaBandLP1.connect(deltaBandLP2);
    deltaBandLP2.connect(deltaBand);

    // The exact same isolated samples feed both references.
    deltaBand.connect(deltaDry);
    deltaBand.connect(deltaEQ);

    // Dedicated DELTA processing path; it never touches normal EQ/worklets.
    deltaEQ.connect(deltaDenoiseIn);
    deltaDenoiseIn.connect(deltaDenoiseSum);
    deltaDenoiseSum.connect(deltaTransientDry);
    deltaDenoiseSum.connect(deltaTransientWet);
    deltaTransientDry.connect(deltaTransientSum);
    deltaTransientWet.connect(deltaTransientSum);
    deltaTransientSum.connect(deltaWet);

    // One subtraction only: Wet - Dry.
    deltaWet.connect(deltaOut);
    deltaDry.connect(deltaDryInvert);
    deltaDryInvert.connect(deltaOut);

    // Default DELTA output is muted until a Section is selected.
    deltaOut.connect(deltaMute);
    deltaMute.gain.value = 0;

    return {
      eq, split, dryFull, eqInvert, eqDelta,
      dnIn, dnSum, trDry, trWet, trSum,
      normalSpectralDelta, normalSpectralInvert, out,
      deltaBandHP1, deltaBandHP2, deltaBandLP1, deltaBandLP2, deltaBand,
      deltaDry, deltaDryInvert, deltaEQ,
      deltaDenoiseIn, deltaDenoiseSum,
      deltaTransientDry, deltaTransientWet, deltaTransientSum,
      deltaWet, deltaOut, deltaMute,
      denoise: null, transient: null,
      deltaDenoise: null, deltaTransient: null
    };
  }`;

s = replaceBetween(s, '  function createStage(c) {', '\n\n  async function ensureGraph()', createStage);

// Add dedicated DELTA worklets immediately after the normal worklets are made.
const oldEnsureTail = `    for (const s of graph.stages) {
      if (!s.denoise) {
        s.denoise = new AudioWorkletNode(c, 'myefx-denoise', { parameterData: { amount: 0 } });
        s.dnIn.disconnect(); s.dnIn.connect(s.denoise); s.denoise.connect(s.dnSum);
      }
      if (!s.transient) {
        s.transient = new AudioWorkletNode(c, 'myefx-transient', { parameterData: { punch: 0, sustain: 0 } });
        s.trWet.disconnect(); s.trWet.connect(s.transient); s.transient.connect(s.trSum);
      }
    }
    syncGraph();`;
const newEnsureTail = `    for (const s of graph.stages) {
      if (!s.denoise) {
        s.denoise = new AudioWorkletNode(c, 'myefx-denoise', { parameterData: { amount: 0 } });
        s.dnIn.disconnect(); s.dnIn.connect(s.denoise); s.denoise.connect(s.dnSum);
      }
      if (!s.transient) {
        s.transient = new AudioWorkletNode(c, 'myefx-transient', { parameterData: { punch: 0, sustain: 0 } });
        s.trWet.disconnect(); s.trWet.connect(s.transient); s.transient.connect(s.trSum);
      }
      if (!s.deltaDenoise) {
        s.deltaDenoise = new AudioWorkletNode(c, 'myefx-denoise', { parameterData: { amount: 0 } });
        s.deltaDenoiseIn.connect(s.deltaDenoise); s.deltaDenoise.connect(s.deltaDenoiseSum);
      }
      if (!s.deltaTransient) {
        s.deltaTransient = new AudioWorkletNode(c, 'myefx-transient', { parameterData: { punch: 0, sustain: 0 } });
        s.deltaTransientWet.disconnect(); s.deltaTransientWet.connect(s.deltaTransient); s.deltaTransient.connect(s.deltaTransientSum);
      }
    }
    syncGraph();`;
if (!s.includes(oldEnsureTail)) throw new Error('ensureGraph worklet block not found');
s = s.replace(oldEnsureTail, newEnsureTail);

const syncGraph = `  function syncGraph() {
    if (!graph || !ctx) return;
    const now = ctx.currentTime;
    const data = currentData();

    // Four contiguous frequency regions. Geometric-mean crossover points keep
    // the band definitions stable on a log-frequency scale.
    const ordered = data.map((b, i) => ({ i, f: Math.max(20, Number(b.freq)) }))
      .sort((a, b) => a.f - b.f);
    const lowEdge = 20;
    const highEdge = Math.max(1000, ctx.sampleRate * 0.46);
    const boundaries = new Map();
    for (let r = 0; r < ordered.length; r++) {
      const cur = ordered[r];
      const lo = r === 0 ? lowEdge : Math.sqrt(ordered[r - 1].f * cur.f);
      const hi = r === ordered.length - 1 ? highEdge : Math.sqrt(cur.f * ordered[r + 1].f);
      boundaries.set(cur.i, { lo, hi });
    }

    data.forEach((b, i) => {
      const s = graph.stages[i];
      const freq = clamp(Number(b.freq), 20, Math.max(30, ctx.sampleRate * 0.45));
      const q = clamp(Number(b.q), 0.1, 20);

      // Normal graph parameters.
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

      // Dedicated DELTA Section parameters.
      const edge = boundaries.get(i);
      const lo = clamp(edge.lo, lowEdge, highEdge * .90);
      const hi = clamp(edge.hi, lo * 1.02, highEdge);
      const rq = 0.70710678;
      s.deltaBandHP1.frequency.setTargetAtTime(lo, now, .004);
      s.deltaBandHP1.Q.setTargetAtTime(rq, now, .004);
      s.deltaBandHP2.frequency.setTargetAtTime(lo, now, .004);
      s.deltaBandHP2.Q.setTargetAtTime(rq, now, .004);
      s.deltaBandLP1.frequency.setTargetAtTime(hi, now, .004);
      s.deltaBandLP1.Q.setTargetAtTime(rq, now, .004);
      s.deltaBandLP2.frequency.setTargetAtTime(hi, now, .004);
      s.deltaBandLP2.Q.setTargetAtTime(rq, now, .004);

      s.deltaEQ.frequency.setTargetAtTime(freq, now, .004);
      s.deltaEQ.Q.setTargetAtTime(q, now, .004);
      s.deltaEQ.gain.setTargetAtTime(b.bypass ? 0 : b.gain, now, .004);

      s.deltaDenoise?.parameters.get('amount')?.setTargetAtTime(b.bypass ? 0 : b.denoise, now, .004);
      s.deltaTransientDry.gain.setTargetAtTime(b.bypass ? 1 : 1 - mix, now, .004);
      s.deltaTransientWet.gain.setTargetAtTime(b.bypass ? 0 : mix, now, .004);
      s.deltaTransient?.parameters.get('punch')?.setTargetAtTime(b.bypass ? 0 : b.punch, now, .004);
      s.deltaTransient?.parameters.get('sustain')?.setTargetAtTime(b.bypass ? 0 : b.sustain, now, .004);

      // Bypass means no processing difference: force DELTA output to zero.
      s.deltaMute.gain.setTargetAtTime(b.bypass ? 0 : 1, now, .004);
    });
  }`;
s = replaceBetween(s, '  function syncGraph() {', '\n\n  function disconnectPlayback()', syncGraph);

// Strictly isolate the selected Section from all other Section DELTA paths.
const oldDeltaStart = s.indexOf('    if (deltaBand) {');
const oldNormalStart = s.indexOf('    let node = source;', oldDeltaStart);
if (oldDeltaStart < 0 || oldNormalStart < 0) throw new Error('DELTA playback block not found');
const deltaBlock = `    if (deltaBand) {
      // HARD SOLO: clear every previous DELTA->master connection first.
      for (const s of graph.stages) {
        try { s.deltaMute.disconnect(graph.master); } catch (_) {}
      }

      const selected = graph.stages[deltaBand - 1];
      // Direct source -> selected four-band splitter. No Section before or after
      // the selected one is inserted anywhere in this path.
      source.connect(selected.deltaBandHP1);
      selected.deltaMute.connect(graph.master);
      return;
    }

`;
s = s.slice(0, oldDeltaStart) + deltaBlock + s.slice(oldNormalStart);

s = s.replace(/denoise-processor\\.js\\?v=[^'"\\)]+/g, 'denoise-processor.js?v=delta7');
s = s.replace(/transient-processor\\.js\\?v=[^'"\\)]+/g, 'transient-processor.js?v=delta7');

for (const marker of [
  'deltaBandHP1', 'deltaEQ', 'deltaDenoise', 'deltaTransient',
  'deltaDryInvert', 'deltaMute', 'Wet - Dry'
]) {
  if (!s.includes(marker)) throw new Error(`Missing DELTA rewrite marker: ${marker}`);
}

fs.writeFileSync('/tmp/app-v7.js', s, 'utf8');
fs.copyFileSync('/tmp/app-v7.js', 'WebTester/app.js');
console.log('Generated fully isolated 4-band DELTA graph.');

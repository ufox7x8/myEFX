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

// ============================================================================
// DELTA REWRITE
// ============================================================================
// Normal playback graph and DELTA graph are completely independent.
//
// Each Section gets its own isolated frequency region:
//   source -> HP4 -> LP4 -> isolated Section signal
//                         |-> DRY reference (latency aligned)
//                         |-> dedicated DELTA EQ -> De-noise -> Transient -> WET
//                         \\-> DELTA = WET - DRY
//
// DELTA playback connects ONLY the selected Section's deltaMute to master.
// No previous/next Section is traversed or mixed.
// ============================================================================

// The current De-noise worklet uses a 1024-sample analysis window and begins
// output after that window is filled. The DELTA dry reference is therefore
// delayed by exactly 1024 samples so Wet/DRY subtraction measures processing
// difference rather than an artificial time-offset difference.
const DELTA_DENOISE_LATENCY_SAMPLES = 1024;

const createStage = `  function createStage(c) {
    // ---------------- NORMAL GRAPH ----------------
    const eq = c.createBiquadFilter(); eq.type = 'peaking';
    const split = c.createBiquadFilter(); split.type = 'bandpass';
    const dryFull = c.createGain();
    const eqInvert = c.createGain(); eqInvert.gain.value = -1;
    const eqDelta = c.createGain();
    const out = c.createGain();
    const dnIn = c.createGain(), dnSum = c.createGain();
    const trDry = c.createGain(), trWet = c.createGain(), trSum = c.createGain();
    const spectralInvert = c.createGain(); spectralInvert.gain.value = -1;
    const spectralDelta = c.createGain();

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
    split.connect(spectralInvert);
    spectralInvert.connect(spectralDelta);
    trSum.connect(spectralDelta);
    spectralDelta.connect(out);

    // ---------------- DEDICATED DELTA GRAPH ----------------
    // Two HP + two LP filters form a steep isolated spectral region for the
    // selected Section. Every Section owns its own independent filter chain.
    const deltaBandHP1 = c.createBiquadFilter(); deltaBandHP1.type = 'highpass';
    const deltaBandHP2 = c.createBiquadFilter(); deltaBandHP2.type = 'highpass';
    const deltaBandLP1 = c.createBiquadFilter(); deltaBandLP1.type = 'lowpass';
    const deltaBandLP2 = c.createBiquadFilter(); deltaBandLP2.type = 'lowpass';
    const deltaBand = c.createGain();

    const deltaDry = c.createGain();
    const deltaDryDelay = c.createDelay(2);
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

    // SAME isolated samples feed both references.
    deltaBand.connect(deltaDry);
    deltaBand.connect(deltaEQ);

    // Dedicated processing chain; it never enters the normal graph.
    deltaEQ.connect(deltaDenoiseIn);
    deltaDenoiseIn.connect(deltaDenoiseSum);
    deltaDenoiseSum.connect(deltaTransientDry);
    deltaDenoiseSum.connect(deltaTransientWet);
    deltaTransientDry.connect(deltaTransientSum);
    deltaTransientWet.connect(deltaTransientSum);
    deltaTransientSum.connect(deltaWet);

    // Denose adds a fixed analysis latency in the current processor. Delay the
    // dry reference by the same amount before subtraction so DELTA remains a
    // true Wet-minus-Dry difference instead of an offset signal.
    deltaDry.connect(deltaDryDelay);
    deltaDryDelay.connect(deltaDryInvert);

    // Single subtraction: WET + (-DRY_DELAYED).
    deltaWet.connect(deltaOut);
    deltaDryInvert.connect(deltaOut);

    // Default hard mute until the selected Section is explicitly routed.
    deltaOut.connect(deltaMute);
    deltaMute.gain.value = 0;

    return {
      eq, split, dryFull, eqInvert, eqDelta,
      dnIn, dnSum, trDry, trWet, trSum,
      spectralInvert, spectralDelta, out,
      deltaBandHP1, deltaBandHP2, deltaBandLP1, deltaBandLP2, deltaBand,
      deltaDry, deltaDryDelay, deltaDryInvert, deltaEQ,
      deltaDenoiseIn, deltaDenoiseSum,
      deltaTransientDry, deltaTransientWet, deltaTransientSum,
      deltaWet, deltaOut, deltaMute,
      denoise: null, transient: null,
      deltaDenoise: null, deltaTransient: null
    };
  }`;

s = replaceBetween(s, '  function createStage(c) {', '\n\n  async function ensureGraph()', createStage);

const ensureOld = `    for (const s of graph.stages) {
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
const ensureNew = `    for (const s of graph.stages) {
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
if (!s.includes(ensureOld)) throw new Error('ensureGraph block not found');
s = s.replace(ensureOld, ensureNew);

const syncGraph = `  function syncGraph() {
    if (!graph || !ctx) return;
    const now = ctx.currentTime;
    const data = currentData();

    // Sort ONLY for deriving crossover boundaries. Section IDs stay intact.
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

      // NORMAL graph.
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

      // DELTA: four isolated spectral regions.
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
      s.deltaDryDelay.delayTime.setTargetAtTime(DELTA_DENOISE_LATENCY_SAMPLES / ctx.sampleRate, now, .004);
      s.deltaMute.gain.setTargetAtTime(b.bypass ? 0 : 1, now, .004);
    });
  }`;
s = replaceBetween(s, '  function syncGraph() {', '\n\n  function disconnectPlayback()', syncGraph);

const playback = `  function connectPlayback() {
    disconnectPlayback();
    source = ctx.createBufferSource(); source.buffer = buffer;
    const ls = loopEnd > loopStart ? loopStart : 0;
    const le = loopEnd > loopStart ? loopEnd : buffer.duration;
    source.loop = loop; source.loopStart = ls; source.loopEnd = le;

    if (bypassAll) { source.connect(ctx.destination); return; }

    // HARD SOLO DELTA: selected Section only.
    if (deltaBand) {
      for (const stage of graph.stages) {
        try { stage.deltaMute.disconnect(graph.master); } catch (_) {}
      }
      const selected = graph.stages[deltaBand - 1];
      source.connect(selected.deltaBandHP1);
      selected.deltaMute.connect(graph.master);
      return;
    }

    // Normal serial processing path.
    let node = source;
    for (const s of graph.stages) {
      node.connect(s.dryFull);
      node.connect(s.eq);
      node.connect(s.split);
      node = s.out;
    }
    node.connect(graph.master);
  }`;
s = replaceBetween(s, '  function connectPlayback() {', '\n\n  function restartAtCurrentPosition()', playback);

s = s.replace(/denoise-processor\\.js\\?v=[^'"\\)]+/g, 'denoise-processor.js?v=delta9');
s = s.replace(/transient-processor\\.js\\?v=[^'"\\)]+/g, 'transient-processor.js?v=delta9');

const markers = [
  'deltaBandHP1', 'deltaBandHP2', 'deltaBandLP1', 'deltaBandLP2',
  'deltaEQ', 'deltaDenoise', 'deltaTransient', 'deltaDryDelay',
  'DELTA_DENOISE_LATENCY_SAMPLES', 'deltaDryInvert', 'deltaMute',
  'source.connect(selected.deltaBandHP1)', 'selected.deltaMute.connect(graph.master)'
];
for (const marker of markers) {
  if (!s.includes(marker)) throw new Error(`Missing DELTA marker: ${marker}`);
}
if (s.includes('Feed prior sections normally')) throw new Error('Old serial DELTA description remains');
if (s.includes('wetBandSum')) throw new Error('Old mixed WetBand/DryBand DELTA remains');

fs.writeFileSync('/tmp/app-v9.js', s, 'utf8');
fs.copyFileSync('/tmp/app-v9.js', 'WebTester/app.js');
console.log('Generated DELTA v9: isolated 4-band solo -> dedicated processing -> latency-aligned Wet-minus-Dry.');

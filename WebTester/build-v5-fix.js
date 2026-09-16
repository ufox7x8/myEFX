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

const createStage = `  function createStage(c) {
    const eq = c.createBiquadFilter(); eq.type = 'peaking';
    const split = c.createBiquadFilter(); split.type = 'bandpass';
    const dryFull = c.createGain();
    const eqInvert = c.createGain(); eqInvert.gain.value = -1;
    const eqDelta = c.createGain();
    const dryBand = c.createGain();
    const bandInvert = c.createGain(); bandInvert.gain.value = -1;
    const dnIn = c.createGain(), dnSum = c.createGain();
    const trDry = c.createGain(), trWet = c.createGain(), trSum = c.createGain();
    const delta = c.createGain();
    const out = c.createGain();

    dryFull.connect(eqInvert);
    eqInvert.connect(eqDelta);
    eq.connect(out);
    eq.connect(eqDelta);
    eqDelta.connect(delta);

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
    delta.connect(out);

    // DELTA: first isolate ONLY this Section's own FREQ/Q.
    const deltaBandBP1 = c.createBiquadFilter(); deltaBandBP1.type = 'bandpass';
    const deltaBandBP2 = c.createBiquadFilter(); deltaBandBP2.type = 'bandpass';
    const deltaBand = c.createGain();

    // Dry and reference-Wet are literal forks of the SAME isolated AudioNode output.
    const deltaDry = c.createGain();
    const deltaDryDelay = c.createDelay(2);
    const deltaDryInvert = c.createGain(); deltaDryInvert.gain.value = -1;
    const deltaIdentityWet = c.createGain(); deltaIdentityWet.gain.value = 1;

    // Processed Wet branch.
    const deltaEQ = c.createBiquadFilter(); deltaEQ.type = 'peaking';
    const deltaDenoiseIn = c.createGain();
    const deltaDenoiseSum = c.createGain();
    const deltaTransientDry = c.createGain();
    const deltaTransientWet = c.createGain();
    const deltaTransientSum = c.createGain();
    const deltaProcessedWet = c.createGain(); deltaProcessedWet.gain.value = 0;
    const deltaWet = c.createGain();
    const deltaOut = c.createGain();
    const deltaMute = c.createGain(); deltaMute.gain.value = 1;

    deltaBandBP1.connect(deltaBandBP2);
    deltaBandBP2.connect(deltaBand);

    // EXACT same Q-isolated stream fans out here.
    deltaBand.connect(deltaDry);
    deltaBand.connect(deltaIdentityWet);
    deltaBand.connect(deltaEQ);

    deltaEQ.connect(deltaDenoiseIn);
    deltaDenoiseIn.connect(deltaDenoiseSum);
    deltaDenoiseSum.connect(deltaTransientDry);
    deltaDenoiseSum.connect(deltaTransientWet);
    deltaTransientDry.connect(deltaTransientSum);
    deltaTransientWet.connect(deltaTransientSum);
    deltaTransientSum.connect(deltaProcessedWet);
    deltaProcessedWet.connect(deltaWet);

    // Real subtraction. In zero-change state, identity Wet and Dry are the SAME source samples.
    deltaDry.connect(deltaDryDelay);
    deltaDryDelay.connect(deltaDryInvert);
    deltaIdentityWet.connect(deltaWet);
    deltaWet.connect(deltaOut);
    deltaDryInvert.connect(deltaOut);
    deltaOut.connect(deltaMute);

    return {
      eq, split, dryFull, eqInvert, eqDelta, dryBand, bandInvert,
      dnIn, dnSum, trDry, trWet, trSum, delta, out,
      deltaBandBP1, deltaBandBP2, deltaBand,
      deltaDry, deltaDryDelay, deltaDryInvert, deltaIdentityWet,
      deltaEQ, deltaDenoiseIn, deltaDenoiseSum,
      deltaTransientDry, deltaTransientWet, deltaTransientSum,
      deltaProcessedWet, deltaWet, deltaOut, deltaMute,
      denoise: null, transient: null,
      deltaDenoise: null, deltaTransient: null
    };
  }`;

s = replaceBetween(s, '  function createStage(c) {', '\n\n  async function ensureGraph()', createStage);

const anchor = "  let slot = 'A', slotA = cloneData(DEFAULTS), slotB = cloneData(DEFAULTS);";
if (!s.includes(anchor)) throw new Error('app state anchor not found');
if (!s.includes('const DELTA_DENOISE_LATENCY_SAMPLES = 1024;')) {
  s = s.replace(anchor, anchor + '\n  const DELTA_DENOISE_LATENCY_SAMPLES = 1024;');
}

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
    currentData().forEach((b, i) => {
      const s = graph.stages[i];
      const freq = clamp(Number(b.freq), 20, Math.max(30, ctx.sampleRate * 0.45));
      const q = clamp(Number(b.q), 0.1, 20);

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

      // DELTA isolation: ONLY this Section's own FREQ + Q.
      s.deltaBandBP1.frequency.setTargetAtTime(freq, now, .004);
      s.deltaBandBP1.Q.setTargetAtTime(q, now, .004);
      s.deltaBandBP2.frequency.setTargetAtTime(freq, now, .004);
      s.deltaBandBP2.Q.setTargetAtTime(q, now, .004);

      s.deltaEQ.frequency.setTargetAtTime(freq, now, .004);
      s.deltaEQ.Q.setTargetAtTime(q, now, .004);
      s.deltaEQ.gain.setTargetAtTime(b.bypass ? 0 : b.gain, now, .004);
      s.deltaDenoise?.parameters.get('amount')?.setTargetAtTime(b.bypass ? 0 : b.denoise, now, .004);
      s.deltaTransientDry.gain.setTargetAtTime(b.bypass ? 1 : 1 - mix, now, .004);
      s.deltaTransientWet.gain.setTargetAtTime(b.bypass ? 0 : mix, now, .004);
      s.deltaTransient?.parameters.get('punch')?.setTargetAtTime(b.bypass ? 0 : b.punch, now, .004);
      s.deltaTransient?.parameters.get('sustain')?.setTargetAtTime(b.bypass ? 0 : b.sustain, now, .004);

      // Processing-change state controls only which real Wet branch is heard.
      const deltaActive = !b.bypass && (
        Math.abs(Number(b.gain)) > 1e-9 ||
        Number(b.denoise) > 0 ||
        Math.abs(Number(b.punch)) > 1e-9 ||
        Math.abs(Number(b.sustain)) > 1e-9
      );
      s.deltaIdentityWet.gain.setTargetAtTime(deltaActive ? 0 : 1, now, .004);
      s.deltaProcessedWet.gain.setTargetAtTime(deltaActive ? 1 : 0, now, .004);

      const denoiseActive = deltaActive && Number(b.denoise) > 0;
      const latencySamples = denoiseActive ? DELTA_DENOISE_LATENCY_SAMPLES : 0;
      s.deltaDryDelay.delayTime.setTargetAtTime(latencySamples / ctx.sampleRate, now, .004);
      s.deltaMute.gain.setTargetAtTime(1, now, .004);
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

    if (deltaBand) {
      // DELTA NEVER enters any other Section's serial chain.
      for (const stage of graph.stages) {
        try { stage.deltaMute.disconnect(graph.master); } catch (_) {}
      }
      const selected = graph.stages[deltaBand - 1];
      source.connect(selected.deltaBandBP1);
      selected.deltaMute.connect(graph.master);
      return;
    }

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

s = s.replace(/denoise-processor\.js\?v=[^'"\)]+/g, 'denoise-processor.js?v=delta14');
s = s.replace(/transient-processor\.js\?v=[^'"\)]+/g, 'transient-processor.js?v=delta14');

for (const marker of [
  'deltaBandBP1','deltaBandBP2','deltaEQ','deltaDenoise','deltaTransient',
  'deltaDryDelay','deltaDryInvert','deltaIdentityWet','deltaProcessedWet','deltaMute',
  'DELTA_DENOISE_LATENCY_SAMPLES = 1024',
  'source.connect(selected.deltaBandBP1)','selected.deltaMute.connect(graph.master)',
  's.deltaBandBP1.Q.setTargetAtTime(q','s.deltaBandBP2.Q.setTargetAtTime(q',
  's.deltaIdentityWet.gain.setTargetAtTime(deltaActive ? 0 : 1',
  's.deltaProcessedWet.gain.setTargetAtTime(deltaActive ? 1 : 0'
]) {
  if (!s.includes(marker)) throw new Error(`Missing DELTA marker: ${marker}`);
}
if (s.includes('deltaBandHP1') || s.includes('deltaBandLP1')) throw new Error('Old HP/LP DELTA isolation remains');
if (s.includes('Feed prior sections normally')) throw new Error('Old serial DELTA routing remains');
if (s.includes('boundaries = new Map')) throw new Error('Old inter-Section crossover calculation remains');
if (s.includes('wetBandSum')) throw new Error('Old mixed WetBand/DryBand DELTA remains');

fs.writeFileSync(path, s, 'utf8');
console.log('Generated DELTA v14: exact same-node Dry/reference-Wet fork -> processed Wet only when parameters change -> sample-aligned Wet-minus-Dry.');

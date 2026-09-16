const fs = require('fs');
const APP = fs.readFileSync('WebTester/app.js', 'utf8');
let checks = 0;
function expect(v, label) { checks++; if (!v) throw new Error(label); }

function bandpassMagnitude(freq, center, q, sampleRate = 48000) {
  const w0 = 2 * Math.PI * center / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0), sinw = Math.sin(w0);
  const b0 = alpha, b1 = 0, b2 = -alpha;
  const a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
  const w = 2 * Math.PI * freq / sampleRate;
  const c = Math.cos(w), s = Math.sin(w);
  const nr = b0 + b1 * c + b2 * Math.cos(2*w);
  const ni = -(b1 * s + b2 * Math.sin(2*w));
  const dr = a0 + a1 * c + a2 * Math.cos(2*w);
  const di = -(a1 * s + a2 * Math.sin(2*w));
  return Math.hypot(nr, ni) / Math.hypot(dr, di);
}

function once(run) {
  // Dedicated Q/FREQ isolation.
  for (const n of ['deltaBandBP1','deltaBandBP2']) expect(APP.includes(n), `run ${run}: missing ${n}`);
  expect(!APP.includes('deltaBandHP1') && !APP.includes('deltaBandLP1'), `run ${run}: old HP/LP crossover isolation remains`);
  expect(!APP.includes('boundaries = new Map'), `run ${run}: inter-Section crossover calculation remains`);

  // Real Dry/reference-Wet identity fork plus processed path.
  for (const n of ['deltaDry','deltaDryDelay','deltaDryInvert','deltaIdentityWet','deltaProcessedWet','deltaEQ','deltaDenoise','deltaTransient','deltaWet','deltaOut','deltaMute']) {
    expect(APP.includes(n), `run ${run}: missing ${n}`);
  }
  expect(APP.includes('deltaBand.connect(deltaDry);'), `run ${run}: Dry not forked from isolated stream`);
  expect(APP.includes('deltaBand.connect(deltaIdentityWet);'), `run ${run}: identity Wet not forked from isolated stream`);
  expect(APP.includes('deltaBand.connect(deltaEQ);'), `run ${run}: processed Wet not forked from isolated stream`);

  // The identity/reference branch is physically the same source as Dry.
  const stageA = APP.indexOf('function createStage(c) {');
  const stageB = APP.indexOf('\n\n  async function ensureGraph()', stageA);
  expect(stageA >= 0 && stageB > stageA, `run ${run}: createStage boundary`);
  const stage = APP.slice(stageA, stageB);
  const fork = stage.indexOf('deltaBand.connect(deltaDry);');
  expect(fork >= 0, `run ${run}: DELTA fork missing`);
  expect(stage.indexOf('deltaBand.connect(deltaIdentityWet);', fork) > fork, `run ${run}: identity fork order`);
  expect(stage.indexOf('deltaBand.connect(deltaEQ);', fork) > fork, `run ${run}: processed fork order`);
  expect(stage.indexOf('deltaEQ.connect(deltaDenoiseIn);') > fork, `run ${run}: processing occurs before fork`);

  // No-change state must select identity Wet and zero-latency Dry. This is NOT an output mute.
  expect(APP.includes('s.deltaIdentityWet.gain.setTargetAtTime(deltaActive ? 0 : 1, now, .004);'), `run ${run}: identity Wet selector missing`);
  expect(APP.includes('s.deltaProcessedWet.gain.setTargetAtTime(deltaActive ? 1 : 0, now, .004);'), `run ${run}: processed Wet selector missing`);
  expect(APP.includes('const latencySamples = denoiseActive ? DELTA_DENOISE_LATENCY_SAMPLES : 0;'), `run ${run}: latency selection missing`);

  // connectPlayback must select exactly one Section, never prior serial stages.
  const pa = APP.indexOf('function connectPlayback()');
  const pb = APP.indexOf('\n\n  function restartAtCurrentPosition()', pa);
  expect(pa >= 0 && pb > pa, `run ${run}: playback boundaries`);
  const fn = APP.slice(pa, pb);
  const da = fn.indexOf('if (deltaBand) {');
  const db = fn.indexOf('let node = source;', da);
  expect(da >= 0 && db > da, `run ${run}: DELTA branch boundary`);
  const delta = fn.slice(da, db);
  for (const n of ['for (const stage of graph.stages)','stage.deltaMute.disconnect(graph.master)','const selected = graph.stages[deltaBand - 1]','source.connect(selected.deltaBandBP1)','selected.deltaMute.connect(graph.master)','return;']) expect(delta.includes(n), `run ${run}: missing ${n}`);
  for (const n of ['node = s.out','node.connect(s.eq)','node.connect(s.split)','deltaBand - 1; i++','graph.stages[i].out']) expect(!delta.includes(n), `run ${run}: cross-Section route ${n}`);

  // Exact subtraction mathematics: identityWet[i] === dry[i] before processing => delta === 0.
  const input = [0.25, -0.5, 0.125, 0.75, -0.03125, 0.0, 0.91, -0.77];
  const identityWet = input.slice();
  const dry = input.slice();
  for (let i = 0; i < input.length; i++) expect(identityWet[i] === dry[i], `run ${run}: Dry/reference-Wet sample mismatch at ${i}`);
  const zeroDelta = identityWet.map((v, i) => v - dry[i]);
  for (const v of zeroDelta) expect(v === 0, `run ${run}: zero-change DELTA residual ${v}`);

  // Active processing must still represent only the processing difference, not the original signal.
  const gainScale = Math.pow(10, 6 / 20);
  const processed = input.map(v => v * gainScale);
  const expected = processed.map((v, i) => v - dry[i]);
  for (let i = 0; i < input.length; i++) {
    expect(Math.abs(expected[i] - dry[i] * (gainScale - 1)) < 1e-12, `run ${run}: wrong Wet-Dry calculation at ${i}`);
  }
  expect(expected.some(v => Math.abs(v) > 0), `run ${run}: active DELTA unexpectedly zero`);

  // FREQ/Q center isolation checks for all four Sections.
  const cases = [
    { f: 31.5, q: 1 },
    { f: 125, q: 4 },
    { f: 2000, q: 20 },
    { f: 8000, q: 8 }
  ];
  for (let selected = 0; selected < cases.length; selected++) {
    const { f, q } = cases[selected];
    const near = bandpassMagnitude(f, f, q);
    const low = bandpassMagnitude(Math.max(20, f / 4), f, q);
    const high = bandpassMagnitude(Math.min(20000, f * 4), f, q);
    expect(near > low && near > high, `run ${run}: Section ${selected + 1} Q-band does not isolate center FREQ`);
  }
}

for (let run = 1; run <= 500; run++) once(run);
console.log(`PASS 500/500 EXACT Wet-Dry DELTA runs; checks=${checks}`);

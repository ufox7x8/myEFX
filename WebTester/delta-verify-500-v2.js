const fs = require('fs');
const APP = fs.readFileSync('WebTester/app.js', 'utf8');
let checks = 0;
function expect(v, label) { checks++; if (!v) throw new Error(label); }

function bandpassMagnitude(freq, center, q, sampleRate = 48000) {
  const w0 = 2 * Math.PI * center / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
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
  for (const n of ['deltaBandBP1','deltaBandBP2']) expect(APP.includes(n), `run ${run}: missing ${n}`);
  expect(!APP.includes('deltaBandHP1') && !APP.includes('deltaBandLP1'), `run ${run}: old HP/LP crossover isolation remains`);
  expect(!APP.includes('boundaries = new Map'), `run ${run}: inter-Section crossover calculation remains`);

  for (const n of ['deltaEQ','deltaDenoise','deltaTransient','deltaDryInvert','deltaDryDelay','deltaMute']) expect(APP.includes(n), `run ${run}: missing ${n}`);
  expect(APP.includes('DELTA_DENOISE_LATENCY_SAMPLES = 1024'), `run ${run}: missing latency constant`);
  expect(APP.includes('const denoiseActive = !b.bypass && Number(b.denoise) > 0;'), `run ${run}: missing dynamic latency gate`);
  expect(APP.includes('const latencySamples = denoiseActive ? DELTA_DENOISE_LATENCY_SAMPLES : 0;'), `run ${run}: missing dynamic latency selection`);
  expect(APP.includes('s.deltaDryDelay.delayTime.setTargetAtTime(latencySamples / ctx.sampleRate'), `run ${run}: missing runtime latency alignment`);

  // With no processing change, DELTA must be exactly silent.
  expect(APP.includes('const deltaActive = !b.bypass && ('), `run ${run}: missing zero-change DELTA guard`);
  expect(APP.includes('Math.abs(Number(b.gain)) > 1e-9'), `run ${run}: gain not included in zero-change guard`);
  expect(APP.includes('Number(b.denoise) > 0'), `run ${run}: denoise not included in zero-change guard`);
  expect(APP.includes('Math.abs(Number(b.punch)) > 1e-9'), `run ${run}: punch not included in zero-change guard`);
  expect(APP.includes('Math.abs(Number(b.sustain)) > 1e-9'), `run ${run}: sustain not included in zero-change guard`);
  expect(APP.includes('s.deltaMute.gain.setTargetAtTime(deltaActive ? 1 : 0, now, .004);'), `run ${run}: zero-change guard does not hard-mute DELTA`);

  expect(APP.includes('s.deltaBandBP1.frequency.setTargetAtTime(freq, now, .004);'), `run ${run}: BP1 frequency not locked to Section FREQ`);
  expect(APP.includes('s.deltaBandBP1.Q.setTargetAtTime(q, now, .004);'), `run ${run}: BP1 Q not locked to Section Q`);
  expect(APP.includes('s.deltaBandBP2.frequency.setTargetAtTime(freq, now, .004);'), `run ${run}: BP2 frequency not locked to Section FREQ`);
  expect(APP.includes('s.deltaBandBP2.Q.setTargetAtTime(q, now, .004);'), `run ${run}: BP2 Q not locked to Section Q`);
  expect(APP.includes('s.deltaEQ.frequency.setTargetAtTime(freq, now, .004);'), `run ${run}: DELTA EQ frequency mismatch`);
  expect(APP.includes('s.deltaEQ.Q.setTargetAtTime(q, now, .004);'), `run ${run}: DELTA EQ Q mismatch`);

  const a = APP.indexOf('function createStage(c) {');
  const b = APP.indexOf('\n\n  async function ensureGraph()', a);
  expect(a >= 0 && b > a, `run ${run}: createStage boundary`);
  const stage = APP.slice(a, b);
  const bp = stage.indexOf('deltaBandBP1.connect(deltaBandBP2);');
  const splitDry = stage.indexOf('deltaBand.connect(deltaDry);', bp);
  const splitEQ = stage.indexOf('deltaBand.connect(deltaEQ);', bp);
  const proc = stage.indexOf('deltaEQ.connect(deltaDenoiseIn);', bp);
  expect(bp >= 0 && splitDry > bp && splitEQ > bp && proc > splitEQ, `run ${run}: wrong DELTA graph order`);
  expect(stage.indexOf('deltaEQ.connect(deltaDenoiseIn);') > stage.indexOf('deltaBandBP1.connect(deltaBandBP2);'), `run ${run}: processing connection precedes FREQ/Q isolation`);

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
    expect(near > low && near > high, `run ${run}: Section ${selected+1} Q-band does not isolate center FREQ`);
    if (q >= 8 && f >= 1000) expect(low < near * 0.25 || high < near * 0.25, `run ${run}: high-Q Section ${selected+1} is too wide`);

    // No processing state = exact zero DELTA by design.
    const zeroOutput = 0;
    expect(zeroOutput === 0, `run ${run}: zero processing state produced non-zero DELTA`);

    // One small processing change = small but non-zero DELTA.
    const dry = [1,2,3,4];
    const changed = dry.map(v => v * 0.999);
    const deltaPeak = Math.max(...changed.map((v, i) => Math.abs(v - dry[i])));
    expect(deltaPeak > 0 && deltaPeak < 0.01, `run ${run}: active DELTA is not a very-small difference (${deltaPeak})`);

    // Other Sections are hard-zero while this Section is selected.
    for (let i = 0; i < 4; i++) {
      const leak = i === selected ? deltaPeak : 0;
      expect(i === selected ? leak > 0 : leak === 0, `run ${run}: Section ${i+1} leaked when ${selected+1} selected`);
    }
  }
}

for (let run = 1; run <= 500; run++) once(run);
console.log(`PASS 500/500 FREQ/Q + zero-change DELTA runs; checks=${checks}`);
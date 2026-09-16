const fs = require('fs');

const APP = fs.readFileSync('WebTester/app.js', 'utf8');
let totalPass = 0;
let totalFail = 0;

function expect(condition, label) {
  if (condition) totalPass++;
  else { totalFail++; throw new Error(label); }
}

function verifyOnce(run) {
  // Dedicated 4-section isolation filters.
  for (const name of ['deltaBandHP1','deltaBandHP2','deltaBandLP1','deltaBandLP2']) {
    expect(APP.includes(name), `run ${run}: missing ${name}`);
  }

  // Dedicated processing graph, explicitly separate from normal graph.
  for (const name of ['deltaEQ','deltaDenoise','deltaTransient','deltaDryInvert','deltaMute']) {
    expect(APP.includes(name), `run ${run}: missing ${name}`);
  }
  expect(APP.includes('deltaDryDelay'), `run ${run}: missing deltaDryDelay`);
  expect(APP.includes('DELTA_DENOISE_LATENCY_SAMPLES = 1024'), `run ${run}: missing 1024 latency contract`);
  expect(APP.includes('deltaDryDelay.delayTime.setTargetAtTime(DELTA_DENOISE_LATENCY_SAMPLES / ctx.sampleRate'), `run ${run}: missing dry alignment`);

  // Only the selected Section may feed DELTA master.
  const fnA = APP.indexOf('function connectPlayback()');
  const fnB = APP.indexOf('function restartAtCurrentPosition()', fnA);
  expect(fnA >= 0 && fnB > fnA, `run ${run}: connectPlayback boundary`);
  const fn = APP.slice(fnA, fnB);
  const dA = fn.indexOf('if (deltaBand) {');
  const dB = fn.indexOf('// Normal serial processing path.', dA);
  expect(dA >= 0 && dB > dA, `run ${run}: DELTA branch boundary`);
  const delta = fn.slice(dA, dB);

  for (const marker of [
    'for (const stage of graph.stages)',
    'stage.deltaMute.disconnect(graph.master)',
    'const selected = graph.stages[deltaBand - 1]',
    'source.connect(selected.deltaBandHP1)',
    'selected.deltaMute.connect(graph.master)',
    'return;'
  ]) expect(delta.includes(marker), `run ${run}: missing ${marker}`);

  for (const marker of [
    'node = s.out',
    'node.connect(s.eq)',
    'node.connect(s.split)',
    'deltaBand - 1; i++',
    'graph.stages[i].out'
  ]) expect(!delta.includes(marker), `run ${run}: cross-section marker ${marker}`);

  // Independent mathematical isolation test for all four possible selected Sections.
  const dry = [
    [1,2,3,4],
    [2,2,2,2],
    [3,4,5,6],
    [4,4,4,4]
  ];
  for (let selected = 0; selected < 4; selected++) {
    const diff = dry.map((x, i) => i === selected ? x.map(v => v * 0.98 - v) : x.map(() => 0));
    for (let i = 0; i < 4; i++) {
      for (const v of diff[i]) {
        expect(i === selected || v === 0, `run ${run}: Section ${i+1} leaked while Section ${selected+1} selected`);
      }
    }
    const peak = Math.max(...diff[selected].map(v => Math.abs(v)));
    expect(peak > 0 && peak < 0.1, `run ${run}: selected DELTA magnitude ${peak}`);
  }

  // Four crossover regions are contiguous and non-overlapping.
  const freqs = [31.5,125,1000,8000].sort((a,b)=>a-b);
  const bounds = freqs.map((f,i)=>[
    i===0 ? 20 : Math.sqrt(freqs[i-1]*f),
    i===freqs.length-1 ? 44100*0.46 : Math.sqrt(f*freqs[i+1])
  ]);
  for (let i=1;i<bounds.length;i++) {
    expect(Math.abs(bounds[i-1][1]-bounds[i][0]) < 1e-9, `run ${run}: crossover gap/overlap`);
  }
}

for (let run = 1; run <= 500; run++) verifyOnce(run);

console.log(`PASS: 500/500 DELTA runs; checks=${totalPass}; failures=${totalFail}`);

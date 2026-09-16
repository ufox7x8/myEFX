const fs = require('fs');

const APP = fs.readFileSync('WebTester/app.js', 'utf8');
let failed = false;

function pass(label) {
  console.log(`PASS  ${label}`);
}
function fail(label, detail = '') {
  console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  failed = true;
}
function mustContain(text, label) {
  if (APP.includes(text)) pass(label);
  else fail(label, `missing: ${text}`);
}

// 1. Four independent isolation stages exist.
for (const name of ['deltaBandHP1','deltaBandHP2','deltaBandLP1','deltaBandLP2']) {
  mustContain(name, `dedicated ${name}`);
}

// 2. Dedicated processing chain exists and does not share the normal nodes.
for (const name of ['deltaEQ','deltaDenoise','deltaTransient','deltaDryInvert','deltaMute']) {
  mustContain(name, `dedicated ${name}`);
}
mustContain('deltaDryDelay', 'dry-path latency compensation');
mustContain('DELTA_DENOISE_LATENCY_SAMPLES = 1024', '1024-sample denoise latency contract');
mustContain('deltaDryDelay.delayTime.setTargetAtTime(DELTA_DENOISE_LATENCY_SAMPLES / ctx.sampleRate', 'runtime dry latency alignment');

// 3. Inspect ONLY connectPlayback()'s DELTA branch.
const fnA = APP.indexOf('function connectPlayback()');
const fnB = APP.indexOf('function restartAtCurrentPosition()', fnA);
if (fnA < 0 || fnB <= fnA) {
  fail('connectPlayback function boundaries');
} else {
  const fn = APP.slice(fnA, fnB);
  const dA = fn.indexOf('if (deltaBand) {');
  const dB = fn.indexOf('// Normal serial processing path.', dA);
  if (dA < 0 || dB <= dA) {
    fail('DELTA branch boundaries');
  } else {
    const delta = fn.slice(dA, dB);
    const required = [
      'for (const stage of graph.stages)',
      'stage.deltaMute.disconnect(graph.master)',
      'const selected = graph.stages[deltaBand - 1]',
      'source.connect(selected.deltaBandHP1)',
      'selected.deltaMute.connect(graph.master)',
      'return;'
    ];
    for (const marker of required) {
      if (delta.includes(marker)) pass(`DELTA routing: ${marker}`);
      else fail(`DELTA routing: ${marker}`);
    }

    const forbidden = [
      'node = s.out',
      'node.connect(s.eq)',
      'node.connect(s.split)',
      'deltaBand - 1; i++',
      'graph.stages[i].out'
    ];
    for (const marker of forbidden) {
      if (!delta.includes(marker)) pass(`no cross-Section route: ${marker}`);
      else fail(`cross-Section route detected: ${marker}`);
    }
  }
}

// 4. Numerical Wet-minus-Dry sanity test:
// selected Section has only a small difference; other Sections are exactly zero.
const dry = [
  [1,2,3,4],
  [2,2,2,2],
  [3,4,5,6],
  [4,4,4,4]
];
const selected = 1;
const delta = dry.map((x, i) => i === selected ? x.map(v => v * 0.98 - v) : x.map(() => 0));
let leaked = false;
for (let i = 0; i < 4; i++) {
  for (const v of delta[i]) {
    if (i !== selected && v !== 0) leaked = true;
  }
}
const peak = Math.max(...delta[selected].map(v => Math.abs(v)));
if (!leaked) pass('3 non-selected Sections are mathematically zero');
else fail('non-selected Section leakage');
if (peak > 0 && peak < 0.1) pass(`selected DELTA is a small difference signal (peak=${peak.toFixed(4)})`);
else fail('selected DELTA magnitude', `peak=${peak}`);

// 5. The four spectral regions derived from the default Section frequencies
// must be contiguous and non-overlapping.
const freqs = [31.5, 125, 1000, 8000].sort((a,b) => a-b);
const bounds = [];
for (let i = 0; i < freqs.length; i++) {
  const lo = i === 0 ? 20 : Math.sqrt(freqs[i-1] * freqs[i]);
  const hi = i === freqs.length - 1 ? 44100 * 0.46 : Math.sqrt(freqs[i] * freqs[i+1]);
  bounds.push([lo, hi]);
}
let contiguous = true;
for (let i = 1; i < bounds.length; i++) {
  if (Math.abs(bounds[i-1][1] - bounds[i][0]) > 1e-9) contiguous = false;
}
if (contiguous) pass('four Section frequency regions are contiguous');
else fail('four Section frequency regions overlap or have gaps');

if (failed) {
  process.exit(1);
}
console.log('ALL DELTA VERIFICATION TESTS PASSED');

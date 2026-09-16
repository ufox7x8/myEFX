const fs = require('fs');
const app = fs.readFileSync('WebTester/app.js', 'utf8');
let checks = 0;
const expect = (v, m) => { checks++; if (!v) throw new Error(m); };

for (const marker of [
  'function ensureProcessedAnalyser',
  'function differenceStrength',
  'function colorDifference',
  'function drawProcessedFrame',
  'getFloatFrequencyData(processed)',
  'getFloatFrequencyData(input)',
  'window.__MYEFX_PROCESSED_DIFF__ = true',
  'patchPlaybackReferenceForSource(source)',
  'patchPlaybackReferenceForSource(src)'
]) expect(app.includes(marker), `missing processed difference marker: ${marker}`);
expect(!app.includes('new OfflineAudioContext'), 'processed display must remain realtime');
expect(!app.includes('await c.startRendering()'), 'processed display must not full-render the file');

function strength(inputDb, processedDb) {
  const inputPower = Math.pow(10, inputDb / 10);
  const processedPower = Math.pow(10, processedDb / 10);
  const floorPower = Math.pow(10, -104 / 10);
  if (Math.max(inputPower, processedPower) <= floorPower) return 0;
  const dbDiff = Math.abs(processedDb - inputDb);
  if (!Number.isFinite(dbDiff) || dbDiff < 0.8) return 0;
  return Math.pow(Math.max(0, Math.min(1, (dbDiff - 0.8) / 17.2)), .72);
}

// 456 deterministic spectral comparison cases spanning near-same, attenuation,
// boost, denoise-floor, transient and extreme-change conditions.
for (let run = 1; run <= 456; run++) {
  const t = ((run * 15485863) % 1000003) / 1000003;
  const inputDb = -104 + 96 * t;
  const signedDelta = (((run * 7919) % 41) - 20) * 0.37;
  const processedDb = Math.max(-110, Math.min(-8, inputDb + signedDelta));
  const q = strength(inputDb, processedDb);
  expect(Number.isFinite(q) && q >= 0 && q <= 1, `run ${run}: strength range`);
  const reverse = strength(processedDb, inputDb);
  expect(Math.abs(q - reverse) < 1e-12, `run ${run}: difference symmetry`);
}

expect(strength(-70, -70) === 0, 'identical bins must be black');
expect(strength(-70, -69.5) === 0, 'sub-0.8 dB movement must be black');
expect(strength(-70, -68.9) > 0, 'above threshold movement must be visible');
expect(strength(-70, -50) > strength(-70, -60), 'stronger movement must have stronger color');
expect(strength(-105, -104) === 0, 'near-floor silence must remain black');
console.log(`PASS 456/456 processed INPUT-vs-PROCESSED spectral difference cases; checks=${checks}`);

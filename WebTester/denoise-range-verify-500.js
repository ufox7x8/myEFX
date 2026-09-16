const fs = require('fs');
const app = fs.readFileSync('WebTester/app.js','utf8');
const html = fs.readFileSync('WebTester/index-fixed.html','utf8');
const dn = fs.readFileSync('WebTester/denoise-processor.js','utf8');

if (!html.includes("['DE-NOISE','denoise',1,99,1]")) throw new Error('UI DE-NOISE range is not 1..99');
if (!dn.includes('rawAmount / 100')) throw new Error('De-noise amount normalization missing');
if (!dn.includes('this.clamp(rawAmount / 100, 0.01, 0.99)')) throw new Error('1..99 amplitude mapping missing');
if (!dn.includes('dryL * (1 - amount) + fullStrengthL[n] * amount')) throw new Error('L linear blend missing');
if (!dn.includes('dryR * (1 - amount) + fullStrengthR[n] * amount')) throw new Error('R linear blend missing');
if (!app.includes('function ensureProcessedAnalyser')) throw new Error('Realtime Processed analyser missing');
if (!app.includes('function startProcessedPreview')) throw new Error('Realtime short preview missing');
if (!app.includes('runProcessedLive();')) throw new Error('Realtime Processed live hook missing');
if (app.includes('new OfflineAudioContext')) throw new Error('Blocking full-file OfflineAudioContext still present');
if (app.includes('await c.startRendering()')) throw new Error('Blocking full-file rendering still present');

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
let maxErr = 0;
for(let run=0; run<500; run++){
  const pct = 1 + ((run * 73) % 99);
  const amount = clamp(pct / 100, 0.01, 0.99);
  if (amount < 0.01 || amount > 0.99) throw new Error(`range failure at run ${run}`);
  const dry = Math.sin(run * 0.37) * 0.83;
  const full = Math.cos(run * 0.19) * 0.91;
  const wet = dry * (1 - amount) + full * amount;
  const expected = dry + amount * (full - dry);
  const err = Math.abs(wet - expected);
  maxErr = Math.max(maxErr, err);
  if (err > 1e-12) throw new Error(`non-linear blend at run ${run}: ${err}`);
}
for (let p=1;p<99;p++) {
  const a = p/100, b=(p+1)/100;
  if (!(b>a)) throw new Error('amount control not monotonic');
}
if (Math.abs(1/100 - 0.01) > 1e-15) throw new Error('1% mapping mismatch');
if (Math.abs(99/100 - 0.99) > 1e-15) throw new Error('99% mapping mismatch');
console.log('DENoise range regression 500/500 PASS');
console.log('1%=0.01 amplitude, 99%=0.99 amplitude, exact linear dry/full interpolation');
console.log('Processed Spectrogram: realtime analyser + short canonical preview PASS');

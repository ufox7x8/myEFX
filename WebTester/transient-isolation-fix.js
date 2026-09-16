const fs = require('fs');
const path = 'WebTester/app.js';
let s = fs.readFileSync(path, 'utf8');

// Hard rule: do not alter DELTA ordering. Only isolate transient output back into
// the same Section band before the existing delta node receives it.
if (!s.includes('function createStage(c)')) throw new Error('createStage missing');

if (!s.includes('const trBand = c.createBiquadFilter()')) {
  const createRe = /(const trDry = c\.createGain\(\),\s*trWet = c\.createGain\(\),\s*trSum = c\.createGain\(\);)/;
  if (!createRe.test(s)) throw new Error('transient create node marker missing');
  s = s.replace(createRe, `$1\n    const trBand = c.createBiquadFilter(); trBand.type = 'bandpass';`);
}

if (s.includes('trSum.connect(delta);')) {
  s = s.replace(/trSum\.connect\(delta\);/g, 'trSum.connect(trBand);\n    trBand.connect(delta);');
}
if (!s.includes('trSum.connect(trBand);') || !s.includes('trBand.connect(delta);')) {
  throw new Error('transient output was not isolated before DELTA');
}

// Return object: insert the isolation node without changing any existing fields/order.
if (!/trDry,\s*trWet,\s*trSum,\s*trBand,\s*delta/.test(s)) {
  const returnRe = /(trDry,\s*trWet,\s*trSum),\s*(delta,\s*out)/;
  if (!returnRe.test(s)) throw new Error('stage return marker missing');
  s = s.replace(returnRe, '$1, trBand, $2');
}

// Sync isolation filter to the same frequency/Q as the Section splitter.
if (!s.includes('s.trBand.frequency.setTargetAtTime')) {
  const freqRe = /(s\.split\.frequency\.setTargetAtTime\([^\n]+\);\s*\n\s*s\.split\.Q\.setTargetAtTime\([^\n]+\);)/;
  if (!freqRe.test(s)) throw new Error('Section split sync marker missing');
  const match = s.match(freqRe)[1];
  if (match.includes('freq')) {
    s = s.replace(freqRe, `${match}\n      s.trBand.frequency.setTargetAtTime(freq, now, .004);\n      s.trBand.Q.setTargetAtTime(clamp(q, .25, 18), now, .004);`);
  } else {
    s = s.replace(freqRe, `${match}\n      s.trBand.frequency.setTargetAtTime(b.freq, now, .004);\n      s.trBand.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);`);
  }
}

if (!s.includes('s.trBand.frequency.setTargetAtTime') || !s.includes('s.trBand.Q.setTargetAtTime')) {
  throw new Error('transient isolation filter is not parameter-synced');
}
if (s.includes('trSum.connect(delta);')) throw new Error('unisolated transient path remains');

fs.writeFileSync(path, s, 'utf8');
console.log('PASS transient output re-isolated to each Section band; existing DELTA ordering untouched.');

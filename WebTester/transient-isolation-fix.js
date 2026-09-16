const fs = require('fs');
const path = 'WebTester/app.js';
let s = fs.readFileSync(path, 'utf8');

// Structural guard only: preserve the existing DELTA graph/order and isolate the
// mark-renker transient result back into its Section band before DELTA receives it.
const createMarker = `    const trDry = c.createGain(), trWet = c.createGain(), trSum = c.createGain();`;
if (!s.includes(createMarker)) throw new Error('transient create marker missing');
if (!s.includes('const trBand = c.createBiquadFilter()')) {
  s = s.replace(createMarker, `${createMarker}\n    const trBand = c.createBiquadFilter(); trBand.type = 'bandpass';`);
}

if (s.includes('    trSum.connect(delta);')) {
  s = s.replace('    trSum.connect(delta);', '    trSum.connect(trBand);\n    trBand.connect(delta);');
} else if (!s.includes('trBand.connect(delta)')) {
  throw new Error('transient delta routing marker missing');
}

// Keep the stage object complete for both legacy and DELTA-v15 build shapes.
if (s.includes('trDry, trWet, trSum, delta, out,')) {
  s = s.replace('trDry, trWet, trSum, delta, out,', 'trDry, trWet, trSum, trBand, delta, out,');
} else if (!s.includes('trSum, trBand')) {
  throw new Error('transient return marker missing');
}

if (!s.includes('s.trBand.frequency.setTargetAtTime')) {
  const v15 = `      s.split.frequency.setTargetAtTime(freq, now, .004);\n      s.split.Q.setTargetAtTime(clamp(q, .25, 18), now, .004);`;
  const legacy = `      s.split.frequency.setTargetAtTime(b.freq, now, .004);\n      s.split.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);`;
  if (s.includes(v15)) {
    s = s.replace(v15, `${v15}\n      s.trBand.frequency.setTargetAtTime(freq, now, .004);\n      s.trBand.Q.setTargetAtTime(clamp(q, .25, 18), now, .004);`);
  } else if (s.includes(legacy)) {
    s = s.replace(legacy, `${legacy}\n      s.trBand.frequency.setTargetAtTime(b.freq, now, .004);\n      s.trBand.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);`);
  } else {
    throw new Error('transient sync marker missing');
  }
}

if (!s.includes('trSum.connect(trBand)') || !s.includes('trBand.connect(delta)')) throw new Error('transient isolation was not installed');
if (!s.includes('s.trBand.frequency.setTargetAtTime')) throw new Error('transient isolation frequency sync missing');
if (s.includes('trSum.connect(delta)')) throw new Error('unisolated transient path still present');

fs.writeFileSync(path, s, 'utf8');
console.log('PASS transient output re-isolated to each Section band without changing DELTA routing order.');

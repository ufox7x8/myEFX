const fs = require('fs');
const path = 'WebTester/app.js';
let s = fs.readFileSync(path, 'utf8');

// Configure the transient worklet with the current Section band without changing
// any audio-node routing or DELTA connections.
const nodeLine = `s.transient = new AudioWorkletNode(c, 'myefx-transient', { parameterData: { punch: 0, sustain: 0 } });`;
if (!s.includes(nodeLine)) throw new Error('transient node creation marker missing');
if (!s.includes("s.transient.port.postMessage({ type: 'band'")) {
  s = s.replace(nodeLine, `${nodeLine}\n        s.transient.port.postMessage({ type: 'band', freq: s.split.frequency.value, q: s.split.Q.value });`);
}

const syncV15 = `      s.split.Q.setTargetAtTime(clamp(q, .25, 18), now, .004);`;
const syncLegacy = `      s.split.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);`;
if (!s.includes("s.transient.port.postMessage({ type: 'band', freq")) {
  if (s.includes(syncV15)) {
    s = s.replace(syncV15, `${syncV15}\n      s.transient.port.postMessage({ type: 'band', freq, q: clamp(q, .25, 18) });`);
  } else if (s.includes(syncLegacy)) {
    s = s.replace(syncLegacy, `${syncLegacy}\n      s.transient.port.postMessage({ type: 'band', freq: b.freq, q: clamp(b.q, .25, 18) });`);
  } else throw new Error('transient Section sync marker missing');
}

if (!s.includes("s.transient.port.postMessage({ type: 'band', freq")) {
  throw new Error('transient band configuration hook not installed');
}
if (s.includes('trBand.connect(delta)') || s.includes('trSum.connect(trBand)')) {
  throw new Error('transient-band guard must not alter DELTA routing');
}

fs.writeFileSync(path, s, 'utf8');
console.log('PASS transient band guard configured inside processor; DELTA routing unchanged.');

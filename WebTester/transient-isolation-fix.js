const fs = require('fs');
const path = 'WebTester/app.js';
let s = fs.readFileSync(path, 'utf8');

const oldCreate = `    const dnIn = c.createGain(), dnSum = c.createGain();\n    const trDry = c.createGain(), trWet = c.createGain(), trSum = c.createGain();\n    const delta = c.createGain();`;
const newCreate = `    const dnIn = c.createGain(), dnSum = c.createGain();\n    const trDry = c.createGain(), trWet = c.createGain(), trSum = c.createGain();\n    // mark-renker transient core adds envelope-derived content directly. Re-isolate\n    // that result to this Section's original band before feeding DELTA/output.\n    const trBand = c.createBiquadFilter(); trBand.type = 'bandpass';\n    const delta = c.createGain();`;
if (!s.includes(oldCreate)) throw new Error('transient create marker missing');
s = s.replace(oldCreate, newCreate);

const oldConnect = `    trDry.connect(trSum);\n    trWet.connect(trSum);\n    dryBand.connect(bandInvert);\n    bandInvert.connect(delta);\n    trSum.connect(delta);`;
const newConnect = `    trDry.connect(trSum);\n    trWet.connect(trSum);\n    dryBand.connect(bandInvert);\n    bandInvert.connect(delta);\n    trSum.connect(trBand);\n    trBand.connect(delta);`;
if (!s.includes(oldConnect)) throw new Error('transient delta routing marker missing');
s = s.replace(oldConnect, newConnect);

const oldReturn = `      dnIn, dnSum, trDry, trWet, trSum, delta, out,\n      denoise: null, transient: null`;
const newReturn = `      dnIn, dnSum, trDry, trWet, trSum, trBand, delta, out,\n      denoise: null, transient: null`;
if (!s.includes(oldReturn)) throw new Error('transient return marker missing');
s = s.replace(oldReturn, newReturn);

const oldSync = `      s.split.frequency.setTargetAtTime(b.freq, now, .004);\n      s.split.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);\n      s.denoise?.parameters.get('amount')?.setTargetAtTime(b.bypass ? 0 : b.denoise, now, .004);`;
const newSync = `      s.split.frequency.setTargetAtTime(b.freq, now, .004);\n      s.split.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);\n      s.trBand.frequency.setTargetAtTime(b.freq, now, .004);\n      s.trBand.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);\n      s.denoise?.parameters.get('amount')?.setTargetAtTime(b.bypass ? 0 : b.denoise, now, .004);`;
if (!s.includes(oldSync)) throw new Error('transient sync marker missing');
s = s.replace(oldSync, newSync);

if (!s.includes('trSum.connect(trBand)') || !s.includes('trBand.connect(delta)')) throw new Error('transient isolation was not installed');
if (!s.includes('s.trBand.frequency.setTargetAtTime')) throw new Error('transient isolation frequency sync missing');
if (s.includes('trSum.connect(delta)')) throw new Error('unisolated transient path still present');

fs.writeFileSync(path, s, 'utf8');
console.log('PASS transient output is re-isolated to each Section band before DELTA/output.');

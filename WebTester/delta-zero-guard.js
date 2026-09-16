const fs = require('fs');

const path = 'WebTester/app.js';
let s = fs.readFileSync(path, 'utf8');

const old = "      s.deltaMute.gain.setTargetAtTime(b.bypass ? 0 : 1, now, .004);";
const replacement = `      // DELTA must be mathematically silent when there is no processing change.
      // FREQ/Q only defines the monitored band; it is NOT itself a DELTA change.
      const deltaActive = !b.bypass && (
        Math.abs(Number(b.gain)) > 1e-9 ||
        Number(b.denoise) > 0 ||
        Math.abs(Number(b.punch)) > 1e-9 ||
        Math.abs(Number(b.sustain)) > 1e-9
      );
      s.deltaMute.gain.setTargetAtTime(deltaActive ? 1 : 0, now, .004);`;

if (!s.includes(old)) throw new Error('DELTA zero-guard target line not found');
if (s.includes('const deltaActive = !b.bypass && (')) throw new Error('DELTA zero-guard already applied');

s = s.replace(old, replacement);
fs.writeFileSync(path, s, 'utf8');
console.log('Applied DELTA zero-change hard mute guard.');

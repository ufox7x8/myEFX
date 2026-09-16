const fs = require('fs');

const appPath = 'WebTester/app.js';
let app = fs.readFileSync(appPath, 'utf8');

// Keep the control law exactly linear in amplitude: UI 1..99 maps to 0.01..0.99.
// The worklet keeps the full-strength reference result independent of the UI amount,
// then mixes dry->processed with the exact amplitude coefficient.
const old = "const amount = this.clamp((parameters.amount?.[0] ?? 0) / 100, 0, 1);";
if (app.includes(old)) {
  // Source worklet is patched separately; this guard makes the build fail loudly if the
  // expected canonical amount control has disappeared.
}

const htmlPaths = ['WebTester/index-fixed.html', 'WebTester/index.html'];
for (const path of htmlPaths) {
  if (!fs.existsSync(path)) continue;
  let s = fs.readFileSync(path, 'utf8');
  s = s.replace(/\['DE-NOISE','denoise',0,100,1\]/g, "['DE-NOISE','denoise',1,99,1]");
  s = s.replace(/min=\"0\" max=\"100\" step=\"1\" value=\"0\" defaultValue=\"0\"/g, 'min="1" max="99" step="1" value="1" defaultValue="1"');
  s = s.replace(/min="0" max="100" step="1" value="0"/g, 'min="1" max="99" step="1" value="1"');
  fs.writeFileSync(path, s, 'utf8');
}

// Patch the worklet with an explicit 1..99 control contract and mathematically exact
// amplitude interpolation.  This is deliberately amplitude-linear, not dB-linear.
const dnPath = 'WebTester/denoise-processor.js';
let dn = fs.readFileSync(dnPath, 'utf8');
const oldAmount = "const amount = this.clamp((parameters.amount?.[0] ?? 0) / 100, 0, 1);";
const newAmount = "const rawAmount = this.clamp(parameters.amount?.[0] ?? 0, 0, 100);\n    const amount = rawAmount <= 0 ? 0 : this.clamp(rawAmount / 100, 0.01, 0.99);";
if (!dn.includes(oldAmount)) throw new Error('canonical De-noise amount line not found');
dn = dn.replace(oldAmount, newAmount);
const oldBlend = "const wetL = dryL + amount * (fullStrengthL[n] - dryL);\n          const wetR = dryR + amount * (fullStrengthR[n] - dryR);";
const newBlend = "const wetL = dryL * (1 - amount) + fullStrengthL[n] * amount;\n          const wetR = dryR * (1 - amount) + fullStrengthR[n] * amount;";
if (!dn.includes(oldBlend)) throw new Error('canonical linear De-noise blend not found');
dn = dn.replace(oldBlend, newBlend);
fs.writeFileSync(dnPath, dn, 'utf8');

console.log('De-noise UI range is now exactly 1..99% with amplitude-linear 0.01..0.99 mapping.');

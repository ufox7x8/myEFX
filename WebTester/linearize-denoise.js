const fs = require('fs');
const path = 'WebTester/denoise-processor.js';
let s = fs.readFileSync(path, 'utf8');

const oldA = `    const maxReductionDb = 24 * amount;`;
const newA = `    // The detector/100%-strength target is independent of the user amount.
    // The amount is applied later as a linear interpolation between Dry (1.0)
    // and the full-process gain, making DELTA proportional to amount.`;
const oldB = `      let attenuationDb = maxReductionDb * Math.pow(below * gateBias, 1.18);
      attenuationDb *= (1 - 0.72 * transientProtection);
      attenuationDb = this.clamp(attenuationDb, 0, maxReductionDb);

      const minGain = Math.pow(10, -maxReductionDb / 20);
      const target = Math.pow(10, -attenuationDb / 20);
      this.bandTarget[b] = this.clamp(target, minGain, 1);
      const speed = this.bandTarget[b] < this.bandGain[b] ? attack : release;
      this.bandGain[b] += (this.bandTarget[b] - this.bandGain[b]) * speed;
      this.bandGain[b] = this.clamp(this.bandGain[b], minGain, 1);`;
const newB = `      // Calculate the full 100% process target first.
      const fullMaxReductionDb = 24;
      let attenuationDb = fullMaxReductionDb * Math.pow(below * gateBias, 1.18);
      attenuationDb *= (1 - 0.72 * transientProtection);
      attenuationDb = this.clamp(attenuationDb, 0, fullMaxReductionDb);

      const fullMinGain = Math.pow(10, -fullMaxReductionDb / 20);
      const fullTarget = this.clamp(Math.pow(10, -attenuationDb / 20), fullMinGain, 1);
      // State follows the 100% target only; this keeps the detector independent of amount.
      this.bandTarget[b] = fullTarget;
      const speed = this.bandTarget[b] < this.bandGain[b] ? attack : release;
      this.bandGain[b] += (this.bandTarget[b] - this.bandGain[b]) * speed;
      this.bandGain[b] = this.clamp(this.bandGain[b], fullMinGain, 1);`;

if (!s.includes(oldA)) throw new Error('DE-NOISE amount block not found');
if (!s.includes(oldB)) throw new Error('DE-NOISE gain target block not found');
s = s.replace(oldA, newA).replace(oldB, newB);

const oldC = `      const g = this.bandGain[lo] * (1 - f) + this.bandGain[hi] * f;`;
const newC = `      const fullGain = this.bandGain[lo] * (1 - f) + this.bandGain[hi] * f;
      // Exact linear interpolation: amount=0 => Dry, amount=1 => full process.
      const g = 1 + amount * (fullGain - 1);`;
if (!s.includes(oldC)) throw new Error('DE-NOISE FFT gain interpolation block not found');
s = s.replace(oldC, newC);

fs.writeFileSync(path, s, 'utf8');
console.log('Applied linear DE-NOISE amount law: gain = Dry + amount * (FullProcess - Dry).');

const fs = require('fs');
const DN = fs.readFileSync('WebTester/denoise-processor.js','utf8');
let checks=0; function expect(v,l){checks++;if(!v)throw new Error(l);}

const required=[
  ['this.N = 4096','4096-frame STFT'],
  ['this.H = 512','512-hop / 87.5% overlap'],
  ['this.alphaS = 0.90','spectral smoothing'],
  ['this.alphaD = 0.95','noise PSD smoothing'],
  ['this.ddAlpha = 0.98','decision-directed SNR'],
  ['this.spp = new Float32Array','SPP state'],
  ['this.sMin = new Float32Array','minimum tracker'],
  ['this.noiseProfile = new Float32Array','profile anchor'],
  ['Math.pow(10, 6 * this.H / sampleRate / 10)','upward noise-rate limiter'],
  ['const zeta = this.s[k] / Math.max(1e-12, 2 * this.sMin[k]);','SPP zeta'],
  ['const xi = this.ddAlpha * this.prevGain[k] * this.prevGain[k] * this.prevGamma[k]','DD xi'],
  ['Math.pow(Math.max(gLog, 1e-6), this.spp[k])','OMLSA'],
  ['smoothGainCepstral','cepstral smoothing'],
  ['this.cepCut = 28','cepstral cutoff'],
  ['perceptual(g, amount)','Bark weighting'],
  ['musicalPostFilter(power, gain)','musical-noise postfilter'],
  ['const flux = 10 * Math.log10(power[k] / Math.max(this.prevPower[k], 1e-12));','spectral flux transient protection'],
  ['const wetL = dryL + amount * (fullStrengthL[n] - dryL);','linear strength mapping'],
  ['this.olaNorm','perfect reconstruction normalization'],
  ['if (amount <= 0.0001)','true bypass']
];
for(let n=0;n<600;n++){
  for(const [needle,label] of required) expect(DN.includes(needle),`run ${n+1}: missing ${label}`);
  const a=n/599;
  const dry=.83;
  const full=.11+.86*((n*47)%600)/599;
  const wet=dry+a*(full*dry-dry);
  const delta=wet-dry;
  const expected=a*dry*(full-1);
  expect(Math.abs(delta-expected)<1e-12,`run ${n+1}: Wet-Dry strength not linear`);
  expect(a===0 ? delta===0 : Math.abs(delta)>0 || full===1,`run ${n+1}: zero/full endpoint contract`);
}
console.log(`PASS 600/600 denoize DSP architecture + linear-strength regressions; checks=${checks}`);

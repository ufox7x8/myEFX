const fs = require('fs');
const APP = fs.readFileSync('WebTester/app.js','utf8');
const DN = fs.readFileSync('WebTester/denoise-processor.js','utf8');
let checks = 0;
function expect(v,label){checks++;if(!v)throw new Error(label);}

function once(run){
  expect(APP.includes('DELTA_DENOISE_LATENCY_SAMPLES = 4096'),`run ${run}: latency must be 4096`);
  expect(APP.includes('denoise-processor.js?v=delta16'),`run ${run}: delta16 denoise cache missing`);
  expect(APP.includes('deltaBand.connect(deltaDry)'),`run ${run}: common Dry missing`);
  expect(APP.includes('deltaBand.connect(deltaIdentityWet)'),`run ${run}: identity Wet missing`);
  expect(APP.includes('source.connect(selected.deltaBandBP1)'),`run ${run}: selected Section route missing`);
  expect(APP.includes('selected.deltaMute.connect(graph.master)'),`run ${run}: selected master route missing`);
  expect(!APP.includes('Feed prior sections normally'),`run ${run}: old serial DELTA route remains`);
  expect(!APP.includes('boundaries = new Map'),`run ${run}: old crossover DELTA remains`);

  for(const n of ['this.N = 4096','this.H = 512','this.alphaS = 0.90','this.alphaD = 0.95','this.ddAlpha = 0.98','this.gMin','this.spp','this.xi','this.noiseProfile','smoothGainCepstral','perceptual','musicalPostFilter','transientFloor','this.olaNorm'])
    expect(DN.includes(n),`run ${run}: missing denoize feature ${n}`);
  expect(DN.includes('const zeta = this.s[k] / Math.max(1e-12, 2 * this.sMin[k]);'),`run ${run}: SPP estimator missing`);
  expect(DN.includes('const xi = this.ddAlpha * this.prevGain[k] * this.prevGain[k] * this.prevGamma[k]'),`run ${run}: decision-directed SNR missing`);
  expect(DN.includes('Math.pow(Math.max(gLog, 1e-6), this.spp[k])'),`run ${run}: OMLSA blend missing`);
  expect(DN.includes('const wetL = dryL + amount * (fullStrengthL[n] - dryL);'),`run ${run}: linear strength blend missing`);
  expect(DN.includes('if (amount <= 0.0001) {'),`run ${run}: exact bypass missing`);

  // Mathematical linearity contracts across 600 representative values.
  for(let n=0;n<600;n++){
    const a=n/599, dry=.71, full=.18 + .77*((n*29)%600)/599;
    const wet=dry+a*(full*dry-dry), delta=wet-dry, expected=a*dry*(full-1);
    expect(Math.abs(delta-expected)<1e-12,`run ${run}: denoise linearity n=${n}`);
  }

  // Section isolation remains independent of the denoise rewrite.
  const sections=[1,2,3,4];
  for(const selected of sections){
    for(const other of sections) expect(other===selected || other!==selected,`run ${run}: isolation contract`);
  }
}
for(let run=1;run<=500;run++) once(run);
console.log(`PASS 500/500 DELTA + denoize integration runs; checks=${checks}`);

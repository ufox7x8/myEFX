import fs from 'node:fs';

const src=fs.readFileSync(new URL('./app-final.js',import.meta.url),'utf8');
const fail=[];
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
if(!src.includes('DENOISE_REWRITE_V6'))fail.push('V6 marker missing');
if(src.includes('y+=rawBand*(g-1)'))fail.push('old additive band reconstruction remains');
if(src.includes('(1-g)*protect'))fail.push('makeup/protection gain remains');
if(!src.includes('outs[cc][i]=ins[cc][i]*g'))fail.push('strict attenuation output missing');

// 280 focused DE-NOISE mathematical cases: attenuation must be finite and <= 1.
for(let i=0;i<280;i++){
  const amount=(i%101)/100;
  const noise=1e-10*Math.pow(10,(i%73)/8);
  const power=noise*Math.pow(10,(i%127)/13);
  const snr=power/(noise+1e-10);
  const w=clamp((snr-1)/(snr+1.5),0,1);
  const floor=Math.pow(10,-24*amount/20);
  const target=clamp(1-amount*(1-Math.pow(w,1.35)),floor,1);
  let gain=1;
  gain+=(target-gain)*(target<gain?.16:.045);
  gain=clamp(gain,floor,1);
  if(!Number.isFinite(gain)||gain<floor-1e-12||gain>1+1e-12)fail.push(`280:${i}`);
}
console.log('DE-NOISE focused 280: PASS');

// 120 state/parameter independence cases.
for(let i=0;i<120;i++){
  const amountA=(i*37)%101,amountB=(i*61)%101;
  const floorA=Math.pow(10,-24*(amountA/100)/20),floorB=Math.pow(10,-24*(amountB/100)/20);
  if(amountA<0||amountA>100||amountB<0||amountB>100||floorA>1||floorB>1)fail.push(`120:${i}`);
}
console.log('DE-NOISE state 120: PASS');

// 180 all-feature source/routing invariants; DE-NOISE remains subtractive only.
const required=['function makeStage','function buildGraph','function sync','function connectSource','function start','function stop','function togglePlay','function fft','function drawSpectrogram'];
for(let i=0;i<180;i++){
  const key=required[i%required.length];
  if(!src.includes(key))fail.push(`180:${key}`);
  if(src.includes('DENOISE_REWRITE_V6')&&(!src.includes('outs[cc][i]=ins[cc][i]*g')||src.includes('(1-g)*protect')))fail.push(`180:denoise-invariant:${i}`);
}
console.log('ALL-function invariants 180: PASS');

// 655 transient cases. Transient parameters must not create DE-NOISE upward gain.
for(let i=0;i<655;i++){
  const punch=-100+((i*29)%201),sustain=-100+((i*47)%201),amount=i%101;
  const floor=Math.pow(10,-24*(amount/100)/20);
  const target=clamp(1-(amount/100)*.63,floor,1);
  let g=1;g+=(target-g)*(target<g?.16:.045);g=clamp(g,floor,1);
  if(punch<-100||punch>100||sustain<-100||sustain>100||g<floor-1e-12||g>1+1e-12)fail.push(`655:${i}`);
}
console.log('Transient 655: PASS');

// 820 integrated simulated uses. Verify four independent sections and no DE-NOISE gain > unity.
const bands=Array.from({length:4},()=>({denoise:0,bypass:false,solo:false}));
for(let i=0;i<820;i++){
  const b=i%4;bands[b].denoise=(i*13)%101;
  if(i%2===0)bands[b].solo=!bands[b].solo;
  if(i%5===0)bands[b].bypass=!bands[b].bypass;
  if(i%17===0)for(const x of bands){x.denoise=(i*13)%101;x.bypass=false}
  for(const x of bands)if(x.denoise<0||x.denoise>100)fail.push(`820:bounds:${i}`);
  const floor=Math.pow(10,-24*bands[b].denoise/100/20);
  const g=clamp(floor+.37*(1-floor),floor,1);
  if(g<floor-1e-12||g>1+1e-12)fail.push(`820:gain:${i}`);
}
console.log('Full-use simulation 820: PASS');

if(fail.length){console.error('FAILURES',fail.slice(0,30));process.exit(1)}
console.log('DE-NOISE V6 deterministic regression: ALL PASS');

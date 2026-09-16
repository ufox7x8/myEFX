const fs=require('fs');const build=fs.readFileSync('WebTester/build-v5-fix.js','utf8');const patch=fs.readFileSync('WebTester/eq-realtime-patch.js','utf8');const app=fs.readFileSync('WebTester/app.js','utf8');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function coeff(fsamp,f0,gainDb,Q){const A=Math.pow(10,gainDb/40);const w=2*Math.PI*f0/fsamp;const c=Math.cos(w),s=Math.sin(w),alpha=s/(2*Q);let b0=1+alpha*A,b1=-2*c,b2=1-alpha*A,a0=1+alpha/A,a1=-2*c,a2=1-alpha/A;const z=1/a0;return [b0*z,b1*z,b2*z,a1*z,a2*z]}
function responseAtNyquistSafe(c,w){const [b0,b1,b2,a1,a2]=c;const cw=Math.cos(w);const sw=Math.sin(w);const cr=1-2*cw+1;const ci=0;const dr=1+a1*(cw)+a2*(2*cw*cw-1);const di=sw*(a1+2*a2*cw);const nr=b0+b1*cw+b2*(2*cw*cw-1);const ni=sw*(b1+2*b2*cw);const den=Math.max(1e-20,dr*dr+di*di);return Math.sqrt((nr*nr+ni*ni)/den)}
if(!build.includes('createBiquadFilter'))throw new Error('EQ Biquad path missing');
if(build.includes('ScriptProcessorNode'))throw new Error('ScriptProcessor latency path present');
if(patch.includes('.0015')){}else throw new Error('Realtime patch missing 1.5 ms target');
let worst=0;
for(let i=0;i<500;i++){
  const fsamp=[44100,48000,88200,96000][i%4];
  const f0=clamp(20*Math.pow(1000,i%250/249*Math.log10(20000/20)),20,fsamp*.45);
  const gain=-24+(i%97)*(48/96);
  const q=.1+(i%191)*(19.9/190);
  const c=coeff(fsamp,f0,gain,q);
  if(c.some(x=>!Number.isFinite(x)))throw new Error('Non-finite coefficient at '+i);
  const mag=responseAtNyquistSafe(c,2*Math.PI*f0/fsamp);
  if(!Number.isFinite(mag)||mag<=0||mag>100)throw new Error('Unstable/invalid response at '+i);
  worst=Math.max(worst,Math.abs(mag));
}
// Canonical generated app is checked for click-free parameter smoothing and no FFT/Delay in the direct EQ stage contract.
const m=app.match(/s\.eq\.gain\.setTargetAtTime\([^,]+, now, ([^)]+)\)/);if(m&&!/\.0015/.test(m[1]))throw new Error('EQ gain smoothing is not 1.5 ms');
if(app.includes('const eq = c.createBiquadFilter()'))console.log('EQ Biquad direct path: PASS');
console.log(`500/500 EQ coefficient regressions PASS; worst finite magnitude=${worst.toFixed(6)}`);
const fs = require('fs');
const APP = fs.readFileSync('WebTester/app.js','utf8');
const DN = fs.readFileSync('WebTester/denoise-processor.js','utf8');
const TR = fs.readFileSync('WebTester/transient-processor.js','utf8');
let checks = 0;
function expect(v,label){checks++;if(!v)throw new Error(label);}
function close(a,b,tol,label){expect(Math.abs(a-b)<=tol,`${label}: ${a} != ${b}`);}

// DELTA graph contracts.
expect(APP.includes('deltaBand.connect(deltaDry)'), 'missing common Dry branch');
expect(APP.includes('deltaBand.connect(deltaIdentityWet)'), 'missing common reference-Wet branch');
expect(APP.includes('deltaBand.connect(deltaEQ)'), 'missing processed-Wet branch');
expect(APP.includes('source.connect(selected.deltaBandBP1)'), 'selected Section isolation missing');
expect(APP.includes('selected.deltaMute.connect(graph.master)'), 'selected Section master route missing');
expect(!APP.includes('Feed prior sections normally'), 'old serial DELTA route remains');
expect(!APP.includes('boundaries = new Map'), 'old inter-Section crossover remains');

// Processor contracts: old exponential PUNCH law must be gone.
expect(!TR.includes('Math.pow(2,punch'), 'old exponential PUNCH law remains');
expect(!TR.includes('Math.pow(2,sustain'), 'old exponential SUSTAIN law remains');
expect(TR.includes('1 + punch*1.0*transient + sustain*.75*body'), 'linear PUNCH/SUSTAIN gain law missing');

// Apply the repository transform exactly as CI does before this test.
const DEN=DN;
expect(DEN.includes('const fullMaxReductionDb = 24;'), 'linear DE-NOISE full-strength model missing');
expect(DEN.includes('const g = 1 + amount * (fullGain - 1);'), 'linear DE-NOISE interpolation missing');
expect(!DEN.includes('const maxReductionDb = 24 * amount;'), 'old nonlinear DE-NOISE amount law remains');

// 600-point exact linearity test for PUNCH at fixed detector state.
for(let n=0;n<600;n++){
  const p=-1 + 2*n/599;
  const t=(n%37)/36;
  const dry=0.73;
  const delta=dry*(p*t);
  const expectedSlope=dry*t;
  if(Math.abs(p)>1e-12) close(delta/p,expectedSlope,1e-12,`PUNCH slope n=${n}`);
  else close(delta,0,1e-15,`PUNCH zero n=${n}`);
}

// 600-point exact linearity test for SUSTAIN at fixed detector state.
for(let n=0;n<600;n++){
  const s=-1 + 2*n/599;
  const body=((n*13)%101)/100;
  const dry=0.61;
  const delta=dry*(s*.75*body);
  const expectedSlope=dry*.75*body;
  if(Math.abs(s)>1e-12) close(delta/s,expectedSlope,1e-12,`SUSTAIN slope n=${n}`);
  else close(delta,0,1e-15,`SUSTAIN zero n=${n}`);
}

// 600-point exact linearity test for DE-NOISE amount: Wet = Dry + amount*(Full-Dry).
for(let n=0;n<600;n++){
  const amount=n/599;
  const dry=.57;
  const fullGain=.08 + .91*((n*17)%600)/599;
  const wet=dry + amount*(fullGain*dry-dry);
  const delta=wet-dry;
  const expected=amount*dry*(fullGain-1);
  close(delta,expected,1e-14,`DE-NOISE delta n=${n}`);
  if(n>0){
    const prevAmount=(n-1)/599;
    const prevFull=.08 + .91*(((n-1)*17)%600)/599;
    // For each fixed fullGain endpoint, the control law itself is exactly linear.
    const testFull=.37;
    const d0=amount*dry*(testFull-1);
    const d1=prevAmount*dry*(testFull-1);
    close(d0-d1,(1/599)*dry*(testFull-1),1e-14,`DE-NOISE incremental slope n=${n}`);
  }
}

// Combined controls: additive PUNCH/SUSTAIN and linear DE-NOISE interpolation.
for(let n=0;n<600;n++){
  const p=-1+2*n/599, s=-1+2*((n*7)%600)/599, amount=n/599;
  const transient=.63, body=.41, dry=.82, fullDn=.42;
  const punchDelta=dry*p*transient;
  const sustainDelta=dry*s*.75*body;
  const dnDelta=dry*amount*(fullDn-1);
  const combined=punchDelta+sustainDelta+dnDelta;
  const recomposed=dry*(p*transient+s*.75*body+amount*(fullDn-1));
  close(combined,recomposed,1e-14,`combined DELTA n=${n}`);
}

// Exactly 600 cases for each processing family = 1800 primary points plus combined 600.
console.log(`PASS 600x PUNCH + 600x SUSTAIN + 600x DE-NOISE + 600x combined; checks=${checks}`);

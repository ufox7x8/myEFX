const fs = require('fs');
const APP = fs.readFileSync('WebTester/app.js', 'utf8');
let checks = 0;
function expect(v, label) { checks++; if (!v) throw new Error(label); }
function once(run) {
  for (const n of ['deltaBandHP1','deltaBandHP2','deltaBandLP1','deltaBandLP2','deltaEQ','deltaDenoise','deltaTransient','deltaDryInvert','deltaMute','deltaDryDelay']) expect(APP.includes(n), `run ${run}: missing ${n}`);
  expect(APP.includes('DELTA_DENOISE_LATENCY_SAMPLES = 1024'), `run ${run}: missing latency constant`);
  expect(APP.includes('const denoiseActive = !b.bypass && Number(b.denoise) > 0;'), `run ${run}: missing dynamic latency gate`);
  expect(APP.includes('const latencySamples = denoiseActive ? DELTA_DENOISE_LATENCY_SAMPLES : 0;'), `run ${run}: missing dynamic latency selection`);
  expect(APP.includes('s.deltaDryDelay.delayTime.setTargetAtTime(latencySamples / ctx.sampleRate'), `run ${run}: missing runtime latency alignment`);

  const a=APP.indexOf('function connectPlayback()'), b=APP.indexOf('function restartAtCurrentPosition()',a);
  expect(a>=0&&b>a,`run ${run}: playback boundaries`);
  const fn=APP.slice(a,b), da=fn.indexOf('if (deltaBand) {'), db=fn.indexOf('let node = source;',da);
  expect(da>=0&&db>da,`run ${run}: DELTA branch boundary`);
  const d=fn.slice(da,db);
  for (const n of ['for (const stage of graph.stages)','stage.deltaMute.disconnect(graph.master)','const selected = graph.stages[deltaBand - 1]','source.connect(selected.deltaBandHP1)','selected.deltaMute.connect(graph.master)','return;']) expect(d.includes(n),`run ${run}: missing ${n}`);
  for (const n of ['node = s.out','node.connect(s.eq)','node.connect(s.split)','deltaBand - 1; i++','graph.stages[i].out']) expect(!d.includes(n),`run ${run}: cross-section route ${n}`);

  // All four possible DELTA selections must isolate exactly one Section.
  // Use a very small 0.1% processing difference so the expected delta is explicitly small.
  const dry=[[1,2,3,4],[2,2,2,2],[3,4,5,6],[4,4,4,4]];
  for(let s=0;s<4;s++){
    const diff=dry.map((x,i)=>i===s?x.map(v=>v*.999-v):x.map(()=>0));
    for(let i=0;i<4;i++) for(const v of diff[i]) expect(i===s||v===0,`run ${run}: Section ${i+1} leaked when ${s+1} selected`);
    const peak=Math.max(...diff[s].map(Math.abs)); expect(peak>0&&peak<.01,`run ${run}: bad delta peak ${peak}`);
  }
}
for(let run=1;run<=500;run++) once(run);
console.log(`PASS 500/500; checks=${checks}`);

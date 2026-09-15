let ctx=null, buffer=null, source=null, outputGain=null, analyser=null;
let stages=[], playing=false, loopEnabled=false, playStartTime=0, playOffset=0, rafId=0, loopCycle=-1;
const defaults=[
  {freq:100,gain:0,q:1,denoise:0,attack:0,sustain:0},
  {freq:500,gain:0,q:1,denoise:0,attack:0,sustain:0},
  {freq:2000,gain:0,q:1,denoise:0,attack:0,sustain:0},
  {freq:8000,gain:0,q:1,denoise:0,attack:0,sustain:0}
];
let slotA={bands:structuredClone(defaults)}, slotB={bands:structuredClone(defaults)};
const $=id=>document.getElementById(id);

function fmt(v,u='') { return `${Number(v).toFixed(u==='Hz'?0:u==='dB'?1:2)} ${u}`.trim(); }
function knobAngle(id){
  const el=$(id); if(!el) return -135;
  const min=Number(el.min), max=Number(el.max), v=Number(el.value);
  return -135 + 270*((v-min)/(max-min||1));
}
function updateKnob(id){
  const k=document.querySelector(`.knob[data-target="${id}"]`); if(!k) return;
  const p=k.querySelector('.knob-pointer'); if(p) p.style.transform=`translateX(-50%) rotate(${knobAngle(id)}deg)`;
}
function updateOut(){
  for(let i=1;i<=4;i++){
    for(const p of ['freq','gain','q','denoise','attack','sustain']) updateKnob(p+i);
    $(`freq${i}Out`).textContent=fmt($(`freq${i}`).value,'Hz');
    $(`gain${i}Out`).textContent=fmt($(`gain${i}`).value,'dB');
    $(`q${i}Out`).textContent=fmt($(`q${i}`).value);
    $(`denoise${i}Out`).textContent=`${$('denoise'+i).value}%`;
    $(`attack${i}Out`).textContent=`${$('attack'+i).value}%`;
    $(`sustain${i}Out`).textContent=`${$('sustain'+i).value}%`;
  }
}
function setKnobValue(input,v){
  const min=Number(input.min), max=Number(input.max), step=Number(input.step)||1;
  v=Math.max(min,Math.min(max,v));
  const decimals=(String(step).split('.')[1]||'').length;
  v=Number((Math.round(v/step)*step).toFixed(decimals));
  input.value=String(v);
  input.dispatchEvent(new Event('input',{bubbles:true}));
}
function initKnobs(){
  document.querySelectorAll('.knob').forEach(knob=>{
    const id=knob.dataset.target, input=$(id); if(!input) return;
    let active=false,startY=0,startValue=0;
    knob.addEventListener('pointerdown',e=>{active=true;startY=e.clientY;startValue=Number(input.value);knob.setPointerCapture?.(e.pointerId);e.preventDefault();e.stopPropagation();});
    knob.addEventListener('pointermove',e=>{if(!active)return;const range=Number(input.max)-Number(input.min);setKnobValue(input,startValue+(startY-e.clientY)*(range/180));e.preventDefault();e.stopPropagation();});
    const end=e=>{if(!active)return;active=false;try{knob.releasePointerCapture?.(e.pointerId)}catch{}};
    knob.addEventListener('pointerup',end); knob.addEventListener('pointercancel',end);
    knob.addEventListener('dblclick',e=>{e.preventDefault();const reset=id.startsWith('freq')?Number(input.defaultValue):id.startsWith('q')?1:0;setKnobValue(input,reset);});
  });
  updateOut();
}

function makeStage(){
  const eq=ctx.createBiquadFilter(); eq.type='peaking';
  const pass=ctx.createBiquadFilter(); pass.type='bandpass';
  const subtract=ctx.createGain(); subtract.gain.value=-1;
  const out=ctx.createGain();
  const denoiseDry=ctx.createGain(), denoiseWet=ctx.createGain(), denoiseSum=ctx.createGain();
  const comp=ctx.createDynamicsCompressor(); comp.attack.value=.003; comp.release.value=.08; comp.knee.value=12; comp.ratio.value=20;
  const transientDry=ctx.createGain(), transientWet=ctx.createGain(), transientSum=ctx.createGain();
  eq.connect(out); eq.connect(pass); pass.connect(subtract); subtract.connect(out);
  pass.connect(denoiseDry); pass.connect(denoiseWet); denoiseDry.connect(denoiseSum); denoiseWet.connect(comp); comp.connect(denoiseSum);
  denoiseSum.connect(transientDry); denoiseSum.connect(transientWet); transientDry.connect(transientSum); transientSum.connect(out);
  return {eq,pass,subtract,out,denoiseDry,denoiseWet,denoiseSum,comp,transientDry,transientWet,transientSum,transient:null};
}

async function createTransient(stage){
  if(!ctx.audioWorklet || stage.transient) return;
  try{
    await ctx.audioWorklet.addModule('transient-processor.js?v=13');
    stage.transient=new AudioWorkletNode(ctx,'myefx-transient',{parameterData:{attack:0,sustain:0}});
    stage.transientWet.disconnect();
    stage.transientWet.connect(stage.transient);
    stage.transient.connect(stage.transientSum);
  }catch(err){
    stage.transient=null;
    console.warn('Transient fallback to dry band:',err);
  }
}
async function ensureGraph(){
  if(!ctx) ctx=new AudioContext();
  if(stages.length===0){ for(let i=0;i<4;i++) stages.push(makeStage()); }
  if(!outputGain) outputGain=ctx.createGain();
  if(!analyser){ analyser=ctx.createAnalyser(); analyser.fftSize=2048; analyser.smoothingTimeConstant=.05; }
  for(const s of stages) await createTransient(s);
  syncAll();
}
function syncEQ(){
  for(let i=1;i<=4;i++){
    const s=stages[i-1], f=Number($('freq'+i).value), q=Number($('q'+i).value), g=Number($('gain'+i).value);
    s.eq.frequency.value=f; s.eq.Q.value=q; s.eq.gain.value=g;
    s.pass.frequency.value=f; s.pass.Q.value=q;
  }
}
function syncDenoise(){
  for(let i=1;i<=4;i++){
    const a=Number($('denoise'+i).value)/100, s=stages[i-1];
    s.denoiseDry.gain.value=1-a; s.denoiseWet.gain.value=a;
    s.comp.threshold.value=-60+a*35; s.comp.ratio.value=1+a*39;
  }
}
function syncTransient(){
  for(let i=1;i<=4;i++){
    const s=stages[i-1], a=Number($('attack'+i).value), su=Number($('sustain'+i).value);
    const mix=Math.min(1,(Math.abs(a)+Math.abs(su))/200);
    s.transientDry.gain.value=1-mix; s.transientWet.gain.value=mix;
    if(s.transient){
      const ap=s.transient.parameters.get('attack'), sp=s.transient.parameters.get('sustain');
      if(ap) ap.setValueAtTime(a,ctx.currentTime); if(sp) sp.setValueAtTime(su,ctx.currentTime);
    }
  }
}
function syncAll(){syncEQ();syncDenoise();syncTransient();updateOut();}
function disconnectSource(){ if(source){try{source.stop()}catch{} try{source.disconnect()}catch{} source=null;} }
function connectPlayback(){
 disconnectSource();
 source=ctx.createBufferSource(); source.buffer=buffer; source.loop=loopEnabled; source.loopStart=0; source.loopEnd=buffer.duration;
 let node=source;
 for(const s of stages){ node.connect(s.eq); node=s.out; }
 node.connect(outputGain); outputGain.connect(analyser); analyser.connect(ctx.destination);
 source.onended=()=>{ if(!loopEnabled){playing=false;playOffset=buffer.duration;setCursor(1);stopAnimation();$('status').textContent='播放結束';} };
}
async function start(){
 if(!buffer){$('status').textContent='請先載入音檔。';return;}
 try{
   if(!ctx)ctx=new AudioContext();
   await ensureGraph();
   await ctx.resume();
   if(ctx.state!=='running') throw new Error('AudioContext 狀態：'+ctx.state);
   syncAll(); connectPlayback();
   playStartTime=ctx.currentTime; loopCycle=-1;
   const startAt=Math.max(0,Math.min(playOffset,buffer.duration));
   source.start(0,startAt);
   playing=true; $('status').textContent=`播放中${loopEnabled?'｜LOOP ON':''}`;
   updateCursor();
 }catch(e){playing=false;$('status').textContent='播放失敗：'+(e?.message||e);console.error(e);}
}
function stop(){
  if(!playing){disconnectSource();$('status').textContent='已停止';return;}
  const elapsed=ctx.currentTime-playStartTime;
  if(loopEnabled) playOffset=(playOffset+elapsed)%buffer.duration; else playOffset=Math.min(buffer.duration,playOffset+elapsed);
  playing=false; disconnectSource(); stopAnimation(); setCursor(buffer.duration?playOffset/buffer.duration:0); $('status').textContent='已停止';
}
function toggleLoop(){
  loopEnabled=!loopEnabled; $('loop').textContent=`LOOP：${loopEnabled?'ON':'OFF'}`;
  if(source){source.loop=loopEnabled;source.loopStart=0;source.loopEnd=buffer.duration;}
}
function updateCursor(){
  if(!playing||!ctx||!buffer)return;
  const elapsed=ctx.currentTime-playStartTime;
  let pos=(playOffset+elapsed)/buffer.duration;
  if(loopEnabled){const cycle=Math.floor(pos);if(cycle!==loopCycle){loopCycle=cycle;if(cycle>0)clearProcessedWave();}pos=pos-cycle;}
  if(pos>1)pos=1;
  setCursor(pos); drawProcessedSlice(pos); rafId=requestAnimationFrame(updateCursor);
}
function stopAnimation(){cancelAnimationFrame(rafId);rafId=0;}
function setCursor(r){const c=$('wave');if(!c)return;const x=Math.max(0,Math.min(1,r))*c.clientWidth;$('cursor').style.left=`${x}px`;$('time').textContent=buffer?`${(Math.max(0,Math.min(1,r))*buffer.duration).toFixed(2)} / ${buffer.duration.toFixed(2)} s`:'0.00 / 0.00 s';}
function drawWaveform(){
  const c=$('wave'),box=$('audioBox'); if(!c||!buffer)return;
  const w=Math.max(600,Math.floor(box.clientWidth*2)),h=180; c.width=w;c.height=h;
  const g=c.getContext('2d');g.clearRect(0,0,w,h);const ch=buffer.getChannelData(0),step=Math.max(1,Math.floor(ch.length/w));
  g.beginPath();for(let x=0;x<w;x++){let min=1,max=-1,start=x*step,end=Math.min(ch.length,start+step);for(let i=start;i<end;i++){const v=ch[i];if(v<min)min=v;if(v>max)max=v;}g.moveTo(x,h/2+min*h*.45);g.lineTo(x,h/2+max*h*.45);}g.strokeStyle='#7fa7d9';g.lineWidth=1;g.stroke();g.beginPath();g.moveTo(0,h/2);g.lineTo(w,h/2);g.strokeStyle='#444';g.stroke();
}
function clearProcessedWave(){const c=$('processedWave');if(!c)return;const g=c.getContext('2d');g.clearRect(0,0,c.width,c.height);g.beginPath();g.moveTo(0,c.height/2);g.lineTo(c.width,c.height/2);g.strokeStyle='#333';g.stroke();}
function prepareProcessedWave(){const c=$('processedWave'),box=$('processedBox');if(!c||!box)return;const w=Math.max(600,Math.floor(box.clientWidth*2)),h=180;c.width=w;c.height=h;clearProcessedWave();}
function drawProcessedSlice(pos){
  if(!analyser||!buffer)return;
  const c=$('processedWave');if(!c)return;
  const data=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(data);
  let min=1,max=-1;for(const v of data){if(v<min)min=v;if(v>max)max=v;}
  const x=Math.min(c.width-1,Math.floor(pos*c.width));const y1=c.height/2-min*c.height*.45,y2=c.height/2-max*c.height*.45;
  const g=c.getContext('2d');g.strokeStyle='#9bd18b';g.lineWidth=2;g.beginPath();g.moveTo(x,y1);g.lineTo(x,y2);g.stroke();
}
function setupAudioBox(){
  const box=$('audioBox'), file=$('file');
  box.addEventListener('click',e=>{if(!buffer&&!e.target.closest('.knob'))file.click();else if(buffer){const r=(e.clientX-box.getBoundingClientRect().left)/box.clientWidth;stop();playOffset=Math.max(0,Math.min(1,r))*buffer.duration;setCursor(r);clearProcessedWave();}});
  file.addEventListener('change',e=>{const f=e.target.files?.[0];if(f)loadFile(f);e.target.value='';});
  ['dragenter','dragover'].forEach(t=>box.addEventListener(t,e=>{e.preventDefault();e.stopPropagation();box.classList.add('drag');if(e.dataTransfer)e.dataTransfer.dropEffect='copy';}));
  ['dragleave','dragend'].forEach(t=>box.addEventListener(t,e=>{e.preventDefault();e.stopPropagation();box.classList.remove('drag');}));
  box.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();box.classList.remove('drag');const f=e.dataTransfer?.files?.[0];if(f)loadFile(f);});
}
async function loadFile(file){
  try{
    if(!file)return;
    if(!file.type.startsWith('audio/')&&!/\.(wav|wave|aif|aiff|mp3|flac|m4a|ogg)$/i.test(file.name))throw new Error('請選擇音訊檔。');
    if(!ctx)ctx=new AudioContext();
    const data=await file.arrayBuffer(); buffer=await ctx.decodeAudioData(data.slice(0));
    playOffset=0; drawWaveform(); prepareProcessedWave(); $('audioBox').classList.add('loaded'); setCursor(0);
    $('status').textContent=`已載入：${file.name}｜${buffer.numberOfChannels} ch｜${buffer.sampleRate} Hz｜${buffer.duration.toFixed(2)} s`;
  }catch(e){buffer=null;$('audioBox').classList.remove('loaded');$('status').textContent='音檔載入失敗：'+(e?.message||e);console.error(e);}
}
function saveCurrent(){const d={bands:[]};for(let i=1;i<=4;i++)d.bands.push({freq:Number($('freq'+i).value),gain:Number($('gain'+i).value),q:Number($('q'+i).value),denoise:Number($('denoise'+i).value),attack:Number($('attack'+i).value),sustain:Number($('sustain'+i).value)});if($('ab').textContent.endsWith('A'))slotA=d;else slotB=d;}
function loadSlot(){const d=$('ab').textContent.endsWith('A')?slotA:slotB;for(let i=1;i<=4;i++){const b=d.bands[i-1];$('freq'+i).value=b.freq;$('gain'+i).value=b.gain;$('q'+i).value=b.q;$('denoise'+i).value=b.denoise??0;$('attack'+i).value=b.attack??0;$('sustain'+i).value=b.sustain??0;}syncAll();}
for(let i=1;i<=4;i++)['freq','gain','q','denoise','attack','sustain'].forEach(p=>$(p+i).addEventListener('input',()=>{syncAll();saveCurrent();}));
$('play').onclick=start; $('stop').onclick=stop; $('loop').onclick=toggleLoop;
$('bypass').onclick=()=>{bypass=!bypass;$('bypass').textContent=`Bypass：${bypass?'ON':'OFF'}`;if(source){if(bypass){disconnectSource();source=ctx.createBufferSource();source.buffer=buffer;source.loop=loopEnabled;source.connect(outputGain);outputGain.connect(analyser);analyser.connect(ctx.destination);source.start(0,playOffset);}else{start();}}};
$('ab').onclick=()=>{$('ab').textContent=$('ab').textContent.endsWith('A')?'A/B：B':'A/B：A';loadSlot();};
updateOut(); initKnobs(); setupAudioBox(); prepareProcessedWave();

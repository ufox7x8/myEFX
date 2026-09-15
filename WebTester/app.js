let ctx=null, buffer=null, source=null, outputGain=null, analyser=null;
let stages=[], playing=false, loopEnabled=false, bypass=false, playStartTime=0, playOffset=0, rafId=0, loopCycle=-1;
let currentSlot='A';
const defaults=[
 {freq:100,gain:0,q:1,denoise:0,attack:0,sustain:0},
 {freq:500,gain:0,q:1,denoise:0,attack:0,sustain:0},
 {freq:2000,gain:0,q:1,denoise:0,attack:0,sustain:0},
 {freq:8000,gain:0,q:1,denoise:0,attack:0,sustain:0}
];
let slotA={bands:structuredClone(defaults)},slotB={bands:structuredClone(defaults)};
const $=id=>document.getElementById(id);
const paramKeys=['freq','gain','q','denoise','attack','sustain'];

function fmt(v,u=''){
  const n=Number(v);
  if(u==='Hz') return `${Math.round(n)} Hz`;
  if(u==='dB') return `${n.toFixed(1)} dB`;
  if(u==='%') return `${Math.round(n)}%`;
  return n.toFixed(2);
}
function knobAngle(id){
  const el=$(id); if(!el)return-135;
  const min=Number(el.min),max=Number(el.max),v=Number(el.value);
  return -135+270*((v-min)/(max-min||1));
}
function updateKnob(id){
  const k=document.querySelector(`.knob[data-target="${id}"]`); if(!k)return;
  const p=k.querySelector('.knob-pointer'); if(p)p.style.transform=`translateX(-50%) rotate(${knobAngle(id)}deg)`;
}
function updateOut(){
  for(let i=1;i<=4;i++){
    for(const p of paramKeys)updateKnob(p+i);
    $(`freq${i}Out`).textContent=fmt($(`freq${i}`).value,'Hz');
    $(`gain${i}Out`).textContent=fmt($(`gain${i}`).value,'dB');
    $(`q${i}Out`).textContent=fmt($(`q${i}`).value);
    $(`denoise${i}Out`).textContent=fmt($(`denoise${i}`).value,'%');
    $(`attack${i}Out`).textContent=fmt($(`attack${i}`).value,'%');
    $(`sustain${i}Out`).textContent=fmt($(`sustain${i}`).value,'%');
  }
}
function setKnobValue(input,v){
  const min=Number(input.min),max=Number(input.max),step=Number(input.step)||1;
  v=Math.max(min,Math.min(max,v));
  const decimals=(String(step).split('.')[1]||'').length;
  v=Number((Math.round(v/step)*step).toFixed(decimals));
  input.value=String(v);
  input.dispatchEvent(new Event('input',{bubbles:true}));
}
function knobStep(id){
  if(id.startsWith('freq')) return 10;
  if(id.startsWith('gain')) return .25;
  if(id.startsWith('q')) return .05;
  return 1;
}
function initKnobs(){
  document.querySelectorAll('.knob').forEach(knob=>{
    const id=knob.dataset.target,input=$(id); if(!input)return;
    let active=false,startY=0,startValue=0;
    knob.addEventListener('pointerdown',e=>{
      active=true;startY=e.clientY;startValue=Number(input.value);
      try{knob.setPointerCapture(e.pointerId)}catch{}
      e.preventDefault();
    });
    knob.addEventListener('pointermove',e=>{
      if(!active)return;
      const range=Number(input.max)-Number(input.min);
      const sensitivity=range/190;
      setKnobValue(input,startValue+(startY-e.clientY)*sensitivity);
      e.preventDefault();
    });
    const end=e=>{if(!active)return;active=false;try{knob.releasePointerCapture(e.pointerId)}catch{}};
    knob.addEventListener('pointerup',end); knob.addEventListener('pointercancel',end);
    knob.addEventListener('wheel',e=>{
      e.preventDefault();
      setKnobValue(input,Number(input.value)+(e.deltaY<0?knobStep(id):-knobStep(id)));
    },{passive:false});
    knob.addEventListener('dblclick',e=>{
      e.preventDefault();
      const reset=id.startsWith('freq')?Number(input.defaultValue):id.startsWith('q')?1:0;
      setKnobValue(input,reset);
    });
    knob.addEventListener('keydown',e=>{
      let v=Number(input.value),s=knobStep(id);
      if(e.key==='ArrowUp'||e.key==='ArrowRight'){v+=s;e.preventDefault()}
      if(e.key==='ArrowDown'||e.key==='ArrowLeft'){v-=s;e.preventDefault()}
      if(e.key==='Home'){v=Number(input.min);e.preventDefault()}
      if(e.key==='End'){v=Number(input.max);e.preventDefault()}
      if(e.key==='Enter'){v=id.startsWith('freq')?Number(input.defaultValue):id.startsWith('q')?1:0;e.preventDefault()}
      setKnobValue(input,v);
    });
  });
  updateOut();
}

function makeStage(){
  const eq=ctx.createBiquadFilter();eq.type='peaking';
  const pass=ctx.createBiquadFilter();pass.type='bandpass';
  const subtract=ctx.createGain();subtract.gain.value=-1;
  const out=ctx.createGain();
  const dDry=ctx.createGain(),dWet=ctx.createGain(),dSum=ctx.createGain();
  const comp=ctx.createDynamicsCompressor();comp.attack.value=.003;comp.release.value=.08;comp.knee.value=12;comp.ratio.value=20;
  const tDry=ctx.createGain(),tWet=ctx.createGain(),tSum=ctx.createGain();
  eq.connect(out);eq.connect(pass);pass.connect(subtract);subtract.connect(out);
  pass.connect(dDry);pass.connect(dWet);dDry.connect(dSum);dWet.connect(comp);comp.connect(dSum);
  dSum.connect(tDry);dSum.connect(tWet);tDry.connect(tSum);tSum.connect(out);
  return{eq,pass,subtract,out,dDry,dWet,dSum,comp,tDry,tWet,tSum,transient:null};
}
async function createTransient(stage){
  if(!ctx.audioWorklet||stage.transient)return;
  try{
    await ctx.audioWorklet.addModule('transient-processor.js?v=14');
    stage.transient=new AudioWorkletNode(ctx,'myefx-transient',{parameterData:{attack:0,sustain:0}});
    try{stage.tWet.disconnect()}catch{}
    stage.tWet.connect(stage.transient);stage.transient.connect(stage.tSum);
  }catch(e){stage.transient=null;console.warn('Transient fallback:',e)}
}
async function ensureGraph(){
  if(!ctx)ctx=new AudioContext();
  if(stages.length===0)for(let i=0;i<4;i++)stages.push(makeStage());
  if(!outputGain)outputGain=ctx.createGain();
  if(!analyser){analyser=ctx.createAnalyser();analyser.fftSize=2048;analyser.smoothingTimeConstant=.02}
  for(const s of stages)await createTransient(s);
  syncAll();
}
function syncEQ(){
  for(let i=1;i<=4;i++){
    const s=stages[i-1],f=Number($('freq'+i).value),q=Number($('q'+i).value),g=Number($('gain'+i).value);
    s.eq.frequency.value=f;s.eq.Q.value=q;s.eq.gain.value=g;
    s.pass.frequency.value=f;s.pass.Q.value=q;
  }
}
function syncDenoise(){
  for(let i=1;i<=4;i++){
    const a=Number($('denoise'+i).value)/100,s=stages[i-1];
    s.dDry.gain.value=1-a;s.dWet.gain.value=a;
    s.comp.threshold.value=-60+a*35;s.comp.ratio.value=1+a*39;
  }
}
function syncTransient(){
  for(let i=1;i<=4;i++){
    const s=stages[i-1],a=Number($('attack'+i).value),su=Number($('sustain'+i).value);
    const mix=Math.min(1,(Math.abs(a)+Math.abs(su))/200);
    s.tDry.gain.value=1-mix;s.tWet.gain.value=mix;
    if(s.transient){
      const ap=s.transient.parameters.get('attack'),sp=s.transient.parameters.get('sustain');
      if(ap)ap.setValueAtTime(a,ctx.currentTime);if(sp)sp.setValueAtTime(su,ctx.currentTime);
    }
  }
}
function syncAll(){syncEQ();syncDenoise();syncTransient();updateOut()}

function disconnectAudio(){
  try{source?.stop()}catch{}
  try{source?.disconnect()}catch{}
  try{outputGain?.disconnect()}catch{}
  try{analyser?.disconnect()}catch{}
  source=null;
}
function buildPlayback(){
  disconnectAudio();
  source=ctx.createBufferSource();source.buffer=buffer;source.loop=loopEnabled;source.loopStart=0;source.loopEnd=buffer.duration;
  if(bypass){source.connect(ctx.destination);return;}
  let node=source;
  for(const s of stages){node.connect(s.eq);node=s.out}
  node.connect(outputGain);outputGain.connect(analyser);analyser.connect(ctx.destination);
}
async function start(){
  if(!buffer){$('status').textContent='請先載入音檔。';return}
  try{
    if(!ctx)ctx=new AudioContext();
    await ctx.resume();
    if(ctx.state!=='running')throw new Error('AudioContext 未進入 running');
    await ensureGraph();syncAll();buildPlayback();
    playStartTime=ctx.currentTime;loopCycle=-1;
    const startAt=Math.max(0,Math.min(playOffset,Math.max(0,buffer.duration-.001)));
    source.start(0,startAt);playing=true;
    $('play').textContent='❚❚ 播放中';$('status').textContent=`播放中${loopEnabled?'｜LOOP ON':''}${bypass?'｜BYPASS':''}`;
    updateCursor();
  }catch(e){playing=false;$('status').textContent='播放失敗：'+(e?.message||e);console.error(e)}
}
function stop(){
  if(playing&&ctx&&buffer){
    const elapsed=Math.max(0,ctx.currentTime-playStartTime);
    if(loopEnabled)playOffset=(playOffset+elapsed)%buffer.duration;
    else playOffset=Math.min(buffer.duration,playOffset+elapsed);
  }
  playing=false;disconnectAudio();stopAnimation();
  $('play').textContent='▶ 播放';
  setCursor(buffer&&buffer.duration?playOffset/buffer.duration:0);
  $('status').textContent='已停止';
}
function toggleLoop(){
  loopEnabled=!loopEnabled;$('loop').textContent=`LOOP ${loopEnabled?'ON':'OFF'}`;$('loop').classList.toggle('active',loopEnabled);
  if(source){source.loop=loopEnabled;source.loopStart=0;source.loopEnd=buffer.duration}
}
function updateCursor(){
  if(!playing||!ctx||!buffer)return;
  const elapsed=ctx.currentTime-playStartTime;let total=playOffset+elapsed;let pos=total/buffer.duration;
  if(loopEnabled){
    const cycle=Math.floor(total/buffer.duration);
    if(cycle!==loopCycle){loopCycle=cycle;if(cycle>0)clearProcessedWave()}
    pos=(total%buffer.duration)/buffer.duration;
  }
  if(!loopEnabled&&pos>=1){pos=1;playing=false;disconnectAudio();$('play').textContent='▶ 播放';$('status').textContent='播放結束';stopAnimation()}
  setCursor(pos);drawProcessedSlice(pos);
  if(playing)rafId=requestAnimationFrame(updateCursor);
}
function stopAnimation(){cancelAnimationFrame(rafId);rafId=0}
function setCursor(r){
  const c=$('wave');if(!c)return;const x=Math.max(0,Math.min(1,r))*c.clientWidth;
  $('cursor').style.left=`${x}px`;$('time').textContent=buffer?`${(Math.max(0,Math.min(1,r))*buffer.duration).toFixed(2)} / ${buffer.duration.toFixed(2)} s`:'0.00 / 0.00 s';
}
function drawWaveform(){
  const c=$('wave'),box=$('audioBox');if(!c||!buffer)return;
  const w=Math.max(800,Math.floor(box.clientWidth*2)),h=440;c.width=w;c.height=h;
  const g=c.getContext('2d'),ch=buffer.getChannelData(0),step=Math.max(1,Math.floor(ch.length/w));
  g.clearRect(0,0,w,h);g.fillStyle='#080c11';g.fillRect(0,0,w,h);
  g.strokeStyle='#1b2630';g.lineWidth=1;
  for(let i=1;i<10;i++){const x=i*w/10;g.beginPath();g.moveTo(x,0);g.lineTo(x,h);g.stroke()}
  for(let i=1;i<4;i++){const y=i*h/4;g.beginPath();g.moveTo(0,y);g.lineTo(w,y);g.stroke()}
  g.strokeStyle='#3c5563';g.beginPath();g.moveTo(0,h/2);g.lineTo(w,h/2);g.stroke();
  g.strokeStyle='#61b7c7';g.lineWidth=1.2;g.beginPath();
  for(let x=0;x<w;x++){
    let min=1,max=-1,start=x*step,end=Math.min(ch.length,start+step);
    for(let i=start;i<end;i++){const v=ch[i];if(v<min)min=v;if(v>max)max=v}
    g.moveTo(x,h/2+min*h*.43);g.lineTo(x,h/2+max*h*.43);
  }
  g.stroke();
}
function prepareProcessedWave(){
  const c=$('processedWave');if(!c)return;const box=c.parentElement,w=Math.max(800,Math.floor(box.clientWidth*2)),h=336;c.width=w;c.height=h;clearProcessedWave();
}
function clearProcessedWave(){
  const c=$('processedWave');if(!c)return;const g=c.getContext('2d');g.clearRect(0,0,c.width,c.height);g.fillStyle='#090e13';g.fillRect(0,0,c.width,c.height);
  g.strokeStyle='#1b2630';g.lineWidth=1;for(let i=1;i<10;i++){const x=i*c.width/10;g.beginPath();g.moveTo(x,0);g.lineTo(x,c.height);g.stroke()}
  g.strokeStyle='#334751';g.beginPath();g.moveTo(0,c.height/2);g.lineTo(c.width,c.height/2);g.stroke();
}
function drawProcessedSlice(pos){
  if(!analyser||!buffer||bypass)return;
  const c=$('processedWave');if(!c)return;const data=new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);const x=Math.max(0,Math.min(c.width-1,Math.floor(pos*c.width))),span=Math.max(14,Math.floor(c.width*.045));
  const left=Math.max(0,x-span),right=Math.min(c.width-1,x+span);const g=c.getContext('2d');
  g.clearRect(left-2,0,(right-left)+4,c.height);g.strokeStyle='#78d39b';g.lineWidth=1.4;g.beginPath();
  for(let px=left;px<=right;px++){const t=(px-left)/Math.max(1,right-left),idx=Math.min(data.length-1,Math.floor(t*(data.length-1))),y=c.height/2-data[idx]*c.height*.42;if(px===left)g.moveTo(px,y);else g.lineTo(px,y)}g.stroke();
}
function setupAudioBox(){
  const box=$('audioBox'),file=$('file');
  box.addEventListener('click',e=>{
    if(e.target!==box&&e.target.closest('#wave')){if(buffer){const r=(e.clientX-box.getBoundingClientRect().left)/box.clientWidth;stop();playOffset=Math.max(0,Math.min(1,r))*buffer.duration;setCursor(r);clearProcessedWave();}return;}
    if(!buffer)file.click();
    else{const r=(e.clientX-box.getBoundingClientRect().left)/box.clientWidth;stop();playOffset=Math.max(0,Math.min(1,r))*buffer.duration;setCursor(r);clearProcessedWave();}
  });
  file.addEventListener('change',e=>{const f=e.target.files?.[0];if(f)loadFile(f);e.target.value=''});
  ['dragenter','dragover'].forEach(t=>box.addEventListener(t,e=>{e.preventDefault();e.stopPropagation();box.classList.add('drag');e.dataTransfer.dropEffect='copy'}));
  ['dragleave','dragend'].forEach(t=>box.addEventListener(t,e=>{e.preventDefault();e.stopPropagation();box.classList.remove('drag')}));
  box.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();box.classList.remove('drag');const f=e.dataTransfer?.files?.[0];if(f)loadFile(f)});
  window.addEventListener('resize',()=>{if(buffer){drawWaveform();prepareProcessedWave()}});
}
async function loadFile(file){
  try{
    if(!file)return;if(!file.type.startsWith('audio/')&&!/\.(wav|wave|aif|aiff|mp3|flac|m4a|ogg)$/i.test(file.name))throw new Error('請選擇音訊檔。');
    if(!ctx)ctx=new AudioContext();const data=await file.arrayBuffer();buffer=await ctx.decodeAudioData(data.slice(0));playOffset=0;
    drawWaveform();prepareProcessedWave();$('audioBox').classList.add('loaded');$('fileInfo').textContent=`${file.name} · ${buffer.numberOfChannels}ch · ${buffer.sampleRate}Hz · ${buffer.duration.toFixed(2)}s`;
    setCursor(0);$('status').textContent='已載入音檔，可直接按播放或拖曳播放位置。';
  }catch(e){buffer=null;$('audioBox').classList.remove('loaded');$('fileInfo').textContent='未載入';$('status').textContent='音檔載入失敗：'+(e?.message||e);console.error(e)}
}
function readCurrent(){
  const d={bands:[]};for(let i=1;i<=4;i++)d.bands.push({freq:Number($('freq'+i).value),gain:Number($('gain'+i).value),q:Number($('q'+i).value),denoise:Number($('denoise'+i).value),attack:Number($('attack'+i).value),sustain:Number($('sustain'+i).value)});return d;
}
function applyData(d){
  for(let i=1;i<=4;i++){const b=d.bands[i-1];$('freq'+i).value=b.freq;$('gain'+i).value=b.gain;$('q'+i).value=b.q;$('denoise'+i).value=b.denoise??0;$('attack'+i).value=b.attack??0;$('sustain'+i).value=b.sustain??0}
  syncAll();
}
function saveCurrent(){if(currentSlot==='A')slotA=readCurrent();else slotB=readCurrent()}
function resetBand(i){
  const b=defaults[i-1];for(const p of paramKeys)$(`${p}${i}`).value=b[p];syncAll();saveCurrent();
}
function resetAll(){applyData({bands:structuredClone(defaults)});saveCurrent()}
for(let i=1;i<=4;i++)for(const p of paramKeys)$(p+i).addEventListener('input',()=>{syncAll();saveCurrent()});
$('play').onclick=()=>playing?stop():start();
$('stop').onclick=stop;
$('loop').onclick=toggleLoop;
$('bypass').onclick=()=>{
  bypass=!bypass;$('bypass').textContent=`BYPASS ${bypass?'ON':'OFF'}`;$('bypass').classList.toggle('active',bypass);
  if(playing){const was=playOffset;stop();playOffset=was;start()}
};
$('ab').onclick=()=>{saveCurrent();currentSlot=currentSlot==='A'?'B':'A';$('ab').textContent=`A/B · ${currentSlot}`;applyData(currentSlot==='A'?slotA:slotB)};
$('resetAll').onclick=resetAll;
$('about').onclick=()=>{$('status').textContent='myEFX Web Tester · 4 Band EQ + De-noise + Transient'};
document.addEventListener('click',e=>{const b=e.target.closest('.band-chip');if(!b)return;const i=Number(b.dataset.band);if(b.dataset.action==='reset')resetBand(i);if(b.dataset.action==='zero'){for(const p of ['gain','denoise','attack','sustain'])$(`${p}${i}`).value=0;syncAll();saveCurrent()}});
updateOut();initKnobs();setupAudioBox();prepareProcessedWave();

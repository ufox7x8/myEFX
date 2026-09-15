from pathlib import Path
import re

root=Path('WebTester')
app=root/'app.js'
html=root/'index.html'

s=app.read_text(encoding='utf-8')

make_stage=r'''function makeStage(){
  const eq=ctx.createBiquadFilter();eq.type='peaking';
  const pass=ctx.createBiquadFilter();pass.type='bandpass';
  const subtract=ctx.createGain();subtract.gain.value=-1;
  const out=ctx.createGain();
  const dDry=ctx.createGain(),dWet=ctx.createGain(),dSum=ctx.createGain();
  const tDry=ctx.createGain(),tWet=ctx.createGain(),tSum=ctx.createGain();
  eq.connect(out);eq.connect(pass);pass.connect(subtract);subtract.connect(out);
  pass.connect(dDry);pass.connect(dWet);dDry.connect(dSum);dWet.connect(dSum);
  dSum.connect(tDry);dSum.connect(tWet);tDry.connect(tSum);tSum.connect(out);
  return{eq,pass,subtract,out,dDry,dWet,dSum,tDry,tWet,tSum,denoise:null,transient:null};
}'''
s,n=re.subn(r"function makeStage\(\)\{.*?return\{eq,pass,subtract,out,dDry,dWet,dSum,comp,tDry,tWet,tSum,transient:null\};\n\}",make_stage,s,flags=re.S)
if n!=1: raise SystemExit('makeStage patch failed')

create_nodes=r'''async function createDenoise(stage){
  if(!ctx.audioWorklet||stage.denoise)return;
  try{
    await ctx.audioWorklet.addModule('denoise-processor.js?v=60');
    stage.denoise=new AudioWorkletNode(ctx,'myefx-denoise',{parameterData:{amount:0,threshold:0,reduction:12,attack:10,release:120,adaptive:1,optimize:0,filterType:0,noiseType:0,adaptationTime:1,softKnee:25,maxAttenuation:30,dynamicProfile:1,learn:0}});
    try{stage.dWet.disconnect()}catch{}
    stage.dWet.connect(stage.denoise);stage.denoise.connect(stage.dSum);
  }catch(e){stage.denoise=null;console.warn('Denoise unavailable:',e)}
}
async function createTransient(stage){
  if(!ctx.audioWorklet||stage.transient)return;
  try{
    await ctx.audioWorklet.addModule('transient-processor.js?v=15');
    stage.transient=new AudioWorkletNode(ctx,'myefx-transient',{parameterData:{attack:0,sustain:0}});
    try{stage.tWet.disconnect()}catch{}
    stage.tWet.connect(stage.transient);stage.transient.connect(stage.tSum);
  }catch(e){stage.transient=null;console.warn('Transient fallback:',e)}
}'''
s,n=re.subn(r"async function createTransient\(stage\)\{.*?\n\}\nasync function ensureGraph",create_nodes+"\nasync function ensureGraph",s,flags=re.S)
if n!=1: raise SystemExit('create nodes patch failed')

ensure=r'''async function ensureGraph(){
  if(!ctx)ctx=new AudioContext();
  if(stages.length===0)for(let i=0;i<4;i++)stages.push(makeStage());
  if(!outputGain)outputGain=ctx.createGain();
  if(!analyser){analyser=ctx.createAnalyser();analyser.fftSize=2048;analyser.smoothingTimeConstant=.02}
  for(const stage of stages){await createDenoise(stage);await createTransient(stage)}
  syncAll();
}'''
s,n=re.subn(r"async function ensureGraph\(\)\{.*?\n\}",ensure,s,count=1,flags=re.S)
if n!=1: raise SystemExit('ensureGraph patch failed')

sync_adv=r'''function readDenoiseControls(i){
  const g=id=>Number($(id).value);
  return {
    mode:g('dnMode'+i),optimize:g('dnOptimize'+i),filter:g('dnFilter'+i),noiseType:g('dnNoiseType'+i),
    threshold:g('dnThreshold'+i),reduction:g('dnReduction'+i),adaptation:g('dnAdapt'+i),knee:g('dnKnee'+i),
    attack:g('dnAttack'+i),release:g('dnRelease'+i),maxAtt:g('dnMaxAtt'+i),dynamic:g('dnDynamic'+i)
  };
}
function syncDenoise(){
  for(let i=1;i<=4;i++){
    const s=stages[i-1],amount=Number($('denoise'+i).value)/100,c=readDenoiseControls(i);
    s.dDry.gain.value=1-amount;s.dWet.gain.value=amount;
    if(s.denoise){
      const set=(name,v)=>{const p=s.denoise.parameters.get(name);if(p)p.setValueAtTime(v,ctx.currentTime)};
      set('amount',amount*100);set('threshold',c.threshold);set('reduction',c.reduction);set('attack',c.attack);set('release',c.release);
      set('adaptive',c.mode);set('optimize',c.optimize);set('filterType',c.filter);set('noiseType',c.noiseType);set('adaptationTime',c.adaptation);set('softKnee',c.knee);set('maxAttenuation',c.maxAtt);set('dynamicProfile',c.dynamic);
    }
    const out=(id,v)=>{const e=$(id);if(e)e.textContent=v};
    out('dnThreshold'+i+'Out',c.threshold.toFixed(1)+' dB');out('dnReduction'+i+'Out',c.reduction.toFixed(1)+' dB');out('dnAdapt'+i+'Out',c.adaptation.toFixed(1)+' s');out('dnKnee'+i+'Out',Math.round(c.knee)+'%');out('dnAttack'+i+'Out',Math.round(c.attack)+' ms');out('dnRelease'+i+'Out',Math.round(c.release)+' ms');out('dnMaxAtt'+i+'Out',c.maxAtt.toFixed(1)+' dB');
  }
}'''
s,n=re.subn(r"function syncDenoise\(\)\{.*?\n\}",sync_adv,s,count=1,flags=re.S)
if n!=1: raise SystemExit('syncDenoise patch failed')

# bind advanced controls and Learn buttons immediately before A/B bindings
marker="$('play').onclick=()=>playing?stop():start();"
advanced_bind=r'''for(let i=1;i<=4;i++){
  for(const id of ['dnMode','dnOptimize','dnFilter','dnNoiseType','dnThreshold','dnReduction','dnAdapt','dnKnee','dnAttack','dnRelease','dnMaxAtt','dnDynamic']){
    const e=$(id+i);if(e)e.addEventListener('input',()=>{if(stages.length)syncDenoise();});
  }
  const learn=$('dnLearn'+i);
  if(learn)learn.onclick=()=>{
    const stage=stages[i-1];
    if(!stage?.denoise){$('status').textContent='請先按播放，再 Learn 一段純噪聲。';return}
    const p=stage.denoise.parameters.get('learn');
    if(!p)return;
    p.setValueAtTime(1,ctx.currentTime);learn.classList.add('active');learn.textContent='LEARNING… 1.5s';
    setTimeout(()=>{try{p.setValueAtTime(0,ctx.currentTime)}catch{}learn.classList.remove('active');learn.textContent='LEARN NOISE PROFILE';},1500);
  };
  const reset=$('dnReset'+i);
  if(reset)reset.onclick=()=>{
    $('dnMode'+i).value=1;$('dnOptimize'+i).value=0;$('dnFilter'+i).value=0;$('dnNoiseType'+i).value=0;$('dnThreshold'+i).value=0;$('dnReduction'+i).value=12;$('dnAdapt'+i).value=1;$('dnKnee'+i).value=25;$('dnAttack'+i).value=10;$('dnRelease'+i).value=120;$('dnMaxAtt'+i).value=30;$('dnDynamic'+i).value=1;syncDenoise();
  };
}

$('play').onclick=()=>playing?stop():start();'''
s=s.replace(marker,advanced_bind,1)
app.write_text(s,encoding='utf-8')

h=html.read_text(encoding='utf-8')
if 'denoise-ui.js' not in h:
    h=h.replace('<script src="app.js?v=41"></script>','<script src="denoise-ui.js?v=1"></script>\n<script src="app.js?v=60"></script>')
    h=h.replace('<script src="app.js?v=30"></script>','<script src="denoise-ui.js?v=1"></script>\n<script src="app.js?v=60"></script>')
html.write_text(h,encoding='utf-8')
print('Patched WebTester for advanced De-noise controls')

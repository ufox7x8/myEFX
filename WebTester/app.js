let ctx=null, buffer=null, source=null, gainNode=null, transientNode=null;
let filters=[], playing=false, bypass=false;
const bandDefaults=[
 {freq:100,gain:0,q:1},
 {freq:500,gain:0,q:1},
 {freq:2000,gain:0,q:1},
 {freq:8000,gain:0,q:1}
];
let slotA={bands:structuredClone(bandDefaults),attack:0,sustain:0};
let slotB={bands:structuredClone(bandDefaults),attack:0,sustain:0};
const $=id=>document.getElementById(id);
function fmt(v,unit=''){return `${Number(v).toFixed(unit==='Hz'?0:unit==='dB'?1:2)} ${unit}`.trim()}
function updateOut(){
 for(let i=1;i<=4;i++){
   $(`freq${i}Out`).value=fmt($(`freq${i}`).value,'Hz');
   $(`gain${i}Out`).value=fmt($(`gain${i}`).value,'dB');
   $(`q${i}Out`).value=fmt($(`q${i}`).value,'');
 }
 $('attackOut').value=`${$('attack').value}%`;
 $('sustainOut').value=`${$('sustain').value}%`;
 $('denoiseOut').value=`${$('denoise').value}%`;
}
function ensureGraph(){
 if(!ctx)ctx=new AudioContext();
 if(filters.length===0){
   for(let i=1;i<=4;i++){
     const f=ctx.createBiquadFilter();
     f.type='peaking';
     filters.push(f);
   }
 }
 if(!gainNode){gainNode=ctx.createGain();gainNode.gain.value=1;}
 if(!transientNode)createTransientNode().catch(e=>{
   console.error(e);
   $('status').textContent='Transient 初始化失敗：'+e.message;
 });
 syncEQ();
 syncTransient();
}
async function createTransientNode(){
 if(transientNode)return;
 await ctx.audioWorklet.addModule('transient-processor.js');
 transientNode=new AudioWorkletNode(ctx,'myefx-transient',{parameterData:{attack:0,sustain:0}});
}
function syncEQ(){
 for(let i=1;i<=4;i++){
   const f=filters[i-1];
   f.frequency.value=Number($(`freq${i}`).value);
   f.gain.value=Number($(`gain${i}`).value);
   f.Q.value=Number($(`q${i}`).value);
 }
}
function syncTransient(){
 if(!transientNode)return;
 const a=transientNode.parameters.get('attack');
 const s=transientNode.parameters.get('sustain');
 if(a)a.setValueAtTime(Number($('attack').value),ctx.currentTime);
 if(s)s.setValueAtTime(Number($('sustain').value),ctx.currentTime);
}
function disconnectGraph(){
 try{gainNode?.disconnect();transientNode?.disconnect();filters.forEach(f=>f.disconnect());}catch{}
}
function connectPlaybackChain(){
 if(!source||!filters.length||!gainNode||!transientNode)return;
 disconnectGraph();
 source.disconnect();
 if(bypass){
   source.connect(gainNode);
 }else{
   source.connect(filters[0]);
   for(let i=0;i<filters.length-1;i++)filters[i].connect(filters[i+1]);
   filters[3].connect(transientNode);
   transientNode.connect(gainNode);
 }
 gainNode.connect(ctx.destination);
}
function saveCurrent(){
 const data={bands:[],attack:Number($('attack').value),sustain:Number($('sustain').value)};
 for(let i=1;i<=4;i++)data.bands.push({freq:Number($(`freq${i}`).value),gain:Number($(`gain${i}`).value),q:Number($(`q${i}`).value)});
 if($('ab').textContent.endsWith('A'))slotA=data;else slotB=data;
}
function loadSlot(){
 const o=$('ab').textContent.endsWith('A')?slotA:slotB;
 for(let i=1;i<=4;i++){
   $('freq'+i).value=o.bands[i-1].freq;
   $('gain'+i).value=o.bands[i-1].gain;
   $('q'+i).value=o.bands[i-1].q;
 }
 $('attack').value=o.attack;
 $('sustain').value=o.sustain;
 updateOut();syncEQ();syncTransient();
}
async function loadFile(file){
 try{
   if(!ctx)ctx=new AudioContext();
   if(!file.type.startsWith('audio/')&&!/\.(wav|wave|aif|aiff|mp3|flac|m4a|ogg)$/i.test(file.name))throw new Error('請選擇音訊檔案。');
   const ab=await file.arrayBuffer();
   buffer=await ctx.decodeAudioData(ab.slice(0));
   $('status').textContent=`已載入：${file.name}｜${buffer.numberOfChannels} ch｜${buffer.sampleRate} Hz｜${buffer.duration.toFixed(2)} s｜可以按播放`;
 }catch(e){buffer=null;$('status').textContent='音檔載入失敗：'+(e?.message||e);}
}
async function start(){
 if(!buffer){$('status').textContent='請先載入 WAV / AIFF。';return;}
 try{
   if(!ctx)ctx=new AudioContext();
   ensureGraph();
   await ctx.resume();
   if(!transientNode)await createTransientNode();
   syncEQ();syncTransient();
   if(ctx.state!=='running')throw new Error(`AudioContext 狀態：${ctx.state}`);
   if(source){try{source.stop()}catch{}try{source.disconnect()}catch{}source=null;}
   source=ctx.createBufferSource();
   source.buffer=buffer;
   source.onended=()=>{playing=false;source=null;if($('status').textContent.startsWith('播放中'))$('status').textContent='播放結束';};
   connectPlaybackChain();
   source.start(0);
   playing=true;
   $('status').textContent=`播放中｜${buffer.sampleRate} Hz｜4 Band EQ + Transient`;
 }catch(e){playing=false;$('status').textContent='播放失敗：'+(e?.message||e);console.error(e);}
}
function stop(){
 if(source){try{source.stop()}catch{}try{source.disconnect()}catch{}source=null;}
 playing=false;$('status').textContent='已停止';
}
$('file').addEventListener('change',e=>{if(e.target.files[0])loadFile(e.target.files[0])});
$('drop').addEventListener('dragover',e=>{e.preventDefault();$('drop').style.borderColor='#999';e.dataTransfer.dropEffect='copy'});
$('drop').addEventListener('dragleave',()=>$('drop').style.borderColor='#555');
$('drop').addEventListener('drop',e=>{e.preventDefault();$('drop').style.borderColor='#555';const f=e.dataTransfer.files[0];if(f)loadFile(f)});
for(let i=1;i<=4;i++)['freq','gain','q'].forEach(p=>$(p+i).addEventListener('input',()=>{updateOut();saveCurrent();syncEQ()}));
['attack','sustain','denoise'].forEach(id=>$(id).addEventListener('input',()=>{updateOut();saveCurrent();syncTransient()}));
$('play').onclick=start;
$('stop').onclick=stop;
$('bypass').onclick=()=>{bypass=!bypass;$('bypass').textContent=`Bypass：${bypass?'ON':'OFF'}`;if(source)connectPlaybackChain()};
$('ab').onclick=()=>{$('ab').textContent=$('ab').textContent.endsWith('A')?'A/B：B':'A/B：A';loadSlot()};
updateOut();

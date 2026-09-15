let ctx=null, buffer=null, source=null, filter=null, gainNode=null;
let playing=false, bypass=false, slotA={freq:1000,gain:0,q:1}, slotB={freq:1000,gain:0,q:1};
const $=id=>document.getElementById(id);
function fmt(v,unit=''){return `${Number(v).toFixed(unit==='Hz'?0:unit==='dB'?1:2)} ${unit}`.trim()}
function updateOut(){
 $('freqOut').value=fmt($('freq').value,'Hz');
 $('gainOut').value=fmt($('gain').value,'dB');
 $('qOut').value=fmt($('q').value,'');
 $('dynOut').value=fmt($('dyn').value,'dB');
 $('transOut').value=`${$('trans').value}%`;
 $('denoiseOut').value=`${$('denoise').value}%`;
}
function connectGraph(){
 if(!ctx||!filter||!gainNode)return;
 try{filter.disconnect();gainNode.disconnect()}catch{}
 if(bypass)gainNode.connect(ctx.destination);else filter.connect(gainNode);
}
function syncToNode(){if(!filter)return;filter.frequency.value=Number($('freq').value);filter.gain.value=Number($('gain').value);filter.Q.value=Number($('q').value);connectGraph();}
function saveCurrent(){const o={freq:Number($('freq').value),gain:Number($('gain').value),q:Number($('q').value)};if($('ab').textContent.endsWith('A'))slotA=o;else slotB=o;}
function loadSlot(){const o=$('ab').textContent.endsWith('A')?slotA:slotB;$('freq').value=o.freq;$('gain').value=o.gain;$('q').value=o.q;updateOut();syncToNode();}
function ensureGraph(){
 if(!ctx)ctx=new AudioContext();
 if(!gainNode){gainNode=ctx.createGain();gainNode.gain.value=1;}
 if(!filter){filter=ctx.createBiquadFilter();filter.type='peaking';filter.frequency.value=1000;filter.gain.value=0;filter.Q.value=1;}
 connectGraph();
}
async function loadFile(file){
 try{ctx=ctx||new AudioContext();const ab=await file.arrayBuffer();buffer=await ctx.decodeAudioData(ab);$('status').textContent=`已載入：${file.name}｜${buffer.numberOfChannels} ch｜${buffer.sampleRate} Hz｜${buffer.duration.toFixed(2)} s`;}
 catch(e){$('status').textContent='音檔載入失敗：'+e.message;}
}
function start(){
 if(!buffer){$('status').textContent='請先載入 WAV / AIFF。';return;}
 ensureGraph(); if(ctx.state==='suspended')ctx.resume(); if(source)try{source.stop()}catch{}
 source=ctx.createBufferSource();source.buffer=buffer;source.connect(filter);source.onended=()=>{playing=false};source.start();playing=true;$('status').textContent='播放中';
}
function stop(){if(source)try{source.stop()}catch{}playing=false;$('status').textContent='已停止';}
$('file').addEventListener('change',e=>{if(e.target.files[0])loadFile(e.target.files[0])});
$('drop').addEventListener('dragover',e=>{e.preventDefault();$('drop').style.borderColor='#999'});
$('drop').addEventListener('dragleave',()=>$('drop').style.borderColor='#555');
$('drop').addEventListener('drop',e=>{e.preventDefault();$('drop').style.borderColor='#555';const f=e.dataTransfer.files[0];if(f)loadFile(f)});
['freq','gain','q','dyn','trans','denoise'].forEach(id=>$(id).addEventListener('input',()=>{updateOut();saveCurrent();syncToNode()}));
$('play').onclick=start;$('stop').onclick=stop;
$('bypass').onclick=()=>{bypass=!bypass;$('bypass').textContent=`Bypass：${bypass?'ON':'OFF'}`;connectGraph()};
$('ab').onclick=()=>{$('ab').textContent=$('ab').textContent.endsWith('A')?'A/B：B':'A/B：A';loadSlot()};
updateOut();

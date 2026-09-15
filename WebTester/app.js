let ctx=null,buffer=null,source=null,gainNode=null;
let stages=[],playing=false,bypass=false,playStartTime=0,playOffset=0,rafId=null;
const defaults=[
 {freq:100,gain:0,q:1,denoise:0,attack:0,sustain:0},
 {freq:500,gain:0,q:1,denoise:0,attack:0,sustain:0},
 {freq:2000,gain:0,q:1,denoise:0,attack:0,sustain:0},
 {freq:8000,gain:0,q:1,denoise:0,attack:0,sustain:0}
];
let slotA={bands:structuredClone(defaults)},slotB={bands:structuredClone(defaults)};
const $=id=>document.getElementById(id);
function fmt(v,u=''){return `${Number(v).toFixed(u==='Hz'?0:u==='dB'?1:2)} ${u}`.trim()}
function updateOut(){for(let i=1;i<=4;i++){ $(`freq${i}Out`).value=fmt($(`freq${i}`).value,'Hz');$(`gain${i}Out`).value=fmt($(`gain${i}`).value,'dB');$(`q${i}Out`).value=fmt($(`q${i}`).value);$(`denoise${i}Out`).value=`${$('denoise'+i).value}%`;$(`attack${i}Out`).value=`${$('attack'+i).value}%`;$(`sustain${i}Out`).value=`${$('sustain'+i).value}%`;}}
function makeStage(){
 const eq=ctx.createBiquadFilter();eq.type='peaking';
 const pass=ctx.createBiquadFilter();pass.type='bandpass';
 const out=ctx.createGain();
 const subtract=ctx.createGain();subtract.gain.value=-1;
 const dDry=ctx.createGain(),dWet=ctx.createGain(),dSum=ctx.createGain();
 const comp=ctx.createDynamicsCompressor();comp.attack.value=.003;comp.release.value=.08;comp.knee.value=12;comp.ratio.value=20;const dCompWet=ctx.createGain();
 const tDry=ctx.createGain(),tWet=ctx.createGain(),tSum=ctx.createGain();
 eq.connect(out);eq.connect(pass);pass.connect(subtract);subtract.connect(out);
 pass.connect(dDry);pass.connect(dWet);dDry.connect(dSum);dWet.connect(comp);comp.connect(dCompWet);dCompWet.connect(dSum);
 dSum.connect(tDry);dSum.connect(tWet);tDry.connect(tSum);
 return{eq,pass,out,subtract,dDry,dWet,dSum,comp,dCompWet,tDry,tWet,tSum,transient:null};
}
async function ensureGraph(){
 if(!ctx)ctx=new AudioContext();
 if(stages.length===0)for(let i=0;i<4;i++)stages.push(makeStage());
 if(!gainNode)gainNode=ctx.createGain();
 if(ctx.audioWorklet){for(const s of stages)if(!s.transient){try{s.transient=await createBandTransientNode()}catch(e){console.warn('Band transient disabled:',e)}}}
 syncEQ();syncDenoise();syncTransient();
}
async function createBandTransientNode(){await ctx.audioWorklet.addModule('transient-processor.js?v=9');return new AudioWorkletNode(ctx,'myefx-transient',{parameterData:{attack:0,sustain:0}})}
function syncEQ(){for(let i=1;i<=4;i++){const s=stages[i-1],f=Number($('freq'+i).value),q=Number($('q'+i).value),g=Number($('gain'+i).value);s.eq.frequency.value=f;s.eq.Q.value=q;s.eq.gain.value=g;s.pass.frequency.value=f;s.pass.Q.value=q}}
function syncDenoise(){for(let i=1;i<=4;i++){const a=Number($('denoise'+i).value)/100,s=stages[i-1];s.dDry.gain.value=1-a;s.dWet.gain.value=a;s.comp.threshold.value=-60+a*35;s.comp.ratio.value=1+a*39}}
function syncTransient(){for(let i=1;i<=4;i++){const s=stages[i-1],node=s.transient;if(!node)continue;const a=Number($('attack'+i).value),su=Number($('sustain'+i).value);const mix=Math.min(1,(Math.abs(a)+Math.abs(su))/200);s.tDry.gain.value=1-mix;s.tWet.gain.value=mix;const ap=node.parameters.get('attack'),sp=node.parameters.get('sustain');if(ap)ap.setValueAtTime(a,ctx.currentTime);if(sp)sp.setValueAtTime(su,ctx.currentTime)}}
function disconnectGraph(){try{source?.disconnect();gainNode?.disconnect();stages.forEach(s=>{s.eq.disconnect();s.pass.disconnect();s.out.disconnect();s.subtract.disconnect();s.dDry.disconnect();s.dWet.disconnect();s.dSum.disconnect();s.comp.disconnect();s.dCompWet.disconnect();s.tDry.disconnect();s.tWet.disconnect();s.tSum.disconnect();s.transient?.disconnect()})}catch{}}
function connectPlaybackChain(){
 if(!source||!gainNode||!stages.length)return;
 disconnectGraph();
 if(bypass){source.connect(gainNode)}else{
  let node=source;
  for(const s of stages){node.connect(s.eq);node=s.out;}
  node.connect(gainNode);
 }
 gainNode.connect(ctx.destination);
}
function routeTransient(s){if(s.transient){s.tWet.connect(s.transient);s.transient.connect(s.tSum)}else{s.tWet.connect(s.tSum)}}
for(const s of stages)routeTransient(s);
function saveCurrent(){const d={bands:[]};for(let i=1;i<=4;i++)d.bands.push({freq:Number($('freq'+i).value),gain:Number($('gain'+i).value),q:Number($('q'+i).value),denoise:Number($('denoise'+i).value),attack:Number($('attack'+i).value),sustain:Number($('sustain'+i).value)});if($('ab').textContent.endsWith('A'))slotA=d;else slotB=d}
function loadSlot(){const d=$('ab').textContent.endsWith('A')?slotA:slotB;for(let i=1;i<=4;i++){const b=d.bands[i-1];$('freq'+i).value=b.freq;$('gain'+i).value=b.gain;$('q'+i).value=b.q;$('denoise'+i).value=b.denoise??0;$('attack'+i).value=b.attack??0;$('sustain'+i).value=b.sustain??0}updateOut();syncEQ();syncDenoise();syncTransient()}
async function loadFile(file){try{if(!file)return;if(!file.type.startsWith('audio/')&&!/\.(wav|wave|aif|aiff|mp3|flac|m4a|ogg)$/i.test(file.name))throw new Error('請選擇音訊檔案。');if(!ctx)ctx=new AudioContext();const data=await file.arrayBuffer();buffer=await ctx.decodeAudioData(data.slice(0));playOffset=0;drawWaveform();setCursor(0);$('status').textContent=`已載入：${file.name}｜${buffer.numberOfChannels} ch｜${buffer.sampleRate} Hz｜${buffer.duration.toFixed(2)} s｜可以按播放`}catch(e){buffer=null;$('status').textContent='音檔載入失敗：'+(e?.message||e);console.error(e)}}
async function start(){if(!buffer){$('status').textContent='請先載入 WAV / AIFF。';return}try{if(!ctx)ctx=new AudioContext();await ensureGraph();for(const s of stages)routeTransient(s);await ctx.resume();if(ctx.state!=='running')throw new Error('AudioContext 狀態：'+ctx.state);syncEQ();syncDenoise();syncTransient();if(source){try{source.stop()}catch{}try{source.disconnect()}catch{}source=null}source=ctx.createBufferSource();source.buffer=buffer;connectPlaybackChain();playStartTime=ctx.currentTime;source.onended=()=>{playing=false;source=null;playOffset=buffer.duration;setCursor(1);cancelAnimationFrame(rafId);if($('status').textContent.startsWith('播放中'))$('status').textContent='播放結束'};source.start(0,Math.max(0,Math.min(playOffset,buffer.duration)));playing=true;$('status').textContent='播放中｜4 Band EQ + 每 Band De-noise + 每 Band Transient';updateCursor()}catch(e){playing=false;$('status').textContent='播放失敗：'+(e?.message||e);console.error(e)}}
function stop(){if(source){try{source.stop()}catch{}try{source.disconnect()}catch{}source=null}if(playing)playOffset=Math.min(buffer?.duration||0,Math.max(0,ctx.currentTime-playStartTime+playOffset));playing=false;cancelAnimationFrame(rafId);$('status').textContent='已停止';setCursor(buffer&&buffer.duration?playOffset/buffer.duration:0)}
function seekByRatio(r){if(!buffer)return;const t=Math.max(0,Math.min(1,r))*buffer.duration;if(playing)stop();playOffset=t;setCursor(r)}
function setCursor(r){const c=$('wave');if(!c)return;const x=Math.max(0,Math.min(1,r))*c.clientWidth;$('cursor').style.left=`${x}px`;$('time').textContent=buffer?`${(Math.max(0,Math.min(1,r))*buffer.duration).toFixed(2)} / ${buffer.duration.toFixed(2)} s`:'0.00 / 0.00 s'}
function updateCursor(){if(!playing||!ctx||!buffer)return;const elapsed=ctx.currentTime-playStartTime;const pos=Math.min(1,(playOffset+elapsed)/buffer.duration);setCursor(pos);rafId=requestAnimationFrame(updateCursor)}
function drawWaveform(){const c=$('wave'),wrap=$('waveWrap');if(!c||!buffer)return;const w=Math.max(600,Math.floor(wrap.clientWidth*2)),h=180;c.width=w;c.height=h;const g=c.getContext('2d');g.clearRect(0,0,w,h);const ch=buffer.getChannelData(0),step=Math.max(1,Math.floor(ch.length/w));g.beginPath();for(let x=0;x<w;x++){let min=1,max=-1;const start=x*step,end=Math.min(ch.length,start+step);for(let i=start;i<end;i++){const v=ch[i];if(v<min)min=v;if(v>max)max=v}g.moveTo(x,h/2+min*h*.45);g.lineTo(x,h/2+max*h*.45)}g.strokeStyle='#7fa7d9';g.lineWidth=1;g.stroke();g.beginPath();g.moveTo(0,h/2);g.lineTo(w,h/2);g.strokeStyle='#444';g.stroke()}
function setupDrop(){const drop=$('drop'),file=$('file'),choose=$('choose');choose.onclick=e=>{e.preventDefault();file.click()};file.onchange=e=>{const f=e.target.files?.[0];if(f)loadFile(f)};['dragenter','dragover'].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();e.stopPropagation();drop.classList.add('drag');e.dataTransfer.dropEffect='copy'}));['dragleave','dragend'].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();e.stopPropagation();drop.classList.remove('drag')}));drop.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();drop.classList.remove('drag');const f=e.dataTransfer?.files?.[0];if(f)loadFile(f)});const wave=$('waveWrap');wave.addEventListener('click',e=>{const r=e.offsetX/wave.clientWidth;seekByRatio(r)});window.addEventListener('resize',()=>drawWaveform())}
for(let i=1;i<=4;i++)['freq','gain','q','denoise','attack','sustain'].forEach(p=>$(p+i).addEventListener('input',()=>{updateOut();saveCurrent();syncEQ();syncDenoise();syncTransient()}));
$('play').onclick=start;$('stop').onclick=stop;$('bypass').onclick=()=>{bypass=!bypass;$('bypass').textContent=`Bypass：${bypass?'ON':'OFF'}`;if(source)connectPlaybackChain()};$('ab').onclick=()=>{$('ab').textContent=$('ab').textContent.endsWith('A')?'A/B：B':'A/B：A';loadSlot()};updateOut();

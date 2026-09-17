(()=> {
'use strict';

const bands=4;
const colors=['#2d5fff','#ef3a3a','#37c832','#ff7118'];
const ranges=[[20,300],[60,1200],[200,3000],[1000,25000]];
const DEFAULT_FREQ=[31.5,125,1000,8000];
const $=id=>document.getElementById(id);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const graph=$('uiGraph'), wrap=$('graphWrap'), layer=$('nodeLayer'), ctx2d=graph?.getContext('2d');
const state={undo:[],redo:[],clip:null,selected:0,seed:17,drag:null,outputDb:0};
const OUTPUT_MIN=-24, OUTPUT_MAX=24, OUTPUT_STEP=.1;
const nativeConnect=window.AudioNode?.prototype?.connect;
const outputGains=new Map();

function data(){
  return window.myEFX?.currentData
    ? window.myEFX.currentData()
    : ranges.map((r,i)=>({freq:DEFAULT_FREQ[i],gain:0,q:1,denoise:0,punch:0,sustain:0,bypass:false,solo:false}));
}
function fmtFreq(v){return v>=1000?(v/1000).toFixed(v>=10000?1:2)+' kHz':(v%1?v.toFixed(1):v.toFixed(0))+' Hz'}
function setInput(id,v){
  const el=$(id); if(!el)return;
  el.value=String(v);
  el.dispatchEvent(new Event('input',{bubbles:true}));
}
function snap(){return JSON.stringify(data())}
function setButton(id,on){
  const b=$(id); if(!b)return;
  const isSolo=id.startsWith('solo');
  const active=isSolo?b.classList.contains('active'):b.classList.contains('on');
  if(active!==on)b.click?.();
}
function restore(s){
  const a=JSON.parse(s);
  a.forEach((b,i)=>{
    for(const k of ['freq','gain','q','denoise','punch','sustain'])setInput(k+(i+1),b[k]);
    setButton('byp'+(i+1),!b.bypass);
    setButton('solo'+(i+1),!!b.solo);
  });
  draw();
}
function pushUndo(){
  const s=snap();
  if(state.undo[state.undo.length-1]!==s)state.undo.push(s);
  if(state.undo.length>80)state.undo.shift();
  state.redo=[];
}
function undo(){if(state.undo.length<2)return;const cur=state.undo.pop();state.redo.push(cur);restore(state.undo[state.undo.length-1])}
function redo(){if(!state.redo.length)return;const s=state.redo.pop();state.undo.push(s);restore(s)}

function injectFixCss(){
  if($('myEFX-fix-css'))return;
  const s=document.createElement('style');
  s.id='myEFX-fix-css';
  s.textContent=`
    .band-head .micro{width:42px;min-width:42px;max-width:42px;height:24px;padding:0 2px;font-size:9px;line-height:22px;letter-spacing:-.2px;overflow:hidden;white-space:nowrap;text-overflow:clip;box-sizing:border-box}
    .band-head .micro.active{width:42px;min-width:42px}
    .node{touch-action:none;user-select:none}
    .node.dragging{cursor:grabbing}
    .out-knob{touch-action:none}
  `;
  document.head.appendChild(s);
}

function patchOutputRouting(){
  if(!nativeConnect || patchOutputRouting.done)return;
  patchOutputRouting.done=true;
  AudioNode.prototype.connect=function(destination,...args){
    if(destination && this.context && destination===this.context.destination){
      let g=outputGains.get(this.context);
      if(!g){
        g=this.context.createGain();
        g.gain.value=Math.pow(10,state.outputDb/20);
        outputGains.set(this.context,g);
      }
      nativeConnect.call(this,g);
      nativeConnect.call(g,destination,...args);
      updateOutputVisual();
      return destination;
    }
    return nativeConnect.call(this,destination,...args);
  };
}
function setOutputDb(v,show=true){
  const n=Number(v);
  state.outputDb=Number.isFinite(n)?Math.round(clamp(n,OUTPUT_MIN,OUTPUT_MAX)/OUTPUT_STEP)*OUTPUT_STEP:0;
  state.outputDb=Number(state.outputDb.toFixed(1));
  for(const [ctx,g] of outputGainsEntries())g.gain.setValueAtTime(Math.pow(10,state.outputDb/20),ctx.currentTime);
  updateOutputVisual(show);
}
function outputGainsEntries(){return outputGains.entries()}
function updateOutputVisual(){
  const knob=document.querySelector('.out-knob');
  if(!knob)return;
  const p=(-135+270*(state.outputDb-OUTPUT_MIN)/(OUTPUT_MAX-OUTPUT_MIN));
  const ptr=knob.querySelector('.knob-pointer');
  if(ptr)ptr.style.transform=`translateX(-50%) rotate(${p}deg)`;
  const out=document.querySelector('.out-readout');
  if(out)out.textContent=state.outputDb.toFixed(1)+' dB';
}
function bindOutputKnob(){
  const knob=document.querySelector('.out-knob');
  if(!knob)return;
  injectFixCss();
  let sy=0,sv=state.outputDb,active=false;
  const commit=()=>{if(active){active=false;knob.classList.remove('active');updateOutputVisual()}};
  knob.setAttribute('tabindex','0');
  knob.setAttribute('role','slider');
  knob.setAttribute('aria-label','Output');
  const setFromPointer=e=>{
    const v=clamp(sv+(sy-e.clientY)*(OUTPUT_MAX-OUTPUT_MIN)/240,OUTPUT_MIN,OUTPUT_MAX);
    setOutputDb(v,true);
  };
  knob.addEventListener('pointerdown',e=>{
    e.preventDefault();
    active=true;sy=e.clientY;sv=state.outputDb;knob.classList.add('active');
    knob.setPointerCapture?.(e.pointerId);
    updateOutputVisual();
  });
  knob.addEventListener('pointermove',e=>{if(active){setFromPointer(e);}});
  knob.addEventListener('pointerup',commit);
  knob.addEventListener('pointercancel',commit);
  knob.addEventListener('wheel',e=>{
    e.preventDefault();
    setOutputDb(state.outputDb-(e.deltaY>0?OUTPUT_STEP:-OUTPUT_STEP),true);
  },{passive:false});
  knob.addEventListener('keydown',e=>{
    if(e.key==='ArrowUp'||e.key==='ArrowRight'){e.preventDefault();setOutputDb(state.outputDb+OUTPUT_STEP,true)}
    if(e.key==='ArrowDown'||e.key==='ArrowLeft'){e.preventDefault();setOutputDb(state.outputDb-OUTPUT_STEP,true)}
    if(e.key==='Home'){e.preventDefault();setOutputDb(0,true)}
  });
  updateOutputVisual();
}

function graphSize(){
  const r=graph.getBoundingClientRect(),d=Math.min(2,devicePixelRatio||1);
  graph.width=Math.max(1,Math.floor(r.width*d));graph.height=Math.max(1,Math.floor(r.height*d));
  ctx2d.setTransform(d,0,0,d,0,0);
  return{w:r.width,h:r.height};
}
function xForFreq(f,w){
  const a=Math.log10(20),b=Math.log10(20000);
  return (Math.log10(clamp(f,20,20000))-a)/(b-a)*w;
}
function freqForX(x,w){
  const a=Math.log10(20),b=Math.log10(20000);
  return Math.pow(10,a+(b-a)*clamp(x/w,0,1));
}
function yForGain(g,h){return h*.5-(clamp(g,-12,12)/24)*h*.88}
function gainForY(y,h){return clamp((h*.5-y)/(h*.88)*24,-12,12)}
function curveGain(hz,b){
  if(b.bypass)return 0;
  const q=Math.max(.1,b.q||1),oct=Math.log2(hz/(b.freq||1)),sigma=1/Math.sqrt(q)*.85;
  return (b.gain||0)*Math.exp(-(oct*oct)/(2*sigma*sigma));
}
function drawGrid(w,h){
  ctx2d.clearRect(0,0,w,h);ctx2d.fillStyle='#34444b';ctx2d.fillRect(0,0,w,h);
  ctx2d.lineWidth=1;ctx2d.font='11px Arial';
  [20,40,80,160,320,640,1280,2560,5120,10240,20000].forEach(f=>{
    const x=xForFreq(f,w);ctx2d.strokeStyle='#c5d0d433';ctx2d.beginPath();ctx2d.moveTo(x,0);ctx2d.lineTo(x,h);ctx2d.stroke();
  });
  [-12,-6,0,6,12].forEach(g=>{
    const y=yForGain(g,h);ctx2d.strokeStyle=g===0?'#c6d2d666':'#c6d2d638';
    ctx2d.beginPath();ctx2d.moveTo(0,y);ctx2d.lineTo(w,y);ctx2d.stroke();
  });
}
function drawAnalyzer(w,h){
  const t=state.seed;
  for(let which=0;which<2;which++){
    ctx2d.strokeStyle=which?'#ef6760':'#a9ef28';ctx2d.globalAlpha=.8;ctx2d.lineWidth=.95;ctx2d.beginPath();
    for(let x=0;x<w;x+=2){
      const n=(Math.sin(x*.043+t+which)+Math.sin(x*.013+t*.31)+Math.sin(x*.09+t*.17)*.35)/3;
      const g=n*2.8+(1-x/w)*1.8+(which?-0.2:0),y=yForGain(g,h);
      if(x===0)ctx2d.moveTo(x,y);else ctx2d.lineTo(x,y);
    }
    ctx2d.stroke();
  }
  ctx2d.globalAlpha=1;
}
function draw(){
  if(!graph||!layer||!ctx2d)return;
  const {w,h}=graphSize();drawGrid(w,h);drawAnalyzer(w,h);const bs=data();
  for(let i=0;i<bands;i++){ctx2d.strokeStyle=colors[i];ctx2d.lineWidth=1.35;ctx2d.beginPath();
    for(let x=0;x<w;x+=2){const hz=freqForX(x,w),y=yForGain(curveGain(hz,bs[i]),h);if(x===0)ctx2d.moveTo(x,y);else ctx2d.lineTo(x,y)}ctx2d.stroke();
  }
  ctx2d.strokeStyle='#e5e9ea';ctx2d.lineWidth=1.4;ctx2d.beginPath();
  for(let x=0;x<w;x+=2){let g=0;const hz=freqForX(x,w);for(const b of bs)g+=curveGain(hz,b);const y=yForGain(g,h);if(x===0)ctx2d.moveTo(x,y);else ctx2d.lineTo(x,y)}
  ctx2d.stroke();
  layer.innerHTML='';
  bs.forEach((b,i)=>{
    const n=document.createElement('div');
    n.className='node n'+(i+1)+(state.selected===i?' selected':'');
    n.dataset.index=i;
    n.style.left=xForFreq(b.freq,w)+'px';n.style.top=yForGain(b.gain,h)+'px';
    n.title=`${fmtFreq(b.freq)} / ${b.gain.toFixed(1)} dB`;
    n.addEventListener('pointerdown',e=>startDrag(e,i,n));
    layer.appendChild(n);
  });
}
function startDrag(e,i,node){
  e.preventDefault();e.stopPropagation();state.selected=i;
  const r=graph.getBoundingClientRect();
  state.drag={i,rect:r,pointerId:e.pointerId,node};
  node.classList.add('dragging');node.setPointerCapture?.(e.pointerId);
}
function moveDrag(e){
  const d=state.drag;if(!d||e.pointerId!==d.pointerId)return;
  const {i,rect}=d,x=e.clientX-rect.left,y=e.clientY-rect.top;
  const freq=clamp(freqForX(x,rect.width),ranges[i][0],ranges[i][1]);
  const gain=gainForY(y,rect.height);
  setInput('freq'+(i+1),Number(freq.toFixed(1)));
  setInput('gain'+(i+1),Number(gain.toFixed(1)));
  draw();e.preventDefault();
}
function endDrag(){
  if(!state.drag)return;
  const node=state.drag.node;state.drag=null;node?.classList.remove('dragging');pushUndo();draw();
}
function connectUI(){
  injectFixCss();
  patchOutputRouting();
  bindOutputKnob();
  if(graph){
    graph.addEventListener('pointermove',moveDrag);
    graph.addEventListener('pointerup',endDrag);
  }
  window.addEventListener('pointermove',moveDrag,{passive:false});
  window.addEventListener('pointerup',endDrag);
  window.addEventListener('resize',draw);
  document.querySelectorAll('.band-head .micro[data-action="solo"]').forEach(b=>{
    const fix=()=>{if(b.classList.contains('active'))b.textContent='SOLO';else b.textContent='S';};
    fix();
    b.addEventListener('click',()=>requestAnimationFrame(fix));
  });
  document.querySelectorAll('.band-head .micro[data-action="bypass"]').forEach(b=>{
    b.title='BYPASS';b.textContent='A';
  });
  document.querySelectorAll('.band select[data-filter]').forEach(s=>s.addEventListener('change',()=>{pushUndo();draw()}));
  const cp=$('copy'),ps=$('paste'),un=$('undo'),re=$('redo'),un2=$('undo2'),re2=$('redo2');
  if(cp)cp.onclick=()=>{state.clip=JSON.stringify(data())};
  if(ps)ps.onclick=()=>{if(state.clip){pushUndo();restore(state.clip)}};
  if(un)un.onclick=undo;if(re)re.onclick=redo;if(un2)un2.onclick=undo;if(re2)re2.onclick=redo;
  const ab=$('ab');if(ab)ab.onclick=()=>{ab.dataset.flip=ab.dataset.flip==='1'?'0':'1'};
  const link=$('linkBtn');if(link)link.onclick=()=>document.body.classList.toggle('reference-mode');
  const view=$('viewMode');if(view)view.onchange=draw;
  document.querySelectorAll('[data-action="delta"]').forEach((b,i)=>b.addEventListener('click',()=>{state.selected=i;draw()}));
  if($('file'))$('file').addEventListener('change',()=>wrap?.classList.remove('empty'));
  if($('graphWrap')){
    $('graphWrap').addEventListener('dragover',e=>{e.preventDefault();wrap.classList.add('dragover')});
    $('graphWrap').addEventListener('dragleave',()=>wrap.classList.remove('dragover'));
    $('graphWrap').addEventListener('drop',e=>{
      e.preventDefault();wrap.classList.remove('dragover');
      const f=e.dataTransfer?.files?.[0],input=$('file');
      if(f&&input){const dt=new DataTransfer();dt.items.add(f);input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))}
    });
  }
  document.addEventListener('keydown',e=>{
    if(e.ctrlKey&&e.key.toLowerCase()==='z'){e.preventDefault();undo()}
    if(e.ctrlKey&&e.key.toLowerCase()==='y'){e.preventDefault();redo()}
    if(e.key==='Escape'){state.drag=null;draw()}
  });
  pushUndo();draw();
  if(!window.__UI_TEST__)setInterval(()=>{state.seed+=.07;draw()},150);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',connectUI,{once:true});else connectUI();
window.myEFXUI={draw,copy:()=>{state.clip=JSON.stringify(data())},paste:()=>{if(state.clip)restore(state.clip)},undo,redo,setOutputDb};
window.myEFXOutput={get db(){return state.outputDb},set db(v){setOutputDb(v,true)}};
})();
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(root, 'app-final.js');
let src = fs.readFileSync(file, 'utf8');

const replacement = String.raw`  // DENOISE_REWRITE_V6: strictly subtractive adaptive multiband denoise.
  // DE-NOISE itself NEVER adds makeup/protection gain and NEVER multiplies above 1.
  // The internal subbands are analysis filters only. Their gains are averaged in dB
  // as attenuation factors, then applied to the Section's already band-limited signal.
  // Existing EQ / PUNCH / SUSTAIN / DELTA routing remains outside this DSP stage.
  function makeStage(){
    const c=ensureCtx(),band=c.createBiquadFilter(),eq=c.createBiquadFilter(),dry=c.createGain(),neg=c.createGain(),change=c.createGain(),normal=c.createGain(),deltaGate=c.createGain(),proc=c.createScriptProcessor(512,2,2);
    band.type='bandpass';eq.type='peaking';neg.gain.value=-1;
    const K=6,OFF=[-1.35,-.85,-.35,.35,.85,1.35];
    const mk=()=>({b0:0,b1:0,b2:0,a1:0,a2:0,tb0:0,tb1:0,tb2:0,ta1:0,ta2:0,z1:[0,0],z2:[0,0],power:1e-8,noise:1e-8,gain:1,target:1,valid:false});
    const state={settings:DEFAULTS[0],bands:Array.from({length:K},mk),lastFreq:0,lastQ:0,fast:0,slow:0,warm:0};
    function coeff(s,fc,Q,fs){
      const w=2*Math.PI*fc/fs,sn=Math.sin(w),cs=Math.cos(w),alpha=sn/(2*Math.max(.55,Q));
      const a0=1+alpha,b0=alpha,b1=0,b2=-alpha,a1=-2*cs,a2=1-alpha;
      s.tb0=b0/a0;s.tb1=b1/a0;s.tb2=b2/a0;s.ta1=a1/a0;s.ta2=a2/a0;s.valid=fc>12&&fc<fs*.45;
    }
    function configure(b){
      const fs=c.sampleRate||44100,f=clamp(+b.freq||1000,20,fs*.43),q=clamp(+b.q||1,.25,18);
      if(state.lastFreq===f&&state.lastQ===q)return;
      state.lastFreq=f;state.lastQ=q;
      const spread=clamp(2.2/Math.max(.7,q),.65,2.0);
      for(let k=0;k<K;k++){
        const s=state.bands[k],fc=clamp(f*Math.pow(2,OFF[k]*spread),20,fs*.43);
        coeff(s,fc,1.0,fs);
        if(!Number.isFinite(s.b0)){s.b0=s.tb0;s.b1=s.tb1;s.b2=s.tb2;s.a1=s.ta1;s.a2=s.ta2}
      }
      state.warm=256;
    }
    function filt(s,x,ch){
      s.b0+=(s.tb0-s.b0)*.12;s.b1+=(s.tb1-s.b1)*.12;s.b2+=(s.tb2-s.b2)*.12;s.a1+=(s.ta1-s.a1)*.12;s.a2+=(s.ta2-s.a2)*.12;
      const y=s.b0*x+s.z1[ch];s.z1[ch]=s.b1*x-s.a1*y+s.z2[ch];s.z2[ch]=s.b2*x-s.a2*y;return y;
    }
    proc.onaudioprocess=e=>{
      const inp=e.inputBuffer,out=e.outputBuffer,s=state,b=s.settings||DEFAULTS[0],frames=out.length,ch=Math.min(inp.numberOfChannels,out.numberOfChannels),amount=clamp(+b.denoise||0,0,100)/100;
      configure(b);
      const ins=[],outs=[];for(let cc=0;cc<ch;cc++){ins[cc]=inp.getChannelData(cc);outs[cc]=out.getChannelData(cc)}
      if(amount<=1e-5){for(let cc=0;cc<ch;cc++)outs[cc].set(ins[cc]);return}
      const floor=Math.pow(10,-24*amount/20);
      for(let i=0;i<frames;i++){
        let peak=0;for(let cc=0;cc<ch;cc++)peak=Math.max(peak,Math.abs(ins[cc][i]));
        s.fast+=(peak-s.fast)*.24;s.slow+=(peak-s.slow)*.012;
        let logG=0,valid=0;
        for(let k=0;k<K;k++){
          const bs=s.bands[k];if(!bs.valid)continue;
          let p=0;for(let cc=0;cc<ch;cc++){const y=filt(bs,ins[cc][i],cc);p+=y*y}p/=Math.max(1,ch);
          const wasQuiet=p<bs.power;
          bs.power+=(p-bs.power)*(wasQuiet?.18:.035);bs.power=Math.max(bs.power,1e-10);
          const speechActivity=clamp((s.fast-s.slow)/Math.max(s.fast,1e-7),0,1);
          if(p<bs.noise*1.35)bs.noise+=(p-bs.noise)*.045;
          else if(speechActivity<.08)bs.noise+=(Math.min(p,bs.noise*1.05)-bs.noise)*.012;
          bs.noise=clamp(bs.noise,1e-10,Math.max(bs.power,1e-10));
          const snr=bs.power/(bs.noise+1e-10);
          const w=clamp((snr-1.0)/(snr+1.5),0,1);
          const adaptive=Math.pow(w,1.35);
          const target=clamp(1-amount*(1-adaptive),floor,1);
          bs.target=target;
          bs.gain+=(target-bs.gain)*(target<bs.gain?.16:.045);
          bs.gain=clamp(bs.gain,floor,1);
          logG+=Math.log(Math.max(bs.gain,1e-6));valid++;
        }
        // STRICTLY SUBTRACTIVE: no protection, makeup, normalization, or upward gain.
        let g=valid?Math.exp(logG/valid):1;
        g=clamp(g,floor,1);
        if(s.warm>0){g=1;s.warm--}
        for(let cc=0;cc<ch;cc++)outs[cc][i]=ins[cc][i]*g;
      }
      for(let cc=ch;cc<out.numberOfChannels;cc++)out.getChannelData(cc).fill(0);
    };
    return{band,eq,dry,neg,change,normal,deltaGate,proc,state}
  }
  function buildGraph(){`;

const re=/  function makeStage\(\)\{[\s\S]*?\n  function buildGraph\(\)\{/;
if(!re.test(src))throw new Error('makeStage/buildGraph anchor not found');
src=src.replace(re,replacement);

const interactionPatch = String.raw`
/* MYEFX_INTERACTION_PATCH_V2: Shift = fine movement; node wheel = Q. */
(()=>{
  const clampLocal=(x,a,b)=>Math.max(a,Math.min(b,x));
  const rangesLocal=[[20,300],[60,1200],[200,3000],[1000,25000]];
  const state={drag:null};
  const isKnobInput=t=>t?.closest?.('.knob[data-target]');
  const isNode=t=>t?.closest?.('.node');
  const inputOf=id=>document.getElementById(id);
  function dispatchInput(el){el.dispatchEvent(new Event('input',{bubbles:true}))}
  function norm(input,v){
    const min=Number(input.min),max=Number(input.max),step=Number(input.step)||1;
    const n=Math.round(clampLocal(v,min,max)/step)*step;
    const d=(String(step).split('.')[1]||'').length;
    return Number(n.toFixed(d));
  }
  function xForFreqLocal(f,w){const a=Math.log10(20),b=Math.log10(20000);return (Math.log10(clampLocal(f,20,20000))-a)/(b-a)*w}
  function freqForFineX(x,w){const a=Math.log10(20),b=Math.log10(20000);return Math.pow(10,a+(b-a)*clampLocal(x/w,0,1))}
  function yForGainLocal(g,h){return h*.5-(clampLocal(g,-12,12)/24)*h*.88}

  document.addEventListener('wheel',e=>{
    const node=isNode(e.target);
    if(!node)return;
    const i=Number(node.dataset.index);
    if(!Number.isInteger(i))return;
    const input=inputOf('q'+(i+1));
    if(!input)return;
    e.preventDefault();e.stopImmediatePropagation();
    const step=Number(input.step)||.01;
    input.value=String(norm(input,Number(input.value)+(e.deltaY<0?step:-step)));
    dispatchInput(input);
  },{capture:true,passive:false});

  document.addEventListener('pointerdown',e=>{
    if(!e.shiftKey)return;
    const node=isNode(e.target);
    if(node){
      const i=Number(node.dataset.index),graph=document.getElementById('uiGraph');
      if(!graph||!Number.isInteger(i))return;
      const freqInput=inputOf('freq'+(i+1)),gainInput=inputOf('gain'+(i+1));
      if(!freqInput||!gainInput)return;
      const rect=graph.getBoundingClientRect(),freq=Number(freqInput.value),gain=Number(gainInput.value);
      state.drag={kind:'node',i,pointerId:e.pointerId,rect,startX:xForFreqLocal(freq,rect.width),startY:yForGainLocal(gain,rect.height),startFreq:freq,startGain:gain,node};
      e.preventDefault();e.stopImmediatePropagation();
      node.classList.add('dragging');node.setPointerCapture?.(e.pointerId);
      return;
    }
    const knob=isKnobInput(e.target);
    if(knob){
      const id=knob.dataset.target,input=inputOf(id),rect=knob.getBoundingClientRect();
      if(!input)return;
      state.drag={kind:'knob',pointerId:e.pointerId,input,startY:e.clientY,startValue:Number(input.value),min:Number(input.min),max:Number(input.max),step:Number(input.step)||1};
      e.preventDefault();e.stopImmediatePropagation();
      knob.classList.add('active');knob.setPointerCapture?.(e.pointerId);
    }
  },{capture:true});

  document.addEventListener('pointermove',e=>{
    const d=state.drag;
    if(!d||d.pointerId!==e.pointerId)return;
    if(d.kind==='node'){
      const dx=(e.clientX-d.rect.left-d.startX)*.2;
      const dy=(e.clientY-d.rect.top-d.startY)*.2;
      const x=d.startX+dx;
      const y=d.startY+dy;
      const freq=clampLocal(freqForFineX(x,d.rect.width),rangesLocal[d.i][0],rangesLocal[d.i][1]);
      const gain=clampLocal((d.rect.height*.5-y)/(d.rect.height*.88)*24,-12,12);
      const fi=inputOf('freq'+(d.i+1)),gi=inputOf('gain'+(d.i+1));
      if(fi){fi.value=String(Number(freq.toFixed(1)));dispatchInput(fi)}
      if(gi){gi.value=String(Number(gain.toFixed(1)));dispatchInput(gi)}
    }else if(d.kind==='knob'){
      const amount=(d.startY-e.clientY)*(d.max-d.min)/240*.2;
      d.input.value=String(norm(d.input,d.startValue+amount));
      dispatchInput(d.input);
    }
    e.preventDefault();e.stopImmediatePropagation();
  },{capture:true,passive:false});

  document.addEventListener('pointerup',e=>{
    const d=state.drag;
    if(!d||d.pointerId!==e.pointerId)return;
    state.drag=null;
    d.node?.classList.remove('dragging');
    const knob=d.kind==='knob'?d.input.closest('.knob[data-target]'):null;
    knob?.classList.remove('active');
    e.preventDefault();e.stopImmediatePropagation();
  },{capture:true,passive:false});
  document.addEventListener('pointercancel',e=>{
    if(state.drag?.pointerId===e.pointerId){state.drag=null;e.stopImmediatePropagation()}
  },{capture:true});
})();
`;

src += '\n' + interactionPatch;
fs.writeFileSync(file,src,'utf8');
console.log('Embedded DE-NOISE V6 + interaction patch into app-final.js');

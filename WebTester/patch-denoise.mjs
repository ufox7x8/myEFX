import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(root, 'app-final.js');
let src = fs.readFileSync(file, 'utf8');

if (src.includes('DENOISE_REWRITE_V4')) {
  console.log('DE-NOISE V4 already embedded');
  process.exit(0);
}

const replacement = String.raw`  // DENOISE_REWRITE_V4: lightweight multiband Wiener-style voice denoiser.
  // Only this stage's denoise path is replaced. EQ / transient / routing remain unchanged.
  function makeStage(){
    const c=ensureCtx(),band=c.createBiquadFilter(),eq=c.createBiquadFilter(),dry=c.createGain(),neg=c.createGain(),change=c.createGain(),normal=c.createGain(),deltaGate=c.createGain(),proc=c.createScriptProcessor(512,2,2);
    band.type='bandpass';eq.type='peaking';neg.gain.value=-1;
    const K=6,OFF=[-1.25,-.75,-.25,.25,.75,1.25];
    const mkBand=()=>({freq:0,b0:0,b1:0,b2:0,a1:0,a2:0,targetB0:0,targetB1:0,targetB2:0,targetA1:0,targetA2:0,z1:[0,0],z2:[0,0],targetGain:1,gain:1,noise:1e-7,power:1e-7,valid:false});
    const state={settings:DEFAULTS[0],bands:Array.from({length:K},mkBand),lastFreq:0,lastQ:0,warm:0,dFast:0,dSlow:0,tFast:0,tSlow:0,bandL:[0,0,0,0,0,0],bandR:[0,0,0,0,0,0]};
    function setCoeff(s,fc,Q,fs){
      const w=2*Math.PI*fc/fs,sn=Math.sin(w),cs=Math.cos(w),alpha=sn/(2*Math.max(.7,Q));
      const a0=1+alpha,b0=alpha,b1=0,b2=-alpha,a1=-2*cs,a2=1-alpha;
      s.targetB0=b0/a0;s.targetB1=b1/a0;s.targetB2=b2/a0;s.targetA1=a1/a0;s.targetA2=a2/a0;s.valid=fc>5&&fc<fs*.47;
    }
    function configure(b){
      const fs=c.sampleRate||44100,f=Math.max(20,+b.freq||1000),q=Math.max(.1,+b.q||1);
      if(state.lastFreq===f&&state.lastQ===q)return;
      state.lastFreq=f;state.lastQ=q;
      const span=Math.max(.8,Math.min(2.5,2.4/Math.max(.7,q)));
      for(let k=0;k<K;k++){
        const s=state.bands[k],fc=clamp(f*Math.pow(2,OFF[k]*span*.5),20,fs*.46);
        setCoeff(s,fc,1.05,fs);
        if(!Number.isFinite(s.b0))s.b0=s.targetB0;if(!Number.isFinite(s.b1))s.b1=s.targetB1;if(!Number.isFinite(s.b2))s.b2=s.targetB2;if(!Number.isFinite(s.a1))s.a1=s.targetA1;if(!Number.isFinite(s.a2))s.a2=s.targetA2;
      }
      state.warm=192;
    }
    function filterSample(s,x,ch){
      s.b0+=(s.targetB0-s.b0)*.08;s.b1+=(s.targetB1-s.b1)*.08;s.b2+=(s.targetB2-s.b2)*.08;s.a1+=(s.targetA1-s.a1)*.08;s.a2+=(s.targetA2-s.a2)*.08;
      const y=s.b0*x+s.z1[ch];s.z1[ch]=s.b1*x-s.a1*y+s.z2[ch];s.z2[ch]=s.b2*x-s.a2*y;return y;
    }
    proc.onaudioprocess=e=>{
      const inp=e.inputBuffer,out=e.outputBuffer,s=state,b=s.settings||DEFAULTS[0],frames=out.length,ch=Math.min(inp.numberOfChannels,out.numberOfChannels),amount=clamp(+b.denoise||0,0,100)/100,punch=(+b.punch||0)/100,sustain=(+b.sustain||0)/100;
      configure(b);
      const inCh=[];const outCh=[];for(let cc=0;cc<ch;cc++){inCh[cc]=inp.getChannelData(cc);outCh[cc]=out.getChannelData(cc)}
      for(let i=0;i<frames;i++){
        let peak=0;for(let cc=0;cc<ch;cc++)peak=Math.max(peak,Math.abs(inCh[cc][i]));
        let denPeak=peak;
        if(amount<=.0001){for(let cc=0;cc<ch;cc++)outCh[cc][i]=inCh[cc][i];}
        else{
          for(let k=0;k<K;k++){
            const bs=s.bands[k];if(!bs.valid){bs.targetGain=1;continue}
            let p=0;
            for(let cc=0;cc<ch;cc++){const y=filterSample(bs,inCh[cc][i],cc);if(cc===0?s.bandL[k]!==y:s.bandR[k]!==y){}if(cc===0)s.bandL[k]=y;else s.bandR[k]=y;p+=y*y}
            p/=Math.max(1,ch);bs.power+=(p-bs.power)*(p<bs.power?.22:.035);bs.power=Math.max(bs.power,1e-10);
            bs.noise+=(Math.min(p,bs.noise*1.12)-bs.noise)*(p<bs.noise?.075:.0018);bs.noise=Math.max(bs.noise,1e-9);
            const snr=p/(bs.noise+1e-9),wiener=clamp((snr-.55)/(snr+.35),0,1),floor=Math.pow(10,-18*amount/20),raw=1-amount*(1-wiener)*.92;
            bs.targetGain=clamp(raw,floor,1);bs.gain+=(bs.targetGain-bs.gain)*(bs.targetGain<bs.gain?.20:.055);
          }
          s.dFast+=(peak-s.dFast)*.25;s.dSlow+=(peak-s.dSlow)*.018;
          const voice=clamp((s.dFast-s.dSlow)/Math.max(s.dFast,1e-6)*3.5,0,1),voiceProtect=.55*voice;
          for(let cc=0;cc<ch;cc++){
            let y=inCh[cc][i];
            for(let k=0;k<K;k++){const bs=s.bands[k];if(!bs.valid)continue;const rawBand=cc===0?s.bandL[k]:s.bandR[k],g=1-(1-bs.gain)*(1-voiceProtect);y+=rawBand*(g-1)*.78}
            y=clamp(y,-1.2,1.2);outCh[cc][i]=y;denPeak=Math.max(denPeak,Math.abs(y));
          }
          if(s.warm>0){for(let cc=0;cc<ch;cc++)outCh[cc][i]=inCh[cc][i];denPeak=peak;s.warm--}
        }
        if(Math.abs(punch)>.0001||Math.abs(sustain)>.0001){
          const smp=denPeak;s.tFast+=(smp-s.tFast)*.28;s.tSlow+=(smp-s.tSlow)*.018;
          const tr=clamp((s.tFast-s.tSlow)/Math.max(s.tFast,1e-5),0,1),sr=clamp(s.tSlow/Math.max(s.tFast,1e-5),0,1),tg=clamp((1+punch*.85*tr)*(1+sustain*.45*sr),.05,2.25);
          for(let cc=0;cc<ch;cc++)outCh[cc][i]*=tg;
        }
      }
      for(let cc=ch;cc<out.numberOfChannels;cc++)out.getChannelData(cc).fill(0);
    };
    return{band,eq,dry,neg,change,normal,deltaGate,proc,state}
  }
  function buildGraph(){`;

const re=/  function makeStage\(\)\{[\s\S]*?\n  function buildGraph\(\)\{/;
if(!re.test(src))throw new Error('makeStage/buildGraph anchor not found');
src=src.replace(re,replacement);
fs.writeFileSync(file,src,'utf8');
console.log('Embedded DE-NOISE V4 into app-final.js');
`;

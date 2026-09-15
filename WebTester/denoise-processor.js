class MyEFXDenoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(){
    return [
      {name:'amount',defaultValue:0,minValue:0,maxValue:100,automationRate:'k-rate'},
      {name:'threshold',defaultValue:1.5,minValue:-12,maxValue:12,automationRate:'k-rate'},
      {name:'reduction',defaultValue:30,minValue:0,maxValue:36,automationRate:'k-rate'},
      {name:'adaptation',defaultValue:1.0,minValue:0.1,maxValue:5,automationRate:'k-rate'},
      {name:'attack',defaultValue:8,minValue:1,maxValue:100,automationRate:'k-rate'},
      {name:'release',defaultValue:160,minValue:20,maxValue:800,automationRate:'k-rate'},
      {name:'smoothing',defaultValue:38,minValue:0,maxValue:100,automationRate:'k-rate'},
      {name:'transientProtect',defaultValue:72,minValue:0,maxValue:100,automationRate:'k-rate'},
      {name:'tonalProtect',defaultValue:12,minValue:0,maxValue:100,automationRate:'k-rate'},
      {name:'learn',defaultValue:0,minValue:0,maxValue:1,automationRate:'k-rate'}
    ];
  }
  constructor(){
    super();
    this.N=1024; this.H=512; this.bins=this.N/2+1;
    this.win=new Float32Array(this.N);
    this.re=new Float32Array(this.N); this.im=new Float32Array(this.N);
    this.mag=new Float32Array(this.bins); this.prevMag=new Float32Array(this.bins);
    this.noise=new Float32Array(this.bins); this.mask=new Float32Array(this.bins); this.prevMask=new Float32Array(this.bins);
    this.ringL=new Float32Array(this.N); this.ringR=new Float32Array(this.N); this.ringPos=0;
    this.sampleCount=0; this.frames=0;
    this.queueL=new Float32Array(32768); this.queueR=new Float32Array(32768); this.qRead=0; this.qWrite=0;
    this.noiseReady=false; this.learnFrames=0;
    for(let i=0;i<this.N;i++) this.win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(this.N-1));
  }
  fft(re,im,inverse=false){
    const n=this.N;
    for(let i=1,j=0;i<n;i++){
      let bit=n>>1; for(;j&bit;bit>>=1) j^=bit; j^=bit;
      if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}
    }
    for(let len=2;len<=n;len<<=1){
      const ang=(inverse?2:-2)*Math.PI/len, wr=Math.cos(ang),wi=Math.sin(ang);
      for(let i=0;i<n;i+=len){
        let ur=1,ui=0,half=len>>1;
        for(let j=0;j<half;j++){
          const a=i+j,b=a+half,vr=re[b]*ur-im[b]*ui,vi=re[b]*ui+im[b]*ur;
          re[b]=re[a]-vr;im[b]=im[a]-vi;re[a]+=vr;im[a]+=vi;
          const tr=ur*wr-ui*wi;ui=ur*wi+ui*wr;ur=tr;
        }
      }
    }
    if(inverse){for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}}
  }
  queuePush(L,R){
    for(let i=0;i<this.H;i++){
      const p=this.qWrite%this.queueL.length; this.queueL[p]=L[i]; this.queueR[p]=R[i]; this.qWrite++;
    }
  }
  queuePop(output,frames){
    for(let i=0;i<frames;i++){
      if(this.qRead<this.qWrite){const p=this.qRead%this.queueL.length;output[0][i]=this.queueL[p];if(output.length>1)output[1][i]=this.queueR[p];this.qRead++;}
      else {output[0][i]=0;if(output.length>1)output[1][i]=0;}
    }
    if(this.qWrite-this.qRead>this.queueL.length/2){this.qRead=0;this.qWrite=0;}
  }
  process(inputs,outputs,parameters){
    const input=inputs[0],output=outputs[0]; if(!input.length)return true;
    const frames=input[0].length,channels=input.length;
    const amount=(parameters.amount?.[0]??0)/100;
    const thresholdDb=parameters.threshold?.[0]??1.5;
    const maxReduction=Math.max(0,parameters.reduction?.[0]??30);
    const adaptation=Math.max(.1,parameters.adaptation?.[0]??1);
    const attackMs=Math.max(1,parameters.attack?.[0]??8);
    const releaseMs=Math.max(20,parameters.release?.[0]??160);
    const smooth=(parameters.smoothing?.[0]??38)/100;
    const transientProtect=(parameters.transientProtect?.[0]??72)/100;
    const tonalProtect=(parameters.tonalProtect?.[0]??12)/100;
    const learn=(parameters.learn?.[0]??0)>0.5;
    const aFast=Math.exp(-1/((adaptation*.35)*sampleRate));
    const aSlow=Math.exp(-1/((adaptation*1.7)*sampleRate));
    const atk=Math.exp(-1/((attackMs/1000)*sampleRate));
    const rel=Math.exp(-1/((releaseMs/1000)*sampleRate));
    const monoL=new Float32Array(this.N),monoR=new Float32Array(this.N);
    for(let i=0;i<frames;i++){
      const l=input[0][i],r=channels>1?input[1][i]:l;
      this.ringL[this.ringPos]=l;this.ringR[this.ringPos]=r;
      this.ringPos=(this.ringPos+1)%this.N;this.sampleCount++;
      if(this.sampleCount>=this.N && (this.sampleCount-this.N)%this.H===0){
        for(let n=0;n<this.N;n++){
          const idx=(this.ringPos+n)%this.N;
          monoL[n]=this.ringL[idx]*this.win[n];
          monoR[n]=this.ringR[idx]*this.win[n];
        }
        // Analyze summed stereo energy, then apply the same spectral decision to both channels.
        for(let n=0;n<this.N;n++){this.re[n]=(monoL[n]+monoR[n])*.5;this.im[n]=0;}
        this.fft(this.re,this.im,false);
        let flux=0,energy=1e-9;
        for(let k=0;k<this.bins;k++){
          const m=Math.hypot(this.re[k],this.im[k]);this.mag[k]=m;energy+=m;flux+=Math.max(0,m-this.prevMag[k]);
        }
        flux/=energy;
        const isTransient=flux>0.18;
        for(let k=0;k<this.bins;k++){
          const m=this.mag[k];
          if(learn){
            this.noise[k]=this.noise[k]*.995+m*.005;
          }else if(!this.noiseReady){
            this.noise[k]=m;
          }else{
            const ratio=m/Math.max(this.noise[k],1e-8);
            const coeff=ratio<1.45?aFast:aSlow;
            this.noise[k]=coeff*this.noise[k]+(1-coeff)*Math.min(m,this.noise[k]*1.02+1e-8);
          }
          const n=this.noise[k]+1e-9;
          const threshold=n*Math.pow(10,thresholdDb/20);
          const snr=m/threshold;
          // Soft spectral gate: below threshold is suppressed progressively, not simply muted.
          let gate=1;
          if(snr<1){
            const x=Math.max(0,Math.min(1,1-snr));
            gate=1-x*x*(3-2*x);
          }
          // Strong transient flux temporarily protects the spectrum from over-processing.
          if(isTransient)gate=1-(1-gate)*(1-transientProtect*.88);
          // Stable tonal bins get slightly more protection unless the learned noise itself is tonal.
          if(k>1 && k<this.bins-2){
            const local=(this.mag[k-1]+this.mag[k]+this.mag[k+1])/3;
            const tonal=local>0?Math.min(1,Math.max(0,(this.mag[k]/local)-1))*.7:0;
            gate=1-(1-gate)*(1-tonal*tonalProtect);
          }
          const smoothFreq=smooth*.28;
          const neighbor=(this.prevMask[Math.max(0,k-1)]+this.prevMask[k]+this.prevMask[Math.min(this.bins-1,k+1)])/3;
          gate=gate*(1-smoothFreq)+neighbor*smoothFreq;
          const temporal=smooth*.45;
          gate=gate*(1-temporal)+this.prevMask[k]*temporal;
          const attenuationDb=Math.min(maxReduction,Math.max(0,-20*Math.log10(Math.max(gate,1e-4))));
          const finalAtt=attenuationDb*amount;
          const gainDb=-finalAtt;
          const gain=Math.pow(10,gainDb/20);
          this.mask[k]=gain;this.prevMask[k]=gate;
        }
        // Apply the same mask to each stereo channel and overlap-add.
        const outL=new Float32Array(this.H),outR=new Float32Array(this.H);
        // Reuse re/im for each channel.
        for(let ch=0;ch<2;ch++){
          const src=ch===0?monoL:monoR;
          for(let n=0;n<this.N;n++){this.re[n]=src[n];this.im[n]=0;}
          this.fft(this.re,this.im,false);
          for(let k=0;k<this.bins;k++){
            const g=this.mask[k]; this.re[k]*=g;this.im[k]*=g;
            if(k>0&&k<this.N-k){this.re[this.N-k]*=g;this.im[this.N-k]*=g;}
          }
          this.fft(this.re,this.im,true);
          for(let n=0;n<this.N;n++){
            const v=this.re[n]*this.win[n]/0.5;
            if(ch===0)outL[n%this.H]+=v; else outR[n%this.H]+=v;
          }
        }
        this.queuePush(outL,outR);this.prevMag.set(this.mag);this.frames++;
        if(this.frames>3)this.noiseReady=true;
        if(learn && this.frames>24){this.noiseReady=true;}
      }
    }
    if(amount<0.0001){
      // Still keep the latency/graph stable, but pass audio unprocessed when at 0%.
      for(let i=0;i<frames;i++){output[0][i]=input[0][i];if(output.length>1)output[1][i]=channels>1?input[1][i]:input[0][i];}
      return true;
    }
    this.queuePop(output,frames);
    return true;
  }
}
registerProcessor('myefx-denoise',MyEFXDenoiseProcessor);

class MyEFXDenoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(){
    return [
      {name:'amount',defaultValue:0,minValue:0,maxValue:100,automationRate:'k-rate'},
      {name:'threshold',defaultValue:0,minValue:-24,maxValue:24,automationRate:'k-rate'},
      {name:'reduction',defaultValue:12,minValue:0,maxValue:30,automationRate:'k-rate'},
      {name:'attack',defaultValue:10,minValue:1,maxValue:100,automationRate:'k-rate'},
      {name:'release',defaultValue:120,minValue:20,maxValue:500,automationRate:'k-rate'},
      {name:'adaptive',defaultValue:1,minValue:0,maxValue:1,automationRate:'k-rate'},
      {name:'optimize',defaultValue:0,minValue:0,maxValue:1,automationRate:'k-rate'},
      {name:'filterType',defaultValue:0,minValue:0,maxValue:1,automationRate:'k-rate'},
      {name:'noiseType',defaultValue:0,minValue:0,maxValue:1,automationRate:'k-rate'},
      {name:'adaptationTime',defaultValue:1,minValue:0.1,maxValue:4,automationRate:'k-rate'},
      {name:'softKnee',defaultValue:25,minValue:0,maxValue:100,automationRate:'k-rate'},
      {name:'maxAttenuation',defaultValue:30,minValue:0,maxValue:48,automationRate:'k-rate'},
      {name:'dynamicProfile',defaultValue:1,minValue:0,maxValue:1,automationRate:'k-rate'},
      {name:'learn',defaultValue:0,minValue:0,maxValue:1,automationRate:'k-rate'}
    ];
  }
  constructor(){
    super();
    this.noise=1e-4;
    this.level=1e-4;
    this.rms=1e-4;
    this.gain=1;
    this.profile=1e-4;
    this.learnFrames=0;
    this.holdProfile=false;
    this.noiseCoeff=sampleRate>0?Math.exp(-1/(1.0*sampleRate)):0.999;
    this.levelCoeff=sampleRate>0?Math.exp(-1/(0.012*sampleRate)):0.999;
    this.rmsCoeff=sampleRate>0?Math.exp(-1/(0.040*sampleRate)):0.999;
  }
  process(inputs,outputs,parameters){
    const input=inputs[0],output=outputs[0];
    if(!input.length)return true;
    const channels=Math.min(input.length,output.length);
    const amount=(parameters.amount?.[0]??0)/100;
    const thresholdOffset=parameters.threshold?.[0]??0;
    const reduction=Math.max(0,parameters.reduction?.[0]??12);
    const attackMs=Math.max(1,parameters.attack?.[0]??10);
    const releaseMs=Math.max(20,parameters.release?.[0]??120);
    const adaptive=(parameters.adaptive?.[0]??1)>0.5;
    const optimize=(parameters.optimize?.[0]??0)>0.5;
    const filterType=(parameters.filterType?.[0]??0)>0.5;
    const noiseType=(parameters.noiseType?.[0]??0)>0.5;
    const adaptTime=Math.max(.1,parameters.adaptationTime?.[0]??1);
    const knee=Math.max(0,Math.min(100,parameters.softKnee?.[0]??25))/100;
    const maxAtt=Math.max(0,parameters.maxAttenuation?.[0]??30);
    const dynamic=(parameters.dynamicProfile?.[0]??1)>0.5;
    const learn=(parameters.learn?.[0]??0)>0.5;

    const learnCoeff=Math.exp(-1/(0.75*sampleRate));
    const adapFast=Math.exp(-1/((adaptTime*.35)*sampleRate));
    const adapSlow=Math.exp(-1/((adaptTime*1.4)*sampleRate));
    const profileCoeff=dynamic?(optimize?adapFast:adapSlow):this.noiseCoeff;
    const attackCoeff=Math.exp(-1/((attackMs/1000)*sampleRate));
    const releaseCoeff=Math.exp(-1/((releaseMs/1000)*sampleRate));

    for(let i=0;i<input[0].length;i++){
      let peak=0,sum=0;
      for(let ch=0;ch<channels;ch++){
        const v=input[ch][i]; const a=Math.abs(v); peak=Math.max(peak,a); sum+=v*v;
      }
      const rmsNow=Math.sqrt(sum/Math.max(1,channels));
      this.level=this.levelCoeff*this.level+(1-this.levelCoeff)*peak;
      this.rms=this.rmsCoeff*this.rms+(1-this.rmsCoeff)*rmsNow;

      if(learn){
        this.profile=learnCoeff*this.profile+(1-learnCoeff)*Math.max(rmsNow,1e-7);
        this.noise=this.profile;
        this.holdProfile=true;
        this.learnFrames++;
      }else if(adaptive){
        const compare=Math.max(this.noise*1.8,this.rms*1.05);
        if(peak<compare){
          this.noise=profileCoeff*this.noise+(1-profileCoeff)*Math.max(rmsNow,1e-7);
        }else if(dynamic){
          this.noise=profileCoeff*this.noise+(1-profileCoeff)*Math.min(Math.max(rmsNow*.72,1e-7),this.noise*1.02+1e-7);
        }
      }else if(this.holdProfile){
        this.noise=this.profile;
      }

      const noiseDb=20*Math.log10(Math.max(this.noise,1e-7));
      const signalDb=20*Math.log10(Math.max(this.rms,1e-7));
      const modeOffset=optimize?1.5:-1.0;
      const filterOffset=filterType?2.0:0.0;
      const tonalOffset=noiseType?1.0:0.0;
      const thresholdDb=noiseDb+thresholdOffset+modeOffset+filterOffset+tonalOffset;
      const distance=thresholdDb-signalDb;
      const kneeWidth=2+knee*16;
      let amountBelow;
      if(kneeWidth>0){
        if(distance<=-kneeWidth/2)amountBelow=0;
        else if(distance>=kneeWidth/2)amountBelow=1;
        else{const t=(distance/kneeWidth)+.5;amountBelow=t*t*(3-2*t)}
      }else amountBelow=distance>0?1:0;
      // Gentle is more conservative; Surgical reaches the requested reduction more readily.
      const style=filterType?1.08:.82;
      const capped=Math.min(maxAtt,reduction)*style;
      const attenuationDb=Math.max(0,Math.min(maxAtt,capped*amountBelow*amount));
      const targetGain=Math.pow(10,-attenuationDb/20);
      const coeff=targetGain<this.gain?attackCoeff:releaseCoeff;
      this.gain=coeff*this.gain+(1-coeff)*targetGain;

      // Music mode is deliberately slower around sustained material to avoid flattening note tails.
      let programGain=this.gain;
      if(optimize && this.level>this.noise*2.5) programGain=1-(1-programGain)*.72;
      const outputGain=1-amount+amount*programGain;
      for(let ch=0;ch<channels;ch++)output[ch][i]=input[ch][i]*outputGain;
      for(let ch=channels;ch<output.length;ch++)output[ch][i]=input[0][i]*outputGain;
    }
    return true;
  }
}
registerProcessor('myefx-denoise',MyEFXDenoiseProcessor);

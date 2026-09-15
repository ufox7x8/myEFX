class MyEFXDenoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(){
    return [
      {name:'amount',defaultValue:0,minValue:0,maxValue:100,automationRate:'k-rate'},
      {name:'threshold',defaultValue:0,minValue:-24,maxValue:24,automationRate:'k-rate'},
      {name:'reduction',defaultValue:0,minValue:0,maxValue:30,automationRate:'k-rate'},
      {name:'attack',defaultValue:10,minValue:1,maxValue:100,automationRate:'k-rate'},
      {name:'release',defaultValue:120,minValue:20,maxValue:500,automationRate:'k-rate'},
      {name:'adaptive',defaultValue:1,minValue:0,maxValue:1,automationRate:'k-rate'}
    ];
  }
  constructor(){
    super();
    this.noise=1e-4;
    this.level=1e-4;
    this.gain=1;
    this.ready=0;
    this.noiseAttack=Math.exp(-1/(0.08*sampleRate));
    this.noiseRelease=Math.exp(-1/(1.8*sampleRate));
    this.levelCoeff=Math.exp(-1/(0.012*sampleRate));
  }
  process(inputs,outputs,parameters){
    const input=inputs[0],output=outputs[0];
    if(!input.length)return true;
    const channels=Math.min(input.length,output.length);
    const amount=(parameters.amount?.[0]??0)/100;
    const thresholdOffset=parameters.threshold?.[0]??0;
    const maxReduction=parameters.reduction?.[0]??0;
    const attackMs=parameters.attack?.[0]??10;
    const releaseMs=parameters.release?.[0]??120;
    const adaptive=(parameters.adaptive?.[0]??1)>0.5;
    const gainAttack=Math.exp(-1/((attackMs/1000)*sampleRate));
    const gainRelease=Math.exp(-1/((releaseMs/1000)*sampleRate));
    for(let i=0;i<input[0].length;i++){
      let peak=0;
      for(let ch=0;ch<channels;ch++)peak=Math.max(peak,Math.abs(input[ch][i]));
      this.level=this.levelCoeff*this.level+(1-this.levelCoeff)*peak;
      const lvl=Math.max(this.level,1e-7);
      if(adaptive){
        if(peak<Math.max(this.noise*2,lvl*1.15)) this.noise=this.noiseAttack*this.noise+(1-this.noiseAttack)*Math.max(peak,1e-7);
        else this.noise=this.noiseRelease*this.noise+(1-this.noiseRelease)*Math.min(peak,this.noise*1.03+1e-7);
      }
      const noiseDb=20*Math.log10(Math.max(this.noise,1e-7));
      const signalDb=20*Math.log10(Math.max(lvl,1e-7));
      const thresholdDb=noiseDb+thresholdOffset+(amount*7.5);
      const below=Math.max(0,Math.min(1,(thresholdDb-signalDb+6)/18));
      const attenuationDb=Math.min(maxReduction, maxReduction*below*below);
      let targetGain=Math.pow(10,-attenuationDb/20);
      if(amount<=0.0001)targetGain=1;
      const coeff=targetGain<this.gain?gainAttack:gainRelease;
      this.gain=coeff*this.gain+(1-coeff)*targetGain;
      const outputGain=1-amount+amount*this.gain;
      for(let ch=0;ch<channels;ch++)output[ch][i]=input[ch][i]*outputGain;
      for(let ch=channels;ch<output.length;ch++)output[ch][i]=input[0][i]*outputGain;
    }
    if(!this.ready){this.ready=1;this.noise=Math.max(this.noise,1e-5)}
    return true;
  }
}
registerProcessor('myefx-denoise',MyEFXDenoiseProcessor);

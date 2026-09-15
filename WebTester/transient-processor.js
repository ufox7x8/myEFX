class MyEFXTransientProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(){
    return [
      {name:'attack',defaultValue:0,minValue:-100,maxValue:100,automationRate:'k-rate'},
      {name:'sustain',defaultValue:0,minValue:-100,maxValue:100,automationRate:'k-rate'}
    ];
  }
  constructor(){
    super();
    this.fast=0;
    this.slow=0;
    this.fastCoeff=Math.exp(-1/(0.006*sampleRate));
    this.slowCoeff=Math.exp(-1/(0.060*sampleRate));
  }
  process(inputs,outputs,parameters){
    const input=inputs[0],output=outputs[0];
    if(!input.length)return true;
    const attack=parameters.attack.length?parameters.attack[0]:0;
    const sustain=parameters.sustain.length?parameters.sustain[0]:0;
    const attackAmt=attack/100;
    const sustainAmt=sustain/100;
    const channels=Math.min(input.length,output.length);
    for(let i=0;i<input[0].length;i++){
      let peak=0;
      for(let ch=0;ch<channels;ch++)peak=Math.max(peak,Math.abs(input[ch][i]));
      this.fast=this.fastCoeff*this.fast+(1-this.fastCoeff)*peak;
      this.slow=this.slowCoeff*this.slow+(1-this.slowCoeff)*peak;
      const base=Math.max(this.slow,1e-5);
      const transient=Math.max(0,Math.min(1,(this.fast/base)-1));
      const body=Math.max(0,Math.min(1,1-transient));
      const tGain=Math.pow(2,attackAmt*1.15*transient);
      const sGain=Math.pow(2,sustainAmt*0.90*body);
      const gain=tGain*sGain;
      for(let ch=0;ch<channels;ch++)output[ch][i]=input[ch][i]*gain;
      for(let ch=channels;ch<output.length;ch++)output[ch][i]=input[0][i]*gain;
    }
    return true;
  }
}
registerProcessor('myefx-transient',MyEFXTransientProcessor);

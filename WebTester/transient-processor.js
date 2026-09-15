class MyEFXTransientProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(){return[
    {name:'punch',defaultValue:0,minValue:-100,maxValue:100,automationRate:'k-rate'},
    {name:'sustain',defaultValue:0,minValue:-100,maxValue:100,automationRate:'k-rate'}
  ];}
  constructor(){super();this.fast=0;this.slow=0;this.med=0;this.fastCoeff=Math.exp(-1/(0.0045*sampleRate));this.slowCoeff=Math.exp(-1/(0.075*sampleRate));this.medCoeff=Math.exp(-1/(0.020*sampleRate));}
  process(inputs,outputs,parameters){const input=inputs[0],output=outputs[0];if(!input.length)return true;const frames=input[0].length,ch=input.length,punch=(parameters.punch?.[0]??0)/100,sustain=(parameters.sustain?.[0]??0)/100;for(let i=0;i<frames;i++){let peak=0;for(let c=0;c<ch;c++)peak=Math.max(peak,Math.abs(input[c][i]));this.fast=this.fastCoeff*this.fast+(1-this.fastCoeff)*peak;this.med=this.medCoeff*this.med+(1-this.medCoeff)*peak;this.slow=this.slowCoeff*this.slow+(1-this.slowCoeff)*peak;const floor=Math.max(this.slow,1e-5);const transient=Math.max(0,Math.min(1,(this.fast/floor)-1));const body=Math.max(0,Math.min(1,(this.med/floor)-.15));const pGain=Math.pow(2,punch*1.0*transient);const sGain=Math.pow(2,sustain*.75*body);const gain=Math.min(3,Math.max(.2,pGain*sGain));for(let c=0;c<Math.min(ch,output.length);c++)output[c][i]=input[c][i]*gain;for(let c=ch;c<output.length;c++)output[c][i]=input[0][i]*gain;}return true;}
}
registerProcessor('myefx-transient',MyEFXTransientProcessor);

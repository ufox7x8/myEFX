class MyEFXTransientProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'punch', defaultValue: 0, minValue: -100, maxValue: 100, automationRate: 'k-rate' },
      { name: 'sustain', defaultValue: 0, minValue: -100, maxValue: 100, automationRate: 'k-rate' }
    ];
  }
  constructor() {
    super();
    this.fast = 0;
    this.slow = 0;
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input.length) return true;
    const frames = input[0].length;
    const ch = Math.min(input.length, output.length);
    const punch = (parameters.punch?.[0] ?? 0) / 100;
    const sustain = (parameters.sustain?.[0] ?? 0) / 100;
    const absP = Math.abs(punch), absS = Math.abs(sustain);
    const externalMix = Math.min(1, (absP + absS) * 0.625);
    const attackScale = externalMix > 0 ? punch * 0.5 / externalMix : 0;
    const sustainScale = externalMix > 0 ? sustain * 0.5 / externalMix : 0;
    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let c = 0; c < ch; c++) peak = Math.max(peak, Math.abs(input[c][i]));
      this.fast = (this.fast * 3 + peak) * 0.25;
      this.slow = (this.slow * 7 + peak) * 0.125;
      for (let c = 0; c < output.length; c++) {
        const x = input[Math.min(c, input.length - 1)][i];
        const sign = x < 0 ? -1 : 1;
        const boost = sign * (this.fast * attackScale + this.slow * sustainScale);
        output[c][i] = x + boost;
      }
    }
    return true;
  }
}
registerProcessor('myefx-transient', MyEFXTransientProcessor);

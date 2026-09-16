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
    this.bandFreq = 1000;
    this.bandQ = 1;
    this.port.onmessage = e => {
      const d = e.data || {};
      if (d.type === 'band') {
        if (Number.isFinite(d.freq)) this.bandFreq = d.freq;
        if (Number.isFinite(d.q)) this.bandQ = d.q;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;
    const channels = Math.min(input.length, output.length);
    const frames = output[0].length;
    const punch = (parameters.punch?.[0] ?? 0) / 100;
    const sustain = (parameters.sustain?.[0] ?? 0) / 100;

    if (Math.abs(punch) < 0.0001 && Math.abs(sustain) < 0.0001) {
      for (let c = 0; c < channels; c++) output[c].set(input[c]);
      return true;
    }

    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let c = 0; c < channels; c++) peak = Math.max(peak, Math.abs(input[c][i]));
      this.fast += (peak - this.fast) * 0.28;
      this.slow += (peak - this.slow) * 0.018;

      const transient = Math.max(0, this.fast - this.slow);
      const transientRatio = Math.max(0, Math.min(1, transient / Math.max(this.fast, 1e-5)));
      const sustainRatio = Math.max(0, Math.min(1, this.slow / Math.max(this.fast, 1e-5)));
      const punchMul = 1 + punch * 0.85 * transientRatio;
      const sustainMul = 1 + sustain * 0.45 * sustainRatio;
      const mul = Math.max(0.05, Math.min(2.25, punchMul * sustainMul));

      for (let c = 0; c < channels; c++) output[c][i] = input[c][i] * mul;
    }
    return true;
  }
}
registerProcessor('myefx-transient', MyEFXTransientProcessor);

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
    this.env = 0;
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
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        const x = input[c][i];
        peak = Math.max(peak, Math.abs(x));
        sum += x;
      }
      const mono = sum / Math.max(1, channels);
      this.fast += (peak - this.fast) * 0.28;
      this.slow += (peak - this.slow) * 0.018;
      const transient = Math.max(0, this.fast - this.slow);
      const denom = Math.max(this.fast, 1e-5);
      const attackShape = Math.max(0, Math.min(1, transient / denom));
      this.env += ((attackShape + this.slow * 0.8) - this.env) * 0.05;
      const sustainShape = Math.max(0, Math.min(1, this.slow / Math.max(this.fast + 1e-5, 1e-5)));

      // Conservative ranges keep the shaper from becoming a gain stage.
      const pMul = 1 + punch * 0.85 * attackShape;
      const sMul = 1 + sustain * 0.45 * sustainShape;
      const mul = Math.max(0.05, Math.min(2.25, pMul * sMul));

      for (let c = 0; c < channels; c++) {
        const x = input[c][i];
        const shaped = x * mul;
        // Mild safety soft-clip only when boost requests exceed unity substantially.
        output[c][i] = Math.tanh(shaped) / Math.tanh(1);
      }
    }
    return true;
  }
}
registerProcessor('myefx-transient', MyEFXTransientProcessor);

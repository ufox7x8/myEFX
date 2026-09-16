class MyEFXDenoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'amount', defaultValue: 0, minValue: 0, maxValue: 100, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.freq = 1000;
    this.q = 1;
    this.fast = 0;
    this.slow = 0;
    this.noise = 1e-5;
    this.gain = 1;
    this.open = true;
    this.port.onmessage = e => {
      const d = e.data || {};
      if (d.type === 'band') {
        if (Number.isFinite(d.freq)) this.freq = d.freq;
        if (Number.isFinite(d.q)) this.q = d.q;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;
    const ch = Math.min(input.length, output.length);
    const n = output[0].length;
    const amount = Math.max(0, Math.min(100, parameters.amount?.[0] ?? 0)) / 100;

    if (amount <= 0.0001) {
      for (let c = 0; c < ch; c++) output[c].set(input[c]);
      return true;
    }

    const maxReductionDb = 18 * amount;
    const minGain = Math.pow(10, -maxReductionDb / 20);
    const openThreshold = 2.15;
    const closeThreshold = 1.65;
    const attack = 0.28;
    const release = 0.065;
    const noiseAttack = 0.004;
    const noiseRelease = 0.02;

    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < ch; c++) peak = Math.max(peak, Math.abs(input[c][i]));
      this.fast += (peak - this.fast) * 0.24;
      this.slow += (peak - this.slow) * 0.018;

      const quiet = this.fast <= this.slow * 1.15;
      const nr = quiet ? noiseRelease : noiseAttack;
      this.noise += (this.fast - this.noise) * nr;
      this.noise = Math.max(1e-7, this.noise);

      const snr = this.fast / this.noise;
      if (this.open) {
        if (snr < closeThreshold) this.open = false;
      } else if (snr > openThreshold) {
        this.open = true;
      }

      const x = Math.log10(Math.max(snr, 1e-6));
      const lo = Math.log10(closeThreshold);
      const hi = Math.log10(openThreshold);
      let presence = (x - lo) / Math.max(1e-6, hi - lo);
      presence = Math.max(0, Math.min(1, presence));
      presence = presence * presence * (3 - 2 * presence);
      if (!this.open) presence *= 0.35;

      const reductionDb = maxReductionDb * (1 - presence);
      const target = Math.pow(10, -reductionDb / 20);
      const rate = target < this.gain ? attack : release;
      this.gain += (target - this.gain) * rate;
      this.gain = Math.max(minGain, Math.min(1, this.gain));

      for (let c = 0; c < ch; c++) output[c][i] = input[c][i] * this.gain;
    }
    return true;
  }
}
registerProcessor('myefx-denoise', MyEFXDenoiseProcessor);

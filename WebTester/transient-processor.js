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
    this.coeff = null;
    this.z1 = [];
    this.z2 = [];
    this.y1 = [];
    this.y2 = [];
    this.port.onmessage = e => {
      const d = e.data || {};
      if (d.type === 'band') {
        this.bandFreq = Number.isFinite(d.freq) ? d.freq : this.bandFreq;
        this.bandQ = Number.isFinite(d.q) ? d.q : this.bandQ;
        this.coeff = null;
      }
    };
  }

  ensureCoeff() {
    const f = Math.max(20, Math.min(sampleRate * 0.45, this.bandFreq));
    const q = Math.max(0.25, Math.min(18, this.bandQ));
    const w0 = 2 * Math.PI * f / sampleRate;
    const cs = Math.cos(w0), sn = Math.sin(w0);
    const alpha = sn / (2 * q);
    const a0 = 1 + alpha;
    this.coeff = {
      b0: alpha / a0,
      b1: 0,
      b2: -alpha / a0,
      a1: (-2 * cs) / a0,
      a2: (1 - alpha) / a0
    };
  }

  filterBoost(x, c) {
    if (!this.coeff) this.ensureCoeff();
    const k = this.coeff;
    const y = k.b0 * x + k.b1 * this.z1[c] + k.b2 * this.z2[c] - k.a1 * this.y1[c] - k.a2 * this.y2[c];
    this.z2[c] = this.z1[c];
    this.z1[c] = x;
    this.y2[c] = this.y1[c];
    this.y1[c] = y;
    return y;
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

    while (this.z1.length < output.length) {
      this.z1.push(0); this.z2.push(0); this.y1.push(0); this.y2.push(0);
    }

    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let c = 0; c < ch; c++) peak = Math.max(peak, Math.abs(input[c][i]));

      // Exact mark-renker dual-envelope recurrences.
      this.fast = (this.fast * 3 + peak) * 0.25;
      this.slow = (this.slow * 7 + peak) * 0.125;

      for (let c = 0; c < output.length; c++) {
        const x = input[Math.min(c, input.length - 1)][i];
        const sign = x < 0 ? -1 : 1;
        const boost = sign * (this.fast * attackScale + this.slow * sustainScale);
        // Preserve the original signal exactly. Only the envelope-derived addition
        // is band-limited, preventing transient processing from creating cross-band
        // DELTA leakage or changing the existing routing topology.
        output[c][i] = x + this.filterBoost(boost, c);
      }
    }
    return true;
  }
}
registerProcessor('myefx-transient', MyEFXTransientProcessor);

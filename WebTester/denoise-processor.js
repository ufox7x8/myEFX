class MyEFXDenoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'amount', defaultValue: 0, minValue: 0, maxValue: 100, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    // denoize HiFi-inspired realtime profile: large FFT + high overlap.
    this.N = 4096;
    this.H = 512;
    this.B = this.N / 2 + 1;
    this.win = new Float32Array(this.N);
    this.re = new Float32Array(this.N); this.im = new Float32Array(this.N);
    this.tmpReL = new Float32Array(this.N); this.tmpImL = new Float32Array(this.N);
    this.tmpReR = new Float32Array(this.N); this.tmpImR = new Float32Array(this.N);
    this.ringL = new Float32Array(this.N); this.ringR = new Float32Array(this.N);
    this.olaL = new Float32Array(this.N); this.olaR = new Float32Array(this.N);
    this.olaNorm = new Float32Array(this.N);
    this.emitL = new Float32Array(this.H); this.emitR = new Float32Array(this.H);
    this.queueSize = 131072; this.queueL = new Float32Array(this.queueSize); this.queueR = new Float32Array(this.queueSize);
    this.qRead = 0; this.qWrite = 0; this.ringPos = 0; this.samples = 0;

    // Per-bin IMCRA/MCRA-style state.
    this.s = new Float32Array(this.B);
    this.sMin = new Float32Array(this.B);
    this.sTmp = new Float32Array(this.B);
    this.lambda = new Float32Array(this.B);
    this.spp = new Float32Array(this.B);
    this.xi = new Float32Array(this.B);
    this.prevGain = new Float32Array(this.B);
    this.prevPower = new Float32Array(this.B);
    this.prevFlux = new Float32Array(this.B);
    this.initialized = false;
    this.minFrames = 140;
    this.minAge = new Uint16Array(this.B);
    this.noiseProfile = new Float32Array(this.B);
    this.hasProfile = false;
    this.profileInitFrames = 18;
    this.profileCount = 0;
    this.frameIndex = 0;
    this.binToBark = new Uint8Array(this.B);

    // Music/high-fidelity parameters adapted from denoize's HiFi concepts.
    this.alphaS = 0.90;
    this.alphaD = 0.95;
    this.ddAlpha = 0.98;
    this.gMin = Math.pow(10, -25 / 20);
    this.zeta0 = 2.0;
    this.sigma = 0.25;
    this.attack = 0.45;
    this.release = 0.075;
    this.transientFloor = 0.12;
    this.cepCut = 28;

    // Kaiser beta ~= 10, matching the reference project's HiFi preset.
    const beta = 10;
    const denom = this.i0(beta);
    for (let n = 0; n < this.N; n++) {
      const x = 2 * n / (this.N - 1) - 1;
      this.win[n] = this.i0(beta * Math.sqrt(Math.max(0, 1 - x * x))) / denom;
      this.olaNorm[n] = 0;
    }

    for (let k = 0; k < this.B; k++) {
      this.s[k] = 1e-12; this.sMin[k] = 1e-12; this.sTmp[k] = 1e-12;
      this.lambda[k] = 1e-10; this.spp[k] = 0; this.xi[k] = 0;
      this.prevGain[k] = 1; this.prevPower[k] = 1e-12; this.prevFlux[k] = 0;
      this.minAge[k] = 0;
      this.binToBark[k] = this.barkBand(k * sampleRate / this.N);
    }

    // Perfect-reconstruction normalization for the chosen window/hop.
    for (let n = 0; n < this.N; n++) {
      let sum = 0;
      for (let p = n % this.H; p < this.N; p += this.H) sum += this.win[p] * this.win[p];
      this.olaNorm[n] = Math.max(sum, 1e-9);
    }
  }

  i0(x) {
    let sum = 1, y = 1, t = x * x / 4;
    for (let k = 1; k < 28; k++) {
      y *= t / (k * k); sum += y;
      if (y < 1e-12 * sum) break;
    }
    return sum;
  }

  clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  barkBand(f) {
    const z = 13 * Math.atan(0.00076 * f) + 3.5 * Math.atan(Math.pow(f / 7500, 2));
    return this.clamp(Math.floor(z), 0, 23);
  }

  fft(re, im, inverse = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = (inverse ? 2 : -2) * Math.PI / len, wc = Math.cos(a), ws = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let wr = 1, wi = 0, half = len >> 1;
        for (let j = 0; j < half; j++) {
          const x = i + j, y = x + half;
          const vr = re[y] * wr - im[y] * wi, vi = re[y] * wi + im[y] * wr;
          re[y] = re[x] - vr; im[y] = im[x] - vi; re[x] += vr; im[x] += vi;
          const tr = wr * wc - wi * ws; wi = wr * ws + wi * wc; wr = tr;
        }
      }
    }
    if (inverse) { const s = 1 / n; for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; } }
  }

  exp1(x) {
    x = Math.max(x, 1e-10);
    if (x < 1) {
      const gamma = 0.5772156649015329;
      let term = 1, sum = 0;
      for (let k = 1; k < 40; k++) { term *= -x / k; sum += term / k; }
      return -gamma - Math.log(x) - sum;
    }
    let b = x + 1, c = 1e30, d = 1 / b, h = d;
    for (let i = 1; i < 100; i++) {
      const a = -i * i, an = a * d;
      b += 2; d = 1 / (b + an); c = b + an / c; const del = c * d; h *= del;
      if (Math.abs(del - 1) < 1e-7) break;
    }
    return Math.exp(-x) * h;
  }

  noiseUpdate(power) {
    if (!this.initialized) {
      for (let k = 0; k < this.B; k++) {
        const v = Math.max(power[k], 1e-12);
        this.s[k] = v; this.sMin[k] = v; this.sTmp[k] = v; this.lambda[k] = v;
      }
      this.initialized = true; this.profileCount = 1; return;
    }

    const hasProfile = this.hasProfile;
    for (let k = 0; k < this.B; k++) {
      const p = Math.max(power[k], 1e-12);
      this.s[k] = this.alphaS * this.s[k] + (1 - this.alphaS) * p;
      const fastRise = hasProfile ? 1.0005 : 1.010;
      const slowRise = 1.00006;
      const f = this.sMin[k] * fastRise;
      this.sMin[k] = this.s[k] < f ? this.s[k] : f;
      const g = this.sTmp[k] * slowRise;
      this.sTmp[k] = this.s[k] < g ? this.s[k] : g;
      if (hasProfile) {
        const cap = this.noiseProfile[k] * 3.16;
        if (this.sMin[k] > cap) this.sMin[k] = cap;
        if (this.sTmp[k] > cap) this.sTmp[k] = cap;
      }

      const zeta = this.s[k] / Math.max(1e-12, 2 * this.sMin[k]);
      const arg = (zeta - this.zeta0) / this.sigma;
      let pp = arg >= 0 ? 1 / (1 + Math.exp(-arg)) : Math.exp(arg) / (1 + Math.exp(arg));
      this.spp[k] = pp;

      const old = Math.max(1e-12, this.lambda[k]);
      const aEff = this.alphaD + (1 - this.alphaD) * pp;
      let next = aEff * old + (1 - aEff) * p;
      const upCap = old * Math.pow(10, 6 * this.H / sampleRate / 10);
      if (next > upCap) next = upCap;
      if (hasProfile) next = Math.min(next, this.noiseProfile[k] * 31.6);
      this.lambda[k] = Math.max(1e-12, next);

      if (!hasProfile && this.profileCount < this.profileInitFrames && pp < 0.2) {
        this.noiseProfile[k] += p;
      }
    }

    if (!this.hasProfile && this.profileCount >= this.profileInitFrames) {
      const scale = 1 / Math.max(1, this.profileCount);
      for (let k = 0; k < this.B; k++) this.noiseProfile[k] *= scale;
      this.hasProfile = true;
    }
    this.profileCount++;
  }

  smoothGainCepstral(g) {
    for (let k = 0; k < this.B; k++) { this.re[k] = Math.log(Math.max(this.gMin, g[k])); this.im[k] = 0; }
    // Mirror the one-sided log-gain into a full real spectrum.
    for (let k = 1; k < this.B - 1; k++) { this.re[this.N - k] = this.re[k]; this.im[this.N - k] = 0; }
    this.fft(this.re, this.im, true);
    for (let k = this.cepCut; k < this.N - this.cepCut; k++) { this.re[k] = 0; this.im[k] = 0; }
    this.fft(this.re, this.im, false);
    for (let k = 0; k < this.B; k++) g[k] = Math.exp(this.re[k]);
  }

  perceptual(g, amount) {
    // Bark weighting adapted from the reference: speech core is preserved more gently,
    // low/high bands permit more suppression.
    for (let k = 1; k < this.B; k++) {
      const b = this.binToBark[k];
      let w = (b <= 1) ? 0.78 : (b <= 12 ? 1.0 : (b <= 17 ? 0.9 : 0.75));
      const wMin = 0.4 + 0.2 * (1 - amount);
      w = wMin + (1 - wMin) * w;
      g[k] = this.gMin + (g[k] - this.gMin) * w;
    }
  }

  musicalPostFilter(power, gain) {
    for (let k = 2; k < this.B - 2; k++) {
      const snr = power[k] / Math.max(this.lambda[k], 1e-12);
      if (snr < 4) continue;
      const neigh = 0.25 * (power[k - 1] + power[k + 1] + power[k - 2] + power[k + 2]);
      const peak = Math.max(0, Math.log(Math.max(1e-12, power[k] / Math.max(neigh, 1e-12))));
      const gLocal = 0.5 * (gain[k - 1] + gain[k + 1]);
      const dip = Math.max(0, gLocal - gain[k]);
      const mask = this.clamp(0.28 * peak + 2.2 * dip, 0, 1);
      if (mask > 0.15) gain[k] = gain[k] * (1 - 0.30 * mask) + gLocal * (0.30 * mask);
    }
  }

  analyseChannel(frame, amount) {
    for (let n = 0; n < this.N; n++) {
      const idx = (this.ringPos + n) % this.N;
      this.re[n] = frame[idx] * this.win[n]; this.im[n] = 0;
    }
    this.fft(this.re, this.im);
    const power = new Float32Array(this.B);
    for (let k = 0; k < this.B; k++) power[k] = this.re[k] * this.re[k] + this.im[k] * this.im[k] + 1e-12;
    return power;
  }

  buildGain(power, amount) {
    this.noiseUpdate(power);
    const gain = new Float32Array(this.B);
    for (let k = 0; k < this.B; k++) {
      const gamma = power[k] / Math.max(this.lambda[k], 1e-12);
      const xiInst = Math.max(gamma - 1, 0);
      const xi = this.ddAlpha * this.prevGain[k] * this.prevGain[k] * this.prevGamma?.[k] + (1 - this.ddAlpha) * xiInst;
      if (!this.prevGamma) this.prevGamma = new Float32Array(this.B);
      this.xi[k] = Math.max(1e-12, xi || xiInst);
      const nu = Math.max(1e-12, this.xi[k] * gamma / (1 + this.xi[k]));
      const rawLog = (this.xi[k] / (1 + this.xi[k])) * Math.exp(0.5 * this.exp1(nu));
      let gLog = this.clamp(rawLog, this.gMin, 1);
      // OMLSA blend using speech-presence probability.
      let g = Math.pow(Math.max(gLog, 1e-6), this.spp[k]) * Math.pow(this.gMin, 1 - this.spp[k]);
      // Spectral-flux transient protection.
      const flux = 10 * Math.log10(power[k] / Math.max(this.prevPower[k], 1e-12));
      const protect = this.clamp((flux - 3) / 12, 0, 1);
      g = g + protect * this.transientFloor * (1 - g);
      // Attack/release smoothing.
      const prev = this.prevGain[k];
      const rate = g < prev ? this.attack : this.release;
      g = prev + (g - prev) * rate;
      gain[k] = this.clamp(g, this.gMin, 1);
    }
    this.perceptual(gain, amount);
    this.musicalPostFilter(power, gain);
    this.smoothGainCepstral(gain);
    for (let k = 0; k < this.B; k++) {
      this.prevGamma ??= new Float32Array(this.B);
      this.prevGamma[k] = power[k] / Math.max(this.lambda[k], 1e-12);
      this.prevPower[k] = power[k];
    }
    return gain;
  }

  processSpectral(frame, gain, outRe, outIm) {
    for (let n = 0; n < this.N; n++) { const idx = (this.ringPos + n) % this.N; outRe[n] = frame[idx] * this.win[n]; outIm[n] = 0; }
    this.fft(outRe, outIm);
    for (let k = 0; k < this.B; k++) {
      const g = 1 + (gain[k] - 1) * 1;
      outRe[k] *= g; outIm[k] *= g;
      if (k > 0 && k < this.B - 1) { const m = this.N - k; outRe[m] *= g; outIm[m] *= g; }
    }
    this.fft(outRe, outIm, true);
  }

  push(L, R) {
    for (let i = 0; i < this.H; i++) { const p = this.qWrite % this.queueSize; this.queueL[p] = L[i]; this.queueR[p] = R[i]; this.qWrite++; }
  }

  pop(output, frames) {
    for (let i = 0; i < frames; i++) {
      if (this.qRead < this.qWrite) { const p = this.qRead % this.queueSize; output[0][i] = this.queueL[p]; if (output.length > 1) output[1][i] = this.queueR[p]; this.qRead++; }
      else { output[0][i] = 0; if (output.length > 1) output[1][i] = 0; }
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!input.length || !input[0]?.length) return true;
    const frames = input[0].length, channels = input.length;
    const amount = this.clamp((parameters.amount?.[0] ?? 0) / 100, 0, 1);
    if (amount <= 0.0001) {
      for (let i = 0; i < frames; i++) { output[0][i] = input[0][i]; if (output.length > 1) output[1][i] = channels > 1 ? input[1][i] : input[0][i]; }
      return true;
    }

    for (let i = 0; i < frames; i++) {
      const l = input[0][i], r = channels > 1 ? input[1][i] : l;
      this.ringL[this.ringPos] = l; this.ringR[this.ringPos] = r; this.ringPos = (this.ringPos + 1) % this.N; this.samples++;
      if (this.samples >= this.N && ((this.samples - this.N) % this.H) === 0) {
        const power = this.analyseChannel(this.ringL, amount);
        const gain = this.buildGain(power, amount);
        // Recompute full processed L/R using the same gain state, preserving stereo image.
        this.processSpectral(this.ringL, gain, this.tmpReL, this.tmpImL);
        this.processSpectral(this.ringR, gain, this.tmpReR, this.tmpImR);
        const fullStrengthL = new Float32Array(this.N), fullStrengthR = new Float32Array(this.N);
        for (let n = 0; n < this.N; n++) { fullStrengthL[n] = this.tmpReL[n]; fullStrengthR[n] = this.tmpReR[n]; }
        for (let n = 0; n < this.N; n++) {
          const idx = (this.ringPos + n) % this.N;
          const dryL = this.ringL[idx] * this.win[n];
          const dryR = this.ringR[idx] * this.win[n];
          // Linear amount blend: 0%=dry, 100%=full reference processing.
          const wetL = dryL + amount * (fullStrengthL[n] - dryL);
          const wetR = dryR + amount * (fullStrengthR[n] - dryR);
          this.olaL[n] += wetL * this.win[n]; this.olaR[n] += wetR * this.win[n];
        }
        for (let n = 0; n < this.H; n++) { this.emitL[n] = this.olaL[n]; this.emitR[n] = this.olaR[n]; }
        this.olaL.copyWithin(0, this.H); this.olaR.copyWithin(0, this.H);
        this.olaL.fill(0, this.N - this.H); this.olaR.fill(0, this.N - this.H);
        const norm = 1 / 3.4;
        for (let n = 0; n < this.H; n++) { this.emitL[n] *= norm; this.emitR[n] *= norm; }
        this.push(this.emitL, this.emitR);
      }
    }
    this.pop(output, frames);
    return true;
  }
}

registerProcessor('myefx-denoise', MyEFXDenoiseProcessor);
